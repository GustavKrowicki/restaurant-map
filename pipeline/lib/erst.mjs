// Client for Erhvervsstyrelsen's CVR system-to-system distribution (Elasticsearch 6).
// Access is free but needs a username and password: email cvrselvbetjening@erst.dk.
// Docs: https://erhvervsstyrelsen.dk/kom-godt-igang-med-elasticSearch
import { fetchJson } from './util.mjs';

const BASE = process.env.CVR_ES_URL || 'http://distribution.virk.dk';
export const AARHUS_KOMMUNEKODE = 751;

function authHeaders() {
  const user = process.env.CVR_ES_USER;
  const pass = process.env.CVR_ES_PASSWORD;
  if (!user || !pass) throw new Error('CVR_ES_USER and CVR_ES_PASSWORD must be set for the ERST source');
  return {
    Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
    'Content-Type': 'application/json',
  };
}

/** Run a query with the scroll API and return every hit's _source. */
export async function searchAll(type, query, { pageSize = 500 } = {}) {
  const headers = authHeaders();
  let page = await fetchJson(
    `${BASE}/cvr-permanent/${type}/_search?scroll=2m`,
    { method: 'POST', headers, body: JSON.stringify({ size: pageSize, query }) },
    { label: `cvr ${type} search` },
  );
  const out = [];
  while (page.hits?.hits?.length) {
    out.push(...page.hits.hits.map((h) => h._source));
    if (!page._scroll_id || page.hits.hits.length < pageSize) break;
    page = await fetchJson(
      `${BASE}/_search/scroll`,
      { method: 'POST', headers, body: JSON.stringify({ scroll: '2m', scroll_id: page._scroll_id }) },
      { label: `cvr ${type} scroll` },
    );
  }
  return out;
}

// ---------- parsing helpers (the ERST documents are deeply nested and historised) ----------

const isCurrent = (periode) => !periode || periode.gyldigTil == null;

function latest(list = [], pick = (x) => x) {
  if (!list?.length) return null;
  const current = list.filter((x) => isCurrent(x.periode));
  const chosen = current.length ? current[current.length - 1] : list[list.length - 1];
  return pick(chosen);
}

/** Restaurant-type industry codes: DB07/DB25 groups 56.1 (restaurants) and 56.3 (bars). */
export function isRestaurantBranch(code) {
  const c = String(code || '');
  return c.startsWith('561') || c.startsWith('563');
}

export function parseUnit(src) {
  const p = src.VrproduktionsEnhed || src;
  const meta = p.produktionsEnhedMetadata || {};
  const addr = meta.nyesteBeliggenhedsadresse || {};
  const branch = meta.nyesteHovedbranche || {};
  const parent = latest(p.virksomhedsrelation, (r) => r);
  const life = p.livsforloeb?.length ? p.livsforloeb[p.livsforloeb.length - 1] : null;
  const active = life ? isCurrent(life.periode) : meta.sammensatStatus !== 'Ophørt';
  return {
    pNumber: String(p.pNummer),
    name: meta.nyesteNavn?.navn || latest(p.navne, (n) => n.navn) || '',
    cvr: parent && isCurrent(parent.periode) ? String(parent.cvrNummer) : null,
    street: addr.vejnavn || null,
    houseNumber: addr.husnummerFra != null ? `${addr.husnummerFra}${addr.bogstavFra || ''}` : null,
    postcode: addr.postnummer != null ? String(addr.postnummer) : null,
    city: addr.postdistrikt || null,
    kommune: addr.kommune?.kommuneKode ?? null,
    branchCode: branch.branchekode ? String(branch.branchekode) : null,
    branchText: branch.branchetekst || null,
    active,
  };
}

function currentAttr(medlemsData = [], type) {
  for (const md of medlemsData) {
    for (const attr of md.attributter || []) {
      if (attr.type !== type) continue;
      const v = latest(attr.vaerdier, (x) => x);
      if (v && isCurrent(v.periode)) return v.vaerdi;
    }
  }
  return undefined;
}

function hasCurrentMembership(medlemsData = []) {
  let sawPeriod = false;
  for (const md of medlemsData) {
    for (const attr of md.attributter || []) {
      for (const v of attr.vaerdier || []) {
        sawPeriod = true;
        if (isCurrent(v.periode)) return true;
      }
    }
  }
  return !sawPeriod;
}

