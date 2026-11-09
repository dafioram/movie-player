// What the app remembers, all in this browser only: preferences and playback positions in
// localStorage, and the last movie's file handles (locations, not contents) in IndexedDB.

const PREFS_KEY = 'mp.prefs';
const POS_KEY = 'mp.positions';
const MAX_POSITIONS = 200;

const DEFAULT_PREFS = {
  volume: 1,
  muted: false,
  audioLang: null,
  subLang: null,
  subOff: false,
  sub2Lang: null,
  subStyle: { size: 1, color: '#ffffff', background: 'none', outline: true },
  subScale: 1,
  localFonts: false,
};

function readJson(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

export function loadPrefs() {
  const p = readJson(PREFS_KEY, {});
  return { ...DEFAULT_PREFS, ...p, subStyle: { ...DEFAULT_PREFS.subStyle, ...(p.subStyle || {}) } };
}

export function savePrefs(prefs) {
  writeJson(PREFS_KEY, prefs);
}

export function movieKey(movie) {
  return `${movie.name}|${movie.size}|${movie.lastModified}`;
}

export function getPosition(key) {
  const all = readJson(POS_KEY, {});
  return all[key] || null;
}

/** Saves a position, or forgets it in the first 30 seconds and last 2 minutes. */
export function savePosition(key, time, duration) {
  const all = readJson(POS_KEY, {});
  if (time < 30 || (duration && time > duration - 120)) delete all[key];
  else all[key] = { t: Math.round(time * 10) / 10, d: duration, at: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > MAX_POSITIONS) {
    keys.sort((a, b) => all[a].at - all[b].at);
    for (const k of keys.slice(0, keys.length - MAX_POSITIONS)) delete all[k];
  }
  writeJson(POS_KEY, all);
}

export function clearPositions() {
  try { localStorage.removeItem(POS_KEY); } catch { /* ignore */ }
}

/* ---------------- last movie (IndexedDB, since handles can't go in localStorage) ---------------- */

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('movieplayer', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kv(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', mode);
    const store = tx.objectStore('kv');
    const req = fn(store);
    tx.oncomplete = () => { d.close(); resolve(req ? req.result : undefined); };
    tx.onerror = () => { d.close(); reject(tx.error); };
  });
}

export async function saveLastMovie(record) {
  try { await kv('readwrite', (s) => s.put(record, 'last')); } catch { /* handles not storable */ }
}

export async function loadLastMovie() {
  try { return (await kv('readonly', (s) => s.get('last'))) || null; } catch { return null; }
}

export async function updateLastMovie(patch) {
  const cur = await loadLastMovie();
  if (cur) await saveLastMovie({ ...cur, ...patch });
}

export async function clearLastMovie() {
  try { await kv('readwrite', (s) => s.delete('last')); } catch { /* ignore */ }
}
