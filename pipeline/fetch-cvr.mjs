// Step 2: fetch restaurant production units (P-units) in Aarhus and their companies + owners from CVR.
// Source is picked automatically: ERST distribution when CVR_ES_USER/CVR_ES_PASSWORD are set,
// otherwise cvrapi.dk name lookups around the centre (CVRAPI_RADIUS_M, default 800), CVRAPI_LIMIT per run, resumable.
// Output: data/cvr.json
import path from 'node:path';
import { DATA_DIR, ROOT, distanceMeters, readJson, writeJson } from './lib/util.mjs';
import * as erst from './lib/erst.mjs';
import * as cvrapi from './lib/cvrapi.mjs';

async function main() {
  const useErst = Boolean(process.env.CVR_ES_USER && process.env.CVR_ES_PASSWORD);
  let units;
  let companies;
  if (useErst) {
    console.log('Fetching Aarhus restaurant P-units from Erhvervsstyrelsen CVR...');
    units = await erst.fetchAarhusRestaurantUnits();
    console.log(`  ${units.length} active restaurant/bar units in Aarhus Kommune`);
    companies = await erst.fetchCompaniesWithOwners(units.map((u) => u.cvr));
  } else {
    // cvrapi.dk: free but rate limited. Answers are cached in cache/cvrapi.json (committed), so
    // repeated runs continue where the last one stopped at the daily quota.
    const limit = Number(process.env.CVRAPI_LIMIT || 40);
    // Pilot area: places within CVRAPI_RADIUS_M of Store Torv (default 800 m, roughly the old city).
    const radius = Number(process.env.CVRAPI_RADIUS_M || 800);
    const centre = { lat: 56.1567, lon: 10.2108 };
    const cachePath = path.join(ROOT, 'cache', 'cvrapi.json');
    const cache = await readJson(cachePath, {});
    const osm = await readJson(path.join(DATA_DIR, 'osm.json'));
    const rank = { restaurant: 0, cafe: 1, bar: 2, pub: 2, fast_food: 3 };
    const places = osm.places
      .filter((p) => p.amenity in rank && !p.brand && distanceMeters(p, centre) <= radius)
      .sort((a, b) => rank[a.amenity] - rank[b.amenity] || distanceMeters(a, centre) - distanceMeters(b, centre));
    const todo = places.filter((p) => !cache[p.osmId]).length;
    console.log(`cvrapi.dk: ${places.length} places within ${radius} m of Store Torv, ${todo} not looked up yet, limit ${limit}`);
    const { calls, quotaHit } = await cvrapi.lookupPlaces(places, cache, {
      limit,
      onProgress: (n) => (n % 10 === 0 ? writeJson(cachePath, cache) : null),
    });
    await writeJson(cachePath, cache);
    const left = places.filter((p) => !cache[p.osmId]).length;
    console.log(`  ${calls} lookups this run${quotaHit ? ' (stopped at quota)' : ''}, ${left} left`);
    ({ units, companies } = cvrapi.fromCache(cache));
  }
  console.log(`  ${Object.keys(companies).length} companies incl. owning holding companies`);
  await writeJson(path.join(DATA_DIR, 'cvr.json'), {
    fetchedAt: new Date().toISOString(),
    source: useErst ? 'erst' : 'cvrapi',
    units,
    companies,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
