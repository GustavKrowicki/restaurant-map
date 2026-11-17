// Fallback CVR source: cvrapi.dk. No signup, but rate limited and it returns only the single best
// match per name search, with owner names but no stable owner ids. Good for a demo, not for a full run.
import { fetchJson, normalizeName, sleep } from './util.mjs';

const BASE = 'https://cvrapi.dk/api';

export async function searchCompany(name) {
  const params = new URLSearchParams({ search: name, country: 'dk' });
  if (process.env.CVRAPI_TOKEN) params.set('token', process.env.CVRAPI_TOKEN);
  let json;
  try {
    json = await fetchJson(`${BASE}?${params}`, {}, { retries: 1, label: `cvrapi ${name}` });
  } catch (err) {
    // Not-found answers come back as HTTP 404; anything else (quota, bad user agent) stops the run
    // so the place is not cached as "no match".
    if (/HTTP 404/.test(err.message) && !/QUOTA/.test(err.message)) return null;
    throw new Error(/QUOTA/.test(err.message) ? 'cvrapi.dk daily quota reached' : `cvrapi.dk error: ${err.message}`);
  }
  if (json.error === 'NOT_FOUND') return null;
  if (json.error) throw new Error(json.error === 'QUOTA_EXCEEDED' ? 'cvrapi.dk daily quota reached' : `cvrapi.dk error: ${json.error}`);
  return json;
}

/** Split "Mejlgade 12B, 1. th" into street and house number. */
export function splitAddress(address = '') {
  const m = String(address).match(/^(.*?)\s+(\d+\s?[A-Za-z]?)\b/);
  if (!m) return { street: address || null, houseNumber: null };
  return { street: m[1].trim(), houseNumber: m[2].replace(/\s/g, '').toUpperCase() };
}

/** Convert a cvrapi.dk company into the pipeline's normalized { units, company } shape. */
export function normalizeCvrapi(json) {
  const cvr = String(json.vat);
  const toUnit = (p, fallbackName) => ({
    pNumber: String(p.pno || `${cvr}-main`),
    name: p.name || fallbackName,
    cvr,
    ...splitAddress(p.address),
    postcode: p.zipcode ? String(p.zipcode) : null,
    city: p.city || null,
    kommune: null,
    branchCode: p.industrycode ? String(p.industrycode) : null,
    branchText: p.industrydesc || null,
    active: !p.enddate,
  });
  let units = (json.productionunits || []).map((p) => toUnit(p, json.name)).filter((u) => u.active);
  // Small companies often come without production units: use the company address instead.
  if (!units.length) units = [toUnit({ ...json, pno: null }, json.name)];
  const company = {
    cvr,
    name: json.name,
    form: json.companydesc || null,
    status: json.enddate ? 'Ophørt' : 'Aktiv',
    activeUnits: (json.productionunits || []).filter((p) => !p.enddate).length || 1,
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

/**
 * Look up places one by one, caching every answer (including "no match") in `cache`, so a run can
 * stop at the daily quota and the next run continues where it left off.
 * cache: { [osmId]: { query, fetchedAt, result: json|null } }
 */
export async function lookupPlaces(places, cache, { limit = 40, delayMs = 2000, onProgress } = {}) {
  let calls = 0;
  let quotaHit = false;
  for (const place of places) {
    if (cache[place.osmId]) continue;
    if (calls >= limit) break;
    calls++;
    let result;
    try {
      result = await searchCompany(place.name);
    } catch (err) {
      console.warn(`  ${err.message} after ${calls - 1} lookups; run again later to continue`);
      quotaHit = true;
      break;
    }
    cache[place.osmId] = { query: place.name, fetchedAt: new Date().toISOString(), result: result?.vat ? result : null };
    if (onProgress) await onProgress(calls);
    await sleep(delayMs);
  }
  return { calls: quotaHit ? calls - 1 : calls, quotaHit };
}

/** Aarhus Kommune postcodes, used to drop name matches that belong to a company elsewhere. */
export const AARHUS_POSTCODES = new Set([
  '8000', '8200', '8210', '8220', '8230', '8240', '8245', '8250', '8260', '8270', '8300', '8310',
  '8320', '8330', '8340', '8355', '8361', '8362', '8380', '8381', '8462', '8471', '8520', '8530', '8541',
]);

/** Turn the cache into { units, companies }, keeping only companies with a presence in Aarhus. */
export function fromCache(cache) {
  const units = new Map();
  const companies = {};
  for (const entry of Object.values(cache)) {
    if (!entry.result) continue;
    const { units: u, company } = normalizeCvrapi(entry.result);
    const local = u.filter((x) => AARHUS_POSTCODES.has(x.postcode));
    if (!local.length) continue;
    companies[company.cvr] = company;
    for (const x of local) units.set(x.pNumber, x);
  }
  return { units: [...units.values()], companies };
}
