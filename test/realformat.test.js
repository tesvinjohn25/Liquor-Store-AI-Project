import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { importExport } from "../app/js/importer.js";
import { lowStock, lowStockTiers, TIER_FAST, TIER_STEADY, needsInventoryFix, effectivePar, orderSuggestions } from "../app/js/reorder.js";
import { sheetText, explainSuggestion } from "../app/js/ordersheet.js";

// Anonymized sample with the REAL LiquorPOS export structure: BRAND, DESCRIP,
// SIZE, QTY_ON_HND, FIRST..FOURT (4 months' sales), unnamed avg column.
// Includes the real file's quirks: negative on-hand, duplicate keys, typos,
// dead items, 22 size formats.
const REAL = readFileSync(new URL("./fixtures/real-format-sample.csv", import.meta.url), "utf8");

describe("real LiquorPOS format", () => {
  const { products, report } = importExport(REAL, {}, { filename: "real.csv" });

  test("format is auto-detected and imports cleanly", () => {
    expect(report.ok).toBe(true);
    expect(report.formatId).toBe("liquorpos-v1");
    expect(report.badRows).toEqual([]);
    expect(report.imported).toBeGreaterThan(100);
  });

  test("identity is brand|descrip|size; name combines brand + descrip", () => {
    const p = Object.values(products).find((x) => x.barcode.startsWith("100 ANOS|BLANCO|"));
    expect(p).toBeDefined();
    expect(p.name).toBe("100 ANOS BLANCO");
    expect(p.packSize).toBe(1); // unknown until the export includes it
  });

  test("average monthly sales is recomputed from the four month columns", () => {
    for (const p of Object.values(products)) {
      if (!p.salesMonths) continue;
      const expected = p.salesMonths.reduce((a, b) => a + b, 0) / 4;
      expect(p.avgMonthlyUnits).toBe(expected);
    }
  });

  test("duplicate keys are merged by summing quantities, and reported", () => {
    expect(report.merged).toBeGreaterThan(0);
    // No duplicate keys can survive in the product map (it's keyed by them).
    expect(Object.keys(products).length).toBe(report.imported);
  });

  test("negative on-hand imports as-is and is counted for the fix list", () => {
    expect(report.negativeOnHand).toBeGreaterThan(0);
    const negs = needsInventoryFix(products);
    expect(negs.length).toBe(report.negativeOnHand);
    for (const p of negs) expect(p.onHandUnits).toBeLessThan(0);
  });

  test("owner's rule: low when on-hand < average monthly sales (cover = 1)", () => {
    const low = lowStock(products, 1);
    expect(low.length).toBeGreaterThan(0);
    for (const p of low) {
      expect(Math.max(0, p.onHandUnits)).toBeLessThan(Math.ceil(p.avgMonthlyUnits ?? p.parUnits));
    }
    // And products at/above a month of cover are NOT flagged.
    for (const p of Object.values(products)) {
      if (p.avgMonthlyUnits > 0 && p.parUnits == null && p.onHandUnits >= Math.ceil(p.avgMonthlyUnits)) {
        expect(low.find((l) => l.barcode === p.barcode)).toBeUndefined();
      }
    }
  });

  test("dead catalog (no sales, no par) never alerts — kept for special orders", () => {
    const dead = Object.values(products).filter((p) => p.avgMonthlyUnits === 0 && p.parUnits == null);
    expect(dead.length).toBeGreaterThan(0);
    const lowKeys = new Set(lowStock(products, 1).map((p) => p.barcode));
    for (const p of dead) {
      expect(lowKeys.has(p.barcode)).toBe(false);
    }
  });

  test("manual par overrides the auto target", () => {
    const p = Object.values(products).find((x) => x.avgMonthlyUnits > 0);
    expect(effectivePar(p, 1)).toBe(Math.ceil(p.avgMonthlyUnits));
    p.parUnits = 999;
    expect(effectivePar(p, 1)).toBe(999);
    p.parUnits = null;
  });

  test("cover months scales the auto target", () => {
    const p = Object.values(products).find((x) => x.avgMonthlyUnits >= 4);
    expect(effectivePar(p, 2)).toBe(Math.ceil(p.avgMonthlyUnits * 2));
  });

  test("suggested quantity refills to the target in units (pack unknown)", () => {
    for (const p of lowStock(products, 1)) {
      expect(p.suggestedCases).toBe(p.effParUnits - Math.max(0, p.onHandUnits));
      expect(p.suggestedCases).toBeGreaterThan(0);
    }
  });

  test("order sheet uses plain units and a single list when vendor is unknown", () => {
    const groups = orderSuggestions(products, 1);
    expect(groups.length).toBe(1);
    expect(groups[0].distributor).toBe("Order list");
    const text = sheetText(groups[0], { date: "2026-07-22" });
    const line = groups[0].lines[0];
    expect(text).toContain(`${line.suggestedCases} — ${line.name} ${line.size}`);
    expect(text).not.toContain(" cs —");
  });

  test("auto-target explanation shows the sales math", () => {
    const [item] = lowStock(products, 1);
    expect(explainSuggestion(item)).toBe(
      `sells ~${item.avgMonthlyUnits}/mo − on hand ${Math.max(0, item.onHandUnits)} → order ${item.suggestedCases}`,
    );
  });

  test("low list is sorted by urgency (runway ascending), velocity breaking ties", () => {
    const low = lowStock(products, 1);
    for (let i = 1; i < low.length; i++) {
      const prev = low[i - 1], cur = low[i];
      expect(prev.runway).toBeLessThanOrEqual(cur.runway);
      if (prev.runway === cur.runway) {
        expect(prev.avgMonthlyUnits).toBeGreaterThanOrEqual(cur.avgMonthlyUnits);
      }
    }
  });

  test("the owner's example: empty shelf outranks a faster seller with stock", () => {
    const csv = [
      "BRAND,DESCRIP,SIZE,QTY_ON_HND,FIRST,SECON,THIRD,FOURT,",
      "NEW AMSTERDAM,PINK WHITNEY,50ml,191,300,350,340,360,337.5",   // 191 on hand, huge seller
      "CLASSIFIED,SAV BLANC,750ml,0,70,68,72,70,70",                  // OUT, solid seller
    ].join("\n");
    const r = importExport(csv, {});
    const low = lowStock(r.products, 1);
    expect(low[0].name).toBe("CLASSIFIED SAV BLANC");   // out now → first
    expect(low[0].runwayDays).toBe(0);
    expect(low[1].name).toBe("NEW AMSTERDAM PINK WHITNEY");
    expect(low[1].runwayDays).toBeGreaterThan(10);      // ~17 days of cover
    // Both are still fast movers — the tier doesn't change, only the order.
    const t = lowStockTiers(r.products, 1);
    expect(t.fast.map((p) => p.name)).toEqual(["CLASSIFIED SAV BLANC", "NEW AMSTERDAM PINK WHITNEY"]);
  });

  test("tiers split by velocity; slow tier holds the under-6/mo items", () => {
    const t = lowStockTiers(products, 1);
    expect(t.fast.length + t.steady.length + t.slow.length).toBe(t.all.length);
    for (const p of t.fast) expect(p.avgMonthlyUnits).toBeGreaterThanOrEqual(TIER_FAST);
    for (const p of t.steady) expect(p.avgMonthlyUnits).toBeGreaterThanOrEqual(TIER_STEADY);
    for (const p of t.slow) {
      expect(p.avgMonthlyUnits).toBeLessThan(TIER_STEADY);
      expect(p.parSource).toBe("auto");
      expect(p.monthsActive).toBeGreaterThanOrEqual(0); // limited-edition tag data
    }
  });

  test("a manual par promotes a slow item out of the slow tier", () => {
    const t1 = lowStockTiers(products, 1);
    const slowItem = t1.slow[0];
    expect(slowItem).toBeDefined();
    products[slowItem.barcode].parUnits = slowItem.effParUnits + 5;
    const t2 = lowStockTiers(products, 1);
    expect(t2.slow.find((p) => p.barcode === slowItem.barcode)).toBeUndefined();
    expect([...t2.fast, ...t2.steady].find((p) => p.barcode === slowItem.barcode)).toBeDefined();
    products[slowItem.barcode].parUnits = null;
  });

  test("re-import preserves manual pars and stays idempotent", () => {
    const first = importExport(REAL, {});
    const key = Object.keys(first.products)[0];
    first.products[key].parUnits = 42;
    const second = importExport(REAL, first.products);
    expect(second.products[key].parUnits).toBe(42);
    expect(second.report.delisted).toBe(0);
    const third = importExport(REAL, second.products);
    expect(third.products).toEqual(second.products);
  });

  test("blank month cells count as zero sales, not bad rows", () => {
    const csv = "BRAND,DESCRIP,SIZE,QTY_ON_HND,FIRST,SECON,THIRD,FOURT,\nTEST,ITEM,750ml,5,,,2,,0.5\n";
    const r = importExport(csv, {});
    expect(r.report.ok).toBe(true);
    expect(r.report.badRows).toEqual([]);
    const p = Object.values(r.products)[0];
    expect(p.salesMonths).toEqual([0, 0, 2, 0]);
    expect(p.avgMonthlyUnits).toBe(0.5);
  });
});