export function parseShare(raw) {
  if (raw == null) return null;
  const n = parseFloat(String(raw).replace(',', '.'));
  if (Number.isNaN(n)) return null;
  return n > 1 ? n / 100 : n;
}

export function parseCompany(src) {
  const v = src.Vrvirksomhed || src;
  const meta = v.virksomhedMetadata || {};
  const owners = [];
  const managers = [];
  for (const rel of v.deltagerRelation || []) {
    const d = rel.deltager;
    if (!d) continue;
    const isPerson = d.enhedstype === 'PERSON';
    const party = {
      key: isPerson ? `person:${d.enhedsNummer}` : `company:${d.forretningsnoegle || d.enhedsNummer}`,
      type: isPerson ? 'person' : 'company',
      name: latest(d.navne, (n) => n.navn) || 'Unknown',
      cvr: isPerson ? null : d.forretningsnoegle ? String(d.forretningsnoegle) : null,
    };
    for (const org of rel.organisationer || []) {
      const orgName = latest(org.organisationsNavn, (n) => n.navn) || '';
      const current = hasCurrentMembership(org.medlemsData);
      if (!current) continue;
      if (org.hovedtype === 'REGISTER' && /ejer/i.test(orgName) && !/reel/i.test(orgName)) {
        owners.push({ ...party, share: parseShare(currentAttr(org.medlemsData, 'EJERANDEL_PROCENT')) });
      } else if (org.hovedtype === 'FULDT_ANSVARLIG_DELTAGERE') {
        // Sole proprietorships and I/S partnerships: the participants are the owners.
        owners.push({ ...party, share: null });
      } else if (org.hovedtype === 'LEDELSESORGAN') {
        managers.push({ ...party, role: currentAttr(org.medlemsData, 'FUNKTION') || orgName });
      }
    }
  }
  const activeUnits = (v.penheder || []).filter((p) => isCurrent(p.periode)).length;
  return {
    cvr: String(v.cvrNummer),
    name: meta.nyesteNavn?.navn || latest(v.navne, (n) => n.navn) || '',
    form: meta.nyesteVirksomhedsform?.kortBeskrivelse || null,
    status: meta.sammensatStatus || null,
    activeUnits,
    owners: dedupe(owners),
    managers: dedupe(managers),
  };
}

function dedupe(list) {
  const seen = new Map();
  for (const x of list) if (!seen.has(x.key)) seen.set(x.key, x);
  return [...seen.values()];
}

// ---------- high level fetchers ----------

export async function fetchAarhusRestaurantUnits() {
  const query = {
    bool: {
      filter: [
        {
          term: {
            'VrproduktionsEnhed.produktionsEnhedMetadata.nyesteBeliggenhedsadresse.kommune.kommuneKode':
              AARHUS_KOMMUNEKODE,
          },
        },
        {
          bool: {
            should: ['561', '563'].map((prefix) => ({
              prefix: { 'VrproduktionsEnhed.produktionsEnhedMetadata.nyesteHovedbranche.branchekode': prefix },
            })),
          },
        },
      ],
    },
  };
  const raw = await searchAll('produktionsenhed', query);
  return raw
    .map(parseUnit)
    .filter((u) => u.active && u.cvr && isRestaurantBranch(u.branchCode) && u.kommune === AARHUS_KOMMUNEKODE);
}

/** Fetch companies by CVR, then walk up their company owners (holding structures) to maxDepth. */
export async function fetchCompaniesWithOwners(cvrs, { maxDepth = 5 } = {}) {
  const companies = {};
  let frontier = [...new Set(cvrs)];
  for (let depth = 0; depth <= maxDepth && frontier.length; depth++) {
    console.log(`  depth ${depth}: fetching ${frontier.length} companies`);
    for (let i = 0; i < frontier.length; i += 200) {
      const chunk = frontier.slice(i, i + 200).map(Number);
      const raw = await searchAll('virksomhed', { terms: { 'Vrvirksomhed.cvrNummer': chunk } });
      for (const c of raw.map(parseCompany)) companies[c.cvr] = c;
    }
    frontier = [
      ...new Set(
        frontier
          .flatMap((cvr) => companies[cvr]?.owners || [])
          .filter((o) => o.type === 'company' && o.cvr && !companies[o.cvr])
          .map((o) => o.cvr),
      ),
    ];
  }
  return companies;
}
