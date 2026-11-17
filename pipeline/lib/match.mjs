// Match OpenStreetMap places to CVR production units (P-units).
import { addressKey, distanceMeters, nameSimilarity } from './util.mjs';

/**
 * Score one OSM place against one CVR unit. Returns null when they clearly are not the same place.
 * Signals: CVR tagged in OSM, same street address, name similarity, distance when the unit has coords.
 */
export function scorePair(place, unit) {
  const sim = nameSimilarity(place.name, unit.name);
  const placeAddr = addressKey(place.street, place.houseNumber);
  const unitAddr = addressKey(unit.street, unit.houseNumber);
  const sameAddress = Boolean(placeAddr && placeAddr === unitAddr);
  const samePostcode = Boolean(place.postcode && unit.postcode && place.postcode === unit.postcode);
  const dist = unit.lat != null ? distanceMeters(place, unit) : null;
  const near = dist != null && dist < 120;
  const taggedCvr = Boolean(place.cvr && place.cvr === unit.cvr);

  let accepted = false;
  if (taggedCvr && (sim >= 0.3 || sameAddress || near)) accepted = true;
  else if (sameAddress && sim >= 0.3) accepted = true;
  else if (near && sim >= 0.5) accepted = true;
  else if (sim >= 0.85 && (samePostcode || (dist != null && dist < 600))) accepted = true;
  if (!accepted) return null;

  const score = sim + (sameAddress ? 0.6 : 0) + (near ? 0.3 : 0) + (taggedCvr ? 1 : 0) + (samePostcode ? 0.1 : 0);
  const confidence = sameAddress || taggedCvr || near ? (sim >= 0.6 ? 'high' : 'medium') : 'low';
  return { score, confidence, sim, sameAddress, dist };
}

/** Greedy one-to-one matching by descending score. Returns Map(osmId -> {unit, ...score}). */
export function matchPlaces(places, units) {
  // Bucket units by postcode and address to avoid an all-pairs scan on large inputs.
  const byPostcode = new Map();
  for (const u of units) {
    const k = u.postcode || '?';
    if (!byPostcode.has(k)) byPostcode.set(k, []);
    byPostcode.get(k).push(u);
  }
  const candidates = [];
  for (const place of places) {
    const pool = place.postcode && byPostcode.has(place.postcode) ? byPostcode.get(place.postcode) : units;
    // Also scan all units when the place has no postcode or a CVR tag.
    const scan = place.postcode && !place.cvr ? pool : units;
    for (const unit of scan) {
      const s = scorePair(place, unit);
      if (s) candidates.push({ place, unit, ...s });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const usedPlaces = new Set();
  const usedUnits = new Set();
  const matches = new Map();
  for (const c of candidates) {
    if (usedPlaces.has(c.place.osmId) || usedUnits.has(c.unit.pNumber)) continue;
    usedPlaces.add(c.place.osmId);
    usedUnits.add(c.unit.pNumber);
    matches.set(c.place.osmId, c);
  }
  return matches;
}
