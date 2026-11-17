// Step 3: match OSM places to CVR units, geocode CVR-only units, group by owner.
// Input: data/osm.json, data/cvr.json (optional). Output: site/data/restaurants.json
import path from 'node:path';
import { DATA_DIR, ROOT, CACHE_DIR, fetchJson, readJson, sleep, writeJson } from './lib/util.mjs';
import { matchPlaces } from './lib/match.mjs';
import { buildGroups } from './lib/group.mjs';

const OUT = path.join(ROOT, 'site', 'data', 'restaurants.json');
const GEOCODE = process.env.GEOCODE !== '0';

/** Geocode a Danish address. Tries DAWA (Dataforsyningen), then Nominatim. Cached on disk. */
async function geocode(unit, cache) {
  const q = `${unit.street} ${unit.houseNumber}, ${unit.postcode} ${unit.city || ''}`.trim();
  if (q in cache) return cache[q];
  let hit = null;
  try {
    const params = new URLSearchParams({ q, per_side: '1', struktur: 'mini' });
    const res = await fetchJson(`https://api.dataforsyningen.dk/adgangsadresser?${params}`, {}, { retries: 1, label: 'dawa' });
    if (res[0]?.x) hit = { lat: res[0].y, lon: res[0].x };
  } catch {
    /* fall through to Nominatim */
  }
  if (!hit) {
    try {
      const params = new URLSearchParams({ q, format: 'json', limit: '1', countrycodes: 'dk' });
      const res = await fetchJson(`https://nominatim.openstreetmap.org/search?${params}`, {}, { retries: 1, label: 'nominatim' });
      if (res[0]) hit = { lat: Number(res[0].lat), lon: Number(res[0].lon) };
      await sleep(1100); // Nominatim usage policy: max 1 request per second
    } catch {
      /* leave unlocated */
    }
  }
  cache[q] = hit;
  return hit;
}

export function assemble(osm, cvr) {
  const places = osm.places;
  const units = cvr?.units || [];
  const companies = cvr?.companies || {};
  const matches = matchPlaces(places, units);
  const matchedUnits = new Set([...matches.values()].map((m) => m.unit.pNumber));

  const restaurants = places.map((p) => {
    const m = matches.get(p.osmId);
    return {
      id: p.osmId,
      name: p.name,
      amenity: p.amenity,
      cuisine: p.cuisine,
      lat: p.lat,
      lon: p.lon,
      address: [p.street, p.houseNumber].filter(Boolean).join(' ') || null,
      postcode: p.postcode,
      website: p.website,
      brand: p.brand,
      brandWikidata: p.brandWikidata,
      source: 'osm',
      cvr: m?.unit.cvr || null,
      pNumber: m?.unit.pNumber || null,
      cvrName: m?.unit.name || null,
      companyName: m ? companies[m.unit.cvr]?.name || null : null,
      branch: m?.unit.branchText || null,
      matchConfidence: m?.confidence || null,
      // Phase 2: menus scraped from `website` will be attached here.
      menu: null,
    };
  });

  // CVR units with no OSM match still belong on the map: they are registered restaurants.
  for (const u of units) {
    if (matchedUnits.has(u.pNumber)) continue;
    restaurants.push({
      id: `cvr/${u.pNumber}`,
      name: u.name,
      amenity: /563/.test(u.branchCode || '') ? 'bar' : 'restaurant',
      cuisine: null,
      lat: u.lat ?? null,
      lon: u.lon ?? null,
      address: [u.street, u.houseNumber].filter(Boolean).join(' ') || null,
      postcode: u.postcode,
      website: null,
      brand: null,
      brandWikidata: null,
      source: 'cvr',
      cvr: u.cvr,
      pNumber: u.pNumber,
      cvrName: u.name,
      companyName: companies[u.cvr]?.name || null,
      branch: u.branchText,
      matchConfidence: null,
      menu: null,
    });
  }

  const { groups } = buildGroups(restaurants, companies);
  return { restaurants, groups, matched: matches.size, unmatchedUnits: units.length - matchedUnits.size };
}

async function main() {
  const osm = await readJson(path.join(DATA_DIR, 'osm.json'));
  const cvr = await readJson(path.join(DATA_DIR, 'cvr.json'), null);
  if (!cvr) console.warn('No data/cvr.json yet: building a map without ownership data.');

  if (cvr && GEOCODE && cvr.source === 'erst') {
    const cachePath = path.join(CACHE_DIR, 'geocode.json');
    const cache = await readJson(cachePath, {});
    // Only unmatched units need coordinates, but we cannot know which before matching, and matching
    // improves with coordinates. Geocode those whose address differs from every OSM address.
    const osmAddrs = new Set(osm.places.map((p) => `${p.street} ${p.houseNumber}`));
    const todo = cvr.units.filter((u) => u.street && u.houseNumber && !osmAddrs.has(`${u.street} ${u.houseNumber}`));
    console.log(`Geocoding ${todo.length} CVR units...`);
    for (const u of todo) Object.assign(u, (await geocode(u, cache)) || {});
    await writeJson(cachePath, cache);
  }

  const { restaurants, groups, matched, unmatchedUnits } = assemble(osm, cvr);
  const located = restaurants.filter((r) => r.lat != null);
  const counts = located.reduce((acc, r) => ((acc[r.category] = (acc[r.category] || 0) + 1), acc), {});
  console.log(`  ${matched} OSM places matched to CVR, ${unmatchedUnits} CVR-only units`);
  console.log(`  ${groups.length} ownership groups; categories:`, counts);

  await writeJson(OUT, {
    generatedAt: new Date().toISOString(),
    osmFetchedAt: osm.fetchedAt,
    cvrFetchedAt: cvr?.fetchedAt || null,
    cvrSource: cvr?.source || null,
    restaurants: located,
    groups,
  });
  console.log(`Wrote ${path.relative(ROOT, OUT)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
