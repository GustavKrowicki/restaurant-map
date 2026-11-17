# Who owns Aarhus restaurants?

A map of the restaurants, cafes and bars in Aarhus Kommune, showing which ones are independent and which
belong to owners who run several places. Places come from OpenStreetMap; ownership comes from the Danish
company register (CVR).

## How it works

```
OpenStreetMap (Overpass)  ──► pipeline/fetch-osm.mjs ──► data/osm.json ─┐
                                                                          ├─► pipeline/build.mjs ──► site/data/restaurants.json ──► site/
CVR (Erhvervsstyrelsen)   ──► pipeline/fetch-cvr.mjs ──► data/cvr.json ─┘
```

1. **Places.** `fetch-osm` asks Overpass for every named `amenity=restaurant|cafe|fast_food|bar|pub|ice_cream|food_court`
   in Aarhus Kommune, with address, website, cuisine and `brand` tags.
2. **Registered units.** `fetch-cvr` pulls every active production unit (P-unit) in Aarhus Kommune (kommunekode 751)
   whose main industry code is 56.1x (restaurants) or 56.3x (bars), then the company behind each unit, then
   walks the company's legal owners upward through holding companies (up to 5 levels).
3. **Matching.** `build` matches OSM places to P-units on street address, name similarity and distance, one to one.
   CVR units with no OSM match are geocoded (Dataforsyningen, then Nominatim) and added, so the map includes
   registered places that are missing from OSM.
4. **Grouping.** Companies are linked when one owns at least 25% of another (`OWNERSHIP_LINK_THRESHOLD`), and
   companies with the same owner are joined. Each connected set is an owner group. Every place gets a category:

   | Category | Meaning |
   | --- | --- |
   | Independent | owner group has one place in Aarhus |
   | Small group | 2 to 3 places |
   | Group | 4 to 9 places |
   | Large group | 10 or more places |
   | Chain brand / franchise | one place per company, but the OSM `brand` appears on several places (franchises) |
   | Owner not found | no matching CVR unit |

### Caveats

- The legal owner register only lists owners with 5% or more. Since October 2025 the beneficial owner
  register (reelle ejere) is no longer public, so a person who owns through a foreign company may not show up.
- Matching is automatic. Each place shows its match confidence and links to its CVR page.
- Groups count places in Aarhus only. The group list also shows how many units the operating companies have
  in all of Denmark.

## Running it

Requires Node 20 or newer. No dependencies.

```sh
npm run data     # fetch OSM, fetch CVR, build site/data/restaurants.json
npm run serve    # http://localhost:8080
npm test
```

### CVR access

The full dataset needs free system-to-system access to CVR from Erhvervsstyrelsen. Email
`cvrselvbetjening@erst.dk` and ask for access to the CVR Elasticsearch distribution
([guide](https://erhvervsstyrelsen.dk/kom-godt-igang-med-elasticSearch)). Then set:

```sh
export CVR_ES_USER=...
export CVR_ES_PASSWORD=...
```

and in GitHub, add the same two names as repository secrets.

Without credentials `fetch-cvr` falls back to a small sample from cvrapi.dk (`CVRAPI_LIMIT`, default 40 lookups).
That is only good enough to try the site.

### GitHub Actions

- **Refresh data** (`.github/workflows/data.yml`) runs every Monday, on demand, and on pipeline changes on
  `claude/**` branches. It commits `site/data/restaurants.json`.
- **Deploy site** (`.github/workflows/pages.yml`) publishes `site/` to GitHub Pages on pushes to `main`.
  Turn it on in Settings, Pages, Source: GitHub Actions.

## Later: menus

Each place already carries `website` (from OSM) and an empty `menu` field. The planned phase 2 is a
`pipeline/fetch-menus.mjs` step that, per website:

1. finds the menu page (links containing "menu", "menukort", "spisekort", or a PDF),
2. extracts dishes and prices (HTML lists or PDF text, with an LLM pass for messy layouts),
3. stores `{ url, fetchedAt, items: [{ section, name, price, currency }] }` in `menu`,

so the site can show a menu tab and compare price levels between independent places and groups.
