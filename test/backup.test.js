import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { importExport } from "../app/js/importer.js";
import { exportBackup, importBackup } from "../app/js/backup.js";
import { StorageAdapter, MemoryBackend, EMPTY_STATE } from "../app/js/store.js";

const FIXTURE = readFileSync(
  new URL("../app/demo-data.csv", import.meta.url),
  "utf8",
);

describe("backup round-trip (plan §3.6, §12)", () => {
  test("export then import reproduces the exact state", () => {
    const { products, report } = importExport(FIXTURE, {}, { filename: "fixture.csv" });
    products["080432400630"].parUnits = 60;
    const state = {
      products,
      lastImport: { at: report.importedAt, filename: "fixture.csv", imported: 40, badRows: [] },
      lastBackupAt: null,
      storeName: "Store A",
    };
    const restored = importBackup(exportBackup(state));
    expect(restored.error).toBeUndefined();
    expect(restored.state).toEqual(state);
  });

  test("rejects garbage, foreign files, and versionless JSON", () => {
    expect(importBackup("not json").error).toBeDefined();
    expect(importBackup('{"app":"other"}').error).toBeDefined();
    expect(importBackup('{"app":"store-reorder","version":99,"state":{}}').error).toBeDefined();
  });
});

describe("StorageAdapter (plan §3 seam)", () => {
  test("save/load round-trip through a backend", () => {
    const adapter = new StorageAdapter(new MemoryBackend());
    const state = { ...structuredClone(EMPTY_STATE), storeName: "Store A" };
    adapter.save(state);
    expect(adapter.load()).toEqual(state);
  });

  test("empty backend yields empty state", () => {
    const adapter = new StorageAdapter(new MemoryBackend());
    expect(adapter.load()).toEqual(EMPTY_STATE);
  });

  test("corrupt storage does not brick the app", () => {
    const backend = new MemoryBackend();
    backend.setItem("store-reorder-v1", "{corrupt");
    const adapter = new StorageAdapter(backend);
    expect(adapter.load()).toEqual(EMPTY_STATE);
  });
});
