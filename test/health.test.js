import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { importExport } from "../app/js/importer.js";
import { inventoryHealth } from "../app/js/reorder.js";

const REAL = readFileSync(new URL("./fixtures/real-format-sample.csv", import.meta.url), "utf8");

describe("inventory health summary", () => {
  test("buckets partition the tracked catalog exactly", () => {
    const { products } = importExport(REAL, {});
    const h = inventoryHealth(products);
    expect(h.tracked).toBeGreaterThan(0);
    expect(h.healthy + h.low + h.out + h.negative).toBe(h.tracked);
    // Dead catalog (no sales, no par) is not tracked.
    const dead = Object.values(products).filter((p) => !(p.avgMonthlyUnits > 0) && p.parUnits == null).length;
    expect(h.tracked + dead).toBe(Object.values(products).filter((p) => p.active !== false).length);
  });

  test("bucket rules: negative < 0, out = 0, low < target, healthy >= target", () => {
    const csv = [
      "BRAND,DESCRIP,SIZE,QTY_ON_HND,FIRST,SECON,THIRD,FOURT,",
      "A,HEALTHY,750ml,50,30,30,30,30,30",
      "B,LOW,750ml,10,30,30,30,30,30",
      "C,OUT,750ml,0,30,30,30,30,30",
      "D,NEGATIVE,750ml,-4,30,30,30,30,30",
      "E,DEAD,750ml,5,0,0,0,0,0",
    ].join("\n");
    const { products } = importExport(csv, {});
    const h = inventoryHealth(products);
    expect(h).toEqual({ healthy: 1, low: 1, out: 1, negative: 1, tracked: 4 });
  });
});
