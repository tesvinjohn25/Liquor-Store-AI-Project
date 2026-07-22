// StorageAdapter — the seam the plan requires (§3): P0a uses localStorage,
// P1 swaps in cloud sync behind the same interface. The backing store is
// injectable so tests run without a browser.

const KEY = "store-reorder-v1";

export const EMPTY_STATE = Object.freeze({
  products: {},
  lastImport: null, // { at, filename, imported, badRows }
  lastBackupAt: null,
  storeName: "",
});

export class StorageAdapter {
  constructor(backend) {
    this.backend = backend ?? globalThis.localStorage;
  }

  load() {
    const raw = this.backend.getItem(KEY);
    if (!raw) return structuredClone(EMPTY_STATE);
    try {
      const parsed = JSON.parse(raw);
      return { ...structuredClone(EMPTY_STATE), ...parsed };
    } catch {
      // Corrupt storage must not brick the app; the backup file is the
      // recovery path (plan §13, local MVP data loss).
      return structuredClone(EMPTY_STATE);
    }
  }

  save(state) {
    this.backend.setItem(KEY, JSON.stringify(state));
  }
}

// Map-backed backend for tests.
export class MemoryBackend {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
}
