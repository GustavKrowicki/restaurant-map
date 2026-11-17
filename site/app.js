/* global L */
const CATEGORIES = [
  { id: 'independent', label: 'Independent', hint: 'one place, owner has no other restaurants' },
  { id: 'small-group', label: 'Small group (2 to 3)', hint: 'same owner runs 2 or 3 places' },
  { id: 'group', label: 'Group (4 to 9)', hint: 'same owner runs 4 to 9 places' },
  { id: 'large-group', label: 'Large group (10+)', hint: 'same owner runs 10 or more places' },
  { id: 'chain-brand', label: 'Chain brand / franchise', hint: 'brand with several outlets, each run by its own company' },
  { id: 'unknown', label: 'Owner not found', hint: 'no matching CVR unit found' },
];
const AMENITY = { restaurant: 'Restaurant', cafe: 'Cafe', fast_food: 'Fast food', bar: 'Bar', pub: 'Pub', ice_cream: 'Ice cream', food_court: 'Food court' };

const css = getComputedStyle(document.documentElement);
const color = (cat) => css.getPropertyValue(`--${cat}`).trim();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cvrLink = (cvr, text = cvr) => `<a href="https://datacvr.virk.dk/enhed/virksomhed/${esc(cvr)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);

const state = { active: new Set(CATEGORIES.map((c) => c.id)), query: '', groupId: null, selectedId: null };

const map = L.map('map', { preferCanvas: true, zoomControl: true }).setView([56.1572, 10.2107], 13);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  subdomains: 'abcd',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
}).addTo(map);

let data;
const markers = new Map();
const byId = new Map();
const groupsById = new Map();

async function load() {
  try {
    const res = await fetch('data/restaurants.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch {
    document.getElementById('summary').innerHTML =
      '<p id="empty">No data yet. Run <code>npm run data</code> (or the "Refresh data" GitHub Action) to fetch restaurants from OpenStreetMap and owners from CVR.</p>';
    return;
  }
  for (const r of data.restaurants) byId.set(r.id, r);
  for (const g of data.groups) groupsById.set(g.id, g);
  for (const r of data.restaurants) {
    const radius = r.groupSize >= 10 ? 8 : r.groupSize >= 4 ? 7 : r.groupSize >= 2 ? 6 : 5;
    const m = L.circleMarker([r.lat, r.lon], {
      radius,
      color: '#fff',
      weight: 1,
      fillColor: color(r.category),
      fillOpacity: 0.9,
    });
    m.bindTooltip(`${esc(r.name)}${r.groupSize > 1 ? ` · group of ${r.groupSize}` : ''}`, { direction: 'top', offset: [0, -4] });
    m.on('click', () => select(r.id));
    markers.set(r.id, m);
  }
  renderSummary();
  renderFilters();
  renderGroups();
  renderFreshness();
  applyFilters();
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (byId.has(fromHash)) select(fromHash);
  else if (groupsById.has(fromHash)) showGroup(fromHash);
}

function renderSummary() {
  const rs = data.restaurants;
  const known = rs.filter((r) => r.category !== 'unknown');
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c.id, rs.filter((r) => r.category === c.id).length]));
  const inGroups = counts['small-group'] + counts.group + counts['large-group'];
  const bar = CATEGORIES.map((c) => `<span style="width:${(100 * counts[c.id]) / rs.length}%;background:${color(c.id)}" title="${esc(c.label)}: ${counts[c.id]}"></span>`).join('');
  const legend = CATEGORIES.map(
    (c) => `<li><span class="dot" style="background:${color(c.id)}"></span>${esc(c.label)}<span class="n">${counts[c.id]}</span></li>`,
  ).join('');
  const hasOwners = rs.some((r) => r.cvr);
  const headline = hasOwners
    ? `<p class="headline"><strong>${pct(inGroups, known.length)}%</strong>
      of the ${known.length} places with a known owner belong to an owner who runs more than one place in Aarhus.
      ${pct(counts.independent, known.length)}% are independent.</p>`
    : `<p class="headline"><strong>${rs.length}</strong> places mapped. Ownership data from CVR is not loaded yet,
      so only chain brands known from OpenStreetMap are marked.</p>`;
  document.getElementById('summary').innerHTML = `
    ${headline}
    <div class="bar" role="img" aria-label="Share of places by ownership category">${bar}</div>
    <ul class="legend">${legend}</ul>`;
}

function renderFilters() {
  const el = document.getElementById('filters');
  el.innerHTML = CATEGORIES.map(
    (c) => `<button class="chip" data-cat="${c.id}" aria-pressed="true" title="${esc(c.hint)}"><span class="dot" style="background:${color(c.id)}"></span>${esc(c.label)}</button>`,
  ).join('');
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    const cat = btn.dataset.cat;
    // Click shows only that category; click again (when it is the only one) shows all.
    if (state.active.size === 1 && state.active.has(cat)) CATEGORIES.forEach((c) => state.active.add(c.id));
    else {
      state.active.clear();
      state.active.add(cat);
    }
    el.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(state.active.has(b.dataset.cat))));
    applyFilters();
  });
  document.getElementById('search').addEventListener('input', (e) => {
    state.query = e.target.value.trim().toLowerCase();
    applyFilters();
  });
}

function haystack(r) {
  const g = groupsById.get(r.groupId);
  return [r.name, r.companyName, r.cvr, r.address, r.brand, g?.label, ...(g?.owners || []).map((o) => o.name)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function applyFilters() {
  for (const r of data.restaurants) {
    const m = markers.get(r.id);
    let show = state.active.has(r.category);
    if (show && state.query) show = haystack(r).includes(state.query);
    if (show && state.groupId) show = r.groupId === state.groupId;
    if (show && !map.hasLayer(m)) m.addTo(map);
    if (!show && map.hasLayer(m)) m.remove();
  }
}

function renderGroups() {
  const multi = data.groups.filter((g) => g.size > 1).slice(0, 40);
  document.getElementById('groups').innerHTML = multi.length
    ? multi
        .map((g) => {
          const cat = g.size >= 10 ? 'large-group' : g.size >= 4 ? 'group' : 'small-group';
          return `<li><button class="group-btn" data-group="${g.id}">
            <span class="size" style="background:${color(cat)}">${g.size}</span>
            <span>${esc(g.label)}<span class="meta">${g.operatingCompanies.length} operating ${g.operatingCompanies.length === 1 ? 'company' : 'companies'}${g.nationwideUnits > g.size ? ` · ${g.nationwideUnits} units in Denmark` : ''}</span></span>
          </button></li>`;
        })
        .join('')
    : '<li class="note">No multi-place owners found yet.</li>';
  document.getElementById('groups').addEventListener('click', (e) => {
    const btn = e.target.closest('.group-btn');
    if (btn) showGroup(btn.dataset.group);
  });
}

function showGroup(groupId) {
  state.groupId = state.groupId === groupId ? null : groupId;
  document.querySelectorAll('.group-btn').forEach((b) => b.setAttribute('aria-current', String(b.dataset.group === state.groupId)));
  applyFilters();
  if (state.groupId) {
    const pts = groupsById.get(groupId).restaurantIds.map((id) => byId.get(id)).filter(Boolean).map((r) => [r.lat, r.lon]);
    if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
    const first = groupsById.get(groupId).restaurantIds.find((id) => byId.has(id));
    if (first) select(first, { pan: false });
    history.replaceState(null, '', `#${groupId}`);
  } else history.replaceState(null, '', location.pathname);
}

