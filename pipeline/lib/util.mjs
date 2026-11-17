// Shared helpers for the data pipeline. Node 20+, no dependencies.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const CACHE_DIR = path.join(ROOT, '.cache');

export const USER_AGENT =
  process.env.HTTP_USER_AGENT || 'aarhus-restaurant-map (github.com/GustavKrowicki/restaurant-map)';

export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch with retries and exponential backoff. Returns parsed JSON. */
export async function fetchJson(url, options = {}, { retries = 4, label = url } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(options.headers || {}) },
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`HTTP ${res.status} for ${label}: ${body.slice(0, 300)}`);
        err.fatal = true;
        throw err;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (err.fatal || attempt === retries) break;
      const wait = 1000 * 2 ** attempt;
      console.warn(`  ${label}: ${err.message}, retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** Lowercase, strip accents (keeping æøå readable), punctuation and legal suffixes. */
export function normalizeName(name = '') {
  return name
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'oe')
    .replace(/å/g, 'aa')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' og ')
    .replace(/\b(aps|a\/s|as|i\/s|ivs|p\/s|k\/s|smba|holding|v\/.*$)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'restaurant', 'restaurang', 'cafe', 'caffe', 'bar', 'og', 'the', 'and', 'aarhus', 'pizzeria',
  'grill', 'kitchen', 'koekken', 'by', 'i', 'a', 'de', 'la', 'le', 'il', 'pizza', 'burger',
]);

function tokens(name) {
  return normalizeName(name).split(' ').filter((t) => t && !STOPWORDS.has(t));
}

function trigrams(s) {
  const padded = `  ${s} `;
  const out = new Set();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Name similarity in [0,1]: max of token Jaccard and trigram Dice, ignoring filler words. */
export function nameSimilarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) {
    // Names made only of filler words ("Cafe Aarhus"): compare the full normalized form.
    return normalizeName(a) === normalizeName(b) ? 1 : 0;
  }
  const sa = new Set(ta);
  const sb = new Set(tb);
  const inter = [...sa].filter((t) => sb.has(t)).length;
  const jaccard = inter / new Set([...sa, ...sb]).size;
  const ga = trigrams(ta.join(' '));
  const gb = trigrams(tb.join(' '));
  const gInter = [...ga].filter((g) => gb.has(g)).length;
  const dice = (2 * gInter) / (ga.size + gb.size);
  // One name fully contained in the other ("Mefisto" vs "Restaurant Mefisto Aarhus ApS").
  const contained = [...sa].every((t) => sb.has(t)) || [...sb].every((t) => sa.has(t)) ? 0.9 : 0;
  return Math.max(jaccard, dice, contained);
}

/** "Store Torv 3A" style address key used to compare OSM and CVR addresses. */
export function addressKey(street, houseNumber) {
  if (!street || !houseNumber) return null;
  return `${normalizeName(street)} ${String(houseNumber).toLowerCase().replace(/\s+/g, '')}`;
}

/** Haversine distance in metres. */
export function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
