// Step 1: fetch every restaurant-like place in Aarhus Kommune from OpenStreetMap (Overpass API).
// Output: data/osm.json
import path from 'node:path';
import { DATA_DIR, fetchJson, writeJson } from './lib/util.mjs';

const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
export const AMENITIES = ['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'ice_cream', 'food_court'];

const query = `
[out:json][timeout:120];
area["name"="Aarhus Kommune"]["admin_level"="7"]->.aarhus;
nwr["amenity"~"^(${AMENITIES.join('|')})$"](area.aarhus);
out center tags;
`;

export function parseOverpass(json) {
  return json.elements
    .map((el) => {
      const t = el.tags || {};
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (!t.name || lat == null) return null;
      return {
        osmId: `${el.type}/${el.id}`,
        name: t.name,
        amenity: t.amenity,
        cuisine: t.cuisine || null,
        lat,
        lon,
        street: t['addr:street'] || null,
        houseNumber: t['addr:housenumber'] || null,
        postcode: t['addr:postcode'] || null,
        website: t.website || t['contact:website'] || null,
        // Brand tags mark chains/franchises independently of who legally runs the shop.
        brand: t.brand || null,
        brandWikidata: t['brand:wikidata'] || null,
        operator: t.operator || null,
        // Some mappers tag the company directly; use it as a strong match when present.
        cvr: (t['ref:DK:cvr'] || t['ref:vatin'] || '').replace(/\D/g, '').slice(-8) || null,
      };
    })
    .filter(Boolean);
}

async function main() {
  console.log('Querying Overpass for Aarhus Kommune...');
  const json = await fetchJson(
    OVERPASS_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: query }),
    },
    { label: 'overpass' },
  );
  const places = parseOverpass(json);
  const byAmenity = places.reduce((acc, p) => ((acc[p.amenity] = (acc[p.amenity] || 0) + 1), acc), {});
  console.log(`  ${places.length} named places`, byAmenity);
  await writeJson(path.join(DATA_DIR, 'osm.json'), {
    fetchedAt: new Date().toISOString(),
    source: 'OpenStreetMap contributors, via Overpass API (ODbL)',
    places,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
