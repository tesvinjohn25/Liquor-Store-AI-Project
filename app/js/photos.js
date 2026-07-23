// Bottle photos, stored in IndexedDB (localStorage is too small for images).
// Photos are taken by staff of the actual shelf bottle, so size and model
// are correct by definition — no name-matching guesswork. Images are
// downscaled to thumbnails before storing so thousands fit comfortably.
//
// Photos live in this browser only (like the rest of the data until P1
// cloud sync) and are NOT part of the JSON backup — they're reference
// images, recreatable with one tap each.

const DB_NAME = "store-reorder-photos";
const STORE = "photos";
const MAX_DIM = 512; // longest edge after downscale
const HAS_IDB = typeof indexedDB !== "undefined";

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function downscale(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
}

// Object-URL cache so list rendering doesn't re-read blobs on every render.
const urlCache = new Map();

export async function savePhoto(key, file) {
  if (!HAS_IDB) return;
  const blob = await downscale(file);
  await tx("readwrite", (s) => s.put(blob, key));
  if (urlCache.has(key)) { URL.revokeObjectURL(urlCache.get(key)); urlCache.delete(key); }
}

export async function deletePhoto(key) {
  if (!HAS_IDB) return;
  await tx("readwrite", (s) => s.delete(key));
  if (urlCache.has(key)) { URL.revokeObjectURL(urlCache.get(key)); urlCache.delete(key); }
}

export async function getPhotoURL(key) {
  if (!HAS_IDB) return null;
  if (urlCache.has(key)) return urlCache.get(key);
  const blob = await tx("readonly", (s) => s.get(key)).catch(() => null);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);
  return url;
}

// After a render, fill every `[data-photo]` element that has a stored photo.
// Elements keep their placeholder glyph when no photo exists.
export async function hydratePhotos(root = document) {
  if (!HAS_IDB) return;
  const els = root.querySelectorAll("[data-photo]");
  await Promise.all([...els].map(async (el) => {
    const url = await getPhotoURL(el.dataset.photo);
    if (url) el.innerHTML = `<img src="${url}" alt="">`;
  }));
}

// Neutral bottle glyph shown when no photo has been taken yet.
export const BOTTLE_GLYPH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2h4M10.5 2v4.2c0 .8-2.5 2-2.5 4.3V20a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-9.5c0-2.3-2.5-3.5-2.5-4.3V2"/></svg>`;

export function thumbHtml(key, size = "sm") {
  return `<span class="thumb ${size}" data-photo="${key.replace(/"/g, "&quot;")}">${BOTTLE_GLYPH}</span>`;
}
