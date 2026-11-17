// Group restaurants by who ultimately owns them, following CVR legal-owner links upwards.

/** Owners at or above this share link companies into one group. Unknown shares (sole traders,
 *  partnerships, cvrapi.dk names) always link. 25% is the usual "significant influence" line. */
export const LINK_THRESHOLD = Number(process.env.OWNERSHIP_LINK_THRESHOLD || 0.25);

const linkingOwners = (company) =>
  (company?.owners || []).filter((o) => o.share == null || o.share >= LINK_THRESHOLD);

class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    while (this.parent.get(x) !== root) {
      const next = this.parent.get(x);
      this.parent.set(x, root);
      x = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** All ownership paths from an operating company up to its ultimate owners (max 12 paths). */
export function ownerPaths(cvr, companies, { maxDepth = 8, maxPaths = 12 } = {}) {
  const paths = [];
  const walk = (node, trail, seen) => {
    if (paths.length >= maxPaths) return;
    const company = node.type === 'company' ? companies[node.cvr] : null;
    const owners = linkingOwners(company);
    if (!owners.length || trail.length > maxDepth) {
      paths.push(trail);
      return;
    }
    for (const o of owners) {
      if (seen.has(o.key)) continue;
      const next = { key: o.key, type: o.type, name: o.name, cvr: o.cvr, share: o.share };
      walk(next, [...trail, next], new Set([...seen, o.key]));
    }
  };
  const start = { key: `company:${cvr}`, type: 'company', name: companies[cvr]?.name || cvr, cvr, share: null };
  walk(start, [start], new Set([start.key]));
  return paths;
}

export function categorize(size, brand) {
  if (size == null) return brand ? 'chain-brand' : 'unknown';
  if (size >= 10) return 'large-group';
  if (size >= 4) return 'group';
  if (size >= 2) return 'small-group';
  return brand ? 'chain-brand' : 'independent';
}

/**
 * @param restaurants [{id, cvr, brand, ...}] cvr = operating company or null when unmatched
 * @param companies   {cvr: {name, owners, activeUnits}}
 * @returns {restaurants, groups}
 */
export function buildGroups(restaurants, companies) {
  const uf = new UnionFind();
  const visit = (cvr, seen = new Set()) => {
    const key = `company:${cvr}`;
    if (seen.has(key)) return;
    seen.add(key);
    uf.find(key);
    for (const o of linkingOwners(companies[cvr])) {
      uf.union(key, o.key);
      if (o.type === 'company' && o.cvr) visit(o.cvr, seen);
    }
  };
  for (const r of restaurants) if (r.cvr) visit(r.cvr);

  const groups = new Map();
  for (const r of restaurants) {
    if (!r.cvr) continue;
    const gid = uf.find(`company:${r.cvr}`);
    if (!groups.has(gid)) groups.set(gid, { restaurants: [], operating: new Set(), rootCounts: new Map() });
    const g = groups.get(gid);
    g.restaurants.push(r);
    g.operating.add(r.cvr);
    r.ownerPaths = ownerPaths(r.cvr, companies);
    const roots = new Map(r.ownerPaths.map((p) => [p[p.length - 1].key, p[p.length - 1]]));
    for (const root of roots.values()) {
      const entry = g.rootCounts.get(root.key) || { ...root, restaurants: 0 };
      entry.restaurants++;
      g.rootCounts.set(root.key, entry);
    }
  }

  const out = [];
  let n = 0;
  for (const g of [...groups.values()].sort((a, b) => b.restaurants.length - a.restaurants.length)) {
    const id = `g${++n}`;
    const owners = [...g.rootCounts.values()].sort((a, b) => b.restaurants - a.restaurants);
    const top = owners.filter((o) => o.restaurants === owners[0].restaurants).slice(0, 2);
    const size = g.restaurants.length;
    const nationwideUnits = [...g.operating].reduce((s, cvr) => s + (companies[cvr]?.activeUnits || 0), 0);
    out.push({
      id,
      label: top.map((o) => o.name).join(' & ') + (owners.length > top.length ? ` +${owners.length - top.length}` : ''),
      size,
      operatingCompanies: [...g.operating].map((cvr) => ({ cvr, name: companies[cvr]?.name || cvr })),
      nationwideUnits,
      owners: owners.map(({ key, type, name, cvr, restaurants }) => ({ key, type, name, cvr, restaurants })),
      restaurantIds: g.restaurants.map((r) => r.id),
    });
    for (const r of g.restaurants) {
      r.groupId = id;
      r.groupSize = size;
    }
  }

  // Brands (OSM brand tag) catch franchises where each outlet is a separate company.
  const brandCounts = new Map();
  for (const r of restaurants) if (r.brand) brandCounts.set(r.brand, (brandCounts.get(r.brand) || 0) + 1);
  for (const r of restaurants) {
    r.brandCount = r.brand ? brandCounts.get(r.brand) : null;
    r.category = categorize(r.groupSize ?? null, r.brand && r.brandCount >= 2 ? r.brand : r.brandWikidata);
  }
  return { restaurants, groups: out };
}
