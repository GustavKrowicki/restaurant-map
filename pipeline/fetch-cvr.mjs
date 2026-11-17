// Step 2: fetch restaurant production units (P-units) in Aarhus and their companies + owners from CVR.
// Source is picked automatically: ERST distribution when CVR_ES_USER/CVR_ES_PASSWORD are set,
// otherwise a small cvrapi.dk sample (set CVRAPI_LIMIT to change its size).
// Output: data/cvr.json
import path from 'node:path';
import { DATA_DIR, readJson, writeJson } from './lib/util.mjs';
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
    const limit = Number(process.env.CVRAPI_LIMIT || 40);
    console.log(`No ERST credentials, falling back to cvrapi.dk for up to ${limit} places...`);
    const osm = await readJson(path.join(DATA_DIR, 'osm.json'));
    const places = osm.places.filter((p) => ['restaurant', 'cafe', 'fast_food'].includes(p.amenity));
    ({ units, companies } = await cvrapi.fetchForPlaces(places, { limit }));
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
