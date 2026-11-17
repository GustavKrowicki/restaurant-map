// Fallback CVR source: cvrapi.dk. No signup, but rate limited and it returns only the single best
// match per name search, with owner names but no stable owner ids. Good for a demo, not for a full run.
import { fetchJson, normalizeName, sleep } from './util.mjs';

const BASE = 'https://cvrapi.dk/api';

export async function searchCompany(name) {
  const params = new URLSearchParams({ search: name, country: 'dk' });
  if (process.env.CVRAPI_TOKEN) params.set('token', process.env.CVRAPI_TOKEN);
  try {
    const json = await fetchJson(`${BASE}?${params}`, {}, { retries: 1, label: `cvrapi ${name}` });
    if (json.error) return null;
    return json;
  } catch (err) {
    if (/QUOTA_EXCEEDED|HTTP 402|HTTP 403/.test(err.message)) throw new Error('cvrapi.dk quota exceeded');
    return null;
  }
}

/** Convert a cvrapi.dk company into the pipeline's normalized { units, company } shape. */
export function normalizeCvrapi(json) {
  const cvr = String(json.vat);
  const units = (json.productionunits || []).map((p) => ({
    pNumber: String(p.pno),
    name: p.name || json.name,
    cvr,
    street: (p.address || '').replace(/\s+\d+.*$/, '') || null,
    houseNumber: ((p.address || '').match(/\s(\d+\s?[A-Za-z]?)\b/) || [])[1]?.replace(/\s/g, '') || null,
    postcode: p.zipcode ? String(p.zipcode) : null,
    city: p.city || null,
    kommune: null,
    branchCode: p.industrycode ? String(p.industrycode) : null,
    branchText: p.industrydesc || null,
    active: true,
  }));
  const company = {
    cvr,
    name: json.name,
    form: json.companydesc || null,
    status: json.enddate ? 'Ophørt' : 'Aktiv',
    activeUnits: units.length,
    // No owner ids from cvrapi.dk, so owners are keyed by normalized name (weaker grouping).
    owners: (json.owners || []).map((o) => ({
      key: `name:${normalizeName(o.name)}`,
      type: 'person',
      name: o.name,
      cvr: null,
      share: null,
    })),
    managers: [],
  };
  return { units, company };
}

export async function fetchForPlaces(places, { limit = 40, delayMs = 1500 } = {}) {
  const units = [];
  const companies = {};
  let calls = 0;
  for (const place of places) {
    if (calls >= limit) break;
    calls++;
    let json;
    try {
      json = await searchCompany(place.name);
    } catch (err) {
      console.warn(`  ${err.message} after ${calls - 1} lookups, keeping what we have`);
      break;
    }
    await sleep(delayMs);
    if (!json?.vat) continue;
    const { units: u, company } = normalizeCvrapi(json);
    companies[company.cvr] = company;
    units.push(...u);
  }
  console.log(`  cvrapi.dk: ${calls} lookups, ${Object.keys(companies).length} companies`);
  return { units, companies };
}
