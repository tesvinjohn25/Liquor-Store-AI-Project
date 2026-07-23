import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { importExport } from "../app/js/importer.js";
import { orderDeadlines, deadlineBuckets, DEFAULT_LEAD_TIME_DAYS } from "../app/js/reorder.js";

const REAL = readFileSync(new URL("./fixtures/real-format-sample.csv", import.meta.url), "utf8");
const DEMO = readFileSync(new URL("../app/demo-data.csv", import.meta.url), "utf8");
const NOW = Date.UTC(2026, 6, 23); // fixed clock so dates are deterministic
const DAY = 86400000;

describe("order deadlines (must-order-by)", () => {
  const { products } = importExport(REAL, {});

  test("below-target items are overdue; above-target sellers get future dates", () => {
    const items = orderDeadlines(products, { now: NOW });
    expect(items.length).toBeGreaterThan(0);
    for (const p of items) {
      const onHand = Math.max(0, p.onHandUnits);
      if (onHand < p.effParUnits) {
        expect(p.daysUntilOrder).toBeLessThanOrEqual(0);
      } else {
        expect(p.daysUntilOrder).toBeGreaterThanOrEqual(-DEFAULT_LEAD_TIME_DAYS);
      }
    }
  });

  test("deadline math: floor((onHand − target) / daily) − lead time", () => {
    const csv = [
      "BRAND,DESCRIP,SIZE,QTY_ON_HND,FIRST,SECON,THIRD,FOURT,",
      "TEST,STEADY SELLER,750ml,90,30,30,30,30,30", // target 30, daily 1 → (90−30)/1 = 60 − 3 lead = 57
    ].join("\n");
    const r = importExport(csv, {});
    const [item] = orderDeadlines(r.products, { now: NOW });
    expect(item.daysUntilOrder).toBe(57);
    expect(item.deadlineDate).toBe(new Date(NOW + 57 * DAY).toISOString().slice(0, 10));
  });

  test("longer lead time pulls every deadline earlier", () => {
    const short = orderDeadlines(products, { now: NOW, leadTimeDays: 0 });
    const long = orderDeadlines(products, { now: NOW, leadTimeDays: 7 });
    const shortMap = new Map(short.map((p) => [p.barcode, p.daysUntilOrder]));
    for (const p of long) {
      const s = shortMap.get(p.barcode);
      if (p.avgMonthlyUnits > 0) expect(p.daysUntilOrder).toBe(s - 7);
    }
  });

  test("dead catalog (no sales, no par) has no deadline", () => {
    const items = orderDeadlines(products, { now: NOW });
    for (const p of items) {
      expect(p.avgMonthlyUnits > 0 || p.parUnits != null).toBe(true);
    }
  });

  test("slow movers (auto, under 6/mo) are excluded — special-order stock", () => {
    const items = orderDeadlines(products, { now: NOW });
    for (const p of items) {
      if (p.parSource === "auto") expect(p.avgMonthlyUnits).toBeGreaterThanOrEqual(6);
    }
    // A manual par opts a slow item back in.
    const slow = Object.values(products).find((x) => x.avgMonthlyUnits > 0 && x.avgMonthlyUnits < 6 && x.parUnits == null);
    expect(slow).toBeDefined();
    expect(items.find((x) => x.barcode === slow.barcode)).toBeUndefined();
    slow.parUnits = Math.max(0, slow.onHandUnits) + 10;
    const items2 = orderDeadlines(products, { now: NOW });
    expect(items2.find((x) => x.barcode === slow.barcode)).toBeDefined();
    slow.parUnits = null;
  });

  test("buckets partition by days and sort soonest-first", () => {
    const b = deadlineBuckets(products, { now: NOW });
    expect(b.overdue.length + b.week.length + b.twoWeeks.length + b.month.length + b.later.length)
      .toBe(b.all.length);
    for (const p of b.overdue) expect(p.daysUntilOrder).toBeLessThanOrEqual(0);
    for (const p of b.week) { expect(p.daysUntilOrder).toBeGreaterThan(0); expect(p.daysUntilOrder).toBeLessThanOrEqual(7); }
    for (const p of b.twoWeeks) { expect(p.daysUntilOrder).toBeGreaterThan(7); expect(p.daysUntilOrder).toBeLessThanOrEqual(14); }
    for (const p of b.month) { expect(p.daysUntilOrder).toBeGreaterThan(14); expect(p.daysUntilOrder).toBeLessThanOrEqual(30); }
    for (const p of b.later) expect(p.daysUntilOrder).toBeGreaterThan(30);
    for (let i = 1; i < b.all.length; i++) {
      expect(b.all[i - 1].daysUntilOrder).toBeLessThanOrEqual(b.all[i].daysUntilOrder);
    }
  });

  test("demo data: manual par below target is due today; no-clock items excluded", () => {
    const r = importExport(DEMO, {});
    r.products["721059001106"].parUnits = 24; // Buffalo Trace, on hand 0
    r.products["080432400630"].parUnits = 30; // Johnnie Walker, on hand 54 (above par, no sales data)
    const items = orderDeadlines(r.products, { now: NOW });
    expect(items.map((p) => p.barcode)).toEqual(["721059001106"]);
    expect(items[0].daysUntilOrder).toBe(0);
    expect(items[0].suggestedCases).toBe(2);
  });
});