function renderChain(path) {
  return `<ul class="chain">${path
    .map((n, i) => {
      const name = n.type === 'company' && n.cvr ? cvrLink(n.cvr, n.name) : esc(n.name);
      const share = i > 0 && n.share != null ? ` <span class="share">owns ${Math.round(n.share * 100)}%</span>` : '';
      const kind = i === 0 ? ' <span class="share">runs the place</span>' : n.type === 'person' ? ' <span class="share">(person)</span>' : '';
      return `<li>${name}${kind}${share}</li>`;
    })
    .join('')}</ul>`;
}

function select(id, { pan = true } = {}) {
  const r = byId.get(id);
  if (!r) return;
  state.selectedId = id;
  const cat = CATEGORIES.find((c) => c.id === r.category);
  const g = groupsById.get(r.groupId);
  const siblings = g ? g.restaurantIds.filter((x) => x !== id && byId.has(x)).map((x) => byId.get(x)) : [];
  const el = document.getElementById('detail');
  el.hidden = false;
  el.innerHTML = `
    <button class="close" aria-label="Close">×</button>
    <span class="tag"><span class="dot" style="background:${color(r.category)}"></span>${esc(cat.label)}</span>
    <h3>${esc(r.name)}</h3>
    <p class="note">${esc(AMENITY[r.amenity] || r.amenity || '')}${r.cuisine ? ` · ${esc(r.cuisine.replace(/;/g, ', '))}` : ''}${r.address ? ` · ${esc(r.address)}` : ''}</p>
    <dl>
      ${r.cvr ? `<dt>Company</dt><dd>${cvrLink(r.cvr, r.companyName || r.cvr)}</dd><dt>CVR</dt><dd>${esc(r.cvr)}${r.pNumber ? ` · P ${esc(r.pNumber)}` : ''}</dd>` : '<dt>Company</dt><dd>Not matched to CVR</dd>'}
      ${r.brand ? `<dt>Brand</dt><dd>${esc(r.brand)}${r.brandCount > 1 ? ` (${r.brandCount} on the map)` : ''}</dd>` : ''}
      ${r.website ? `<dt>Website</dt><dd><a href="${esc(r.website)}" target="_blank" rel="noopener">${esc(r.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a></dd>` : ''}
      ${r.matchConfidence ? `<dt>Match</dt><dd>${esc(r.matchConfidence)} confidence${r.cvrName && r.cvrName !== r.name ? ` (registered as "${esc(r.cvrName)}")` : ''}</dd>` : ''}
      ${r.source === 'cvr' ? '<dt>Source</dt><dd>CVR only, not on OpenStreetMap</dd>' : ''}
    </dl>
    ${r.ownerPaths?.length ? `<h2>Ownership</h2>${r.ownerPaths.slice(0, 4).map(renderChain).join('')}` : ''}
    ${g && g.size > 1 ? `<h2>Same owner group: ${esc(g.label)} (${g.size})</h2><ul class="siblings">${siblings.map((s) => `<li><button data-id="${esc(s.id)}">${esc(s.name)}</button></li>`).join('')}</ul>` : ''}
    ${r.cvr && (!g || g.size === 1) ? '<p class="note">No other restaurants in Aarhus share this owner.</p>' : ''}`;
  el.querySelector('.close').onclick = () => {
    el.hidden = true;
    state.selectedId = null;
  };
  el.querySelectorAll('.siblings button').forEach((b) => (b.onclick = () => select(b.dataset.id)));
  if (pan) map.panTo([r.lat, r.lon]);
  if (!state.groupId) history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderFreshness() {
  const d = (s) => (s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'never');
  const src = data.cvrSource === 'cvrapi' ? ' (cvrapi.dk sample, incomplete)' : '';
  document.getElementById('freshness').textContent = `Data updated ${d(data.generatedAt)}. OpenStreetMap: ${d(data.osmFetchedAt)}. CVR: ${d(data.cvrFetchedAt)}${src}.`;
}

load();
