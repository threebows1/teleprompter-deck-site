// "My documents": finished and uploaded files kept in this browser
// (IndexedDB), never on a server. Also favourite tools (localStorage).

const DB = 'pdftools';
const STORE = 'docs';
export const LIMIT = 200 * 1024 * 1024; // keep at most this much; oldest go first

let dbp;
function db() {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
const tx = async (mode, fn) => {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
};

// Newest first, without the file bytes.
export async function listDocs() {
  try {
    const all = await tx('readonly', (s) => s.getAll());
    return (all || []).map(({ blob, ...meta }) => meta).sort((a, b) => b.added - a.added);
  } catch { return []; }
}

export async function getDoc(id) {
  try { return await tx('readonly', (s) => s.get(id)); } catch { return null; }
}

export async function deleteDoc(id) {
  try { await tx('readwrite', (s) => s.delete(id)); } catch { /* ignore */ }
}

// Saves a file; returns its id, or null if storage isn't available.
export async function saveDoc({ name, bytes, type = 'application/pdf', tool = '' }) {
  try {
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await tx('readwrite', (s) => s.put({ id, name, size: blob.size, type: blob.type || type, tool, added: Date.now(), blob }));
    // Stay under LIMIT by dropping the oldest.
    const docs = await listDocs();
    let total = docs.reduce((n, d) => n + d.size, 0);
    for (const d of docs.slice().reverse()) {
      if (total <= LIMIT) break;
      await deleteDoc(d.id);
      total -= d.size;
    }
    return id;
  } catch { return null; }
}

export async function usedBytes() {
  return (await listDocs()).reduce((n, d) => n + d.size, 0);
}

/* settings and favourites */

const get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const set = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

export const keepCopies = () => get('pdftools.keep', true);
export const setKeepCopies = (v) => set('pdftools.keep', !!v);
export const favorites = () => get('pdftools.favs', ['edit', 'merge', 'compress', 'sign']);
export function toggleFavorite(id) {
  const f = favorites();
  const next = f.includes(id) ? f.filter((x) => x !== id) : [...f, id];
  set('pdftools.favs', next);
  return next.includes(id);
}
