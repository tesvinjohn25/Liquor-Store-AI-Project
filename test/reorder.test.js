import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { importExport } from "../app/js/importer.js";
import { shortageUnits, suggestedCases, lowStock, orderSuggestions } from "../app/js/reorder.js";
import { sheetText, explainSuggestion } from "../app/js/ordersheet.js";

const FIXTURE = readFileSync(
  new URL("../app/demo-data.csv", import.meta.url),
  "utf8",
);

function loadWithPars(pars) {
  const { products } = importExport(FIXTURE, {});
  for (const [barcode, parUnits] of Object.entries(pars)) {
    products[barcode].parUnits = parUnits;
  }
  return products;
}

describe("reorder math (plan §4.4, §10, §12)", () => {
  test("plan worked example: par 5 cs, on hand 4 cs 6 btl, pack 12 → 1 case", () => {
    const p = { parUnits: 60, onHandUnits: 54, packSize: 12 };
    expect(shortageUnits(p)).toBe(6);
    expect(suggestedCases(p)).toBe(1);
  });

  test("suggestions are never negative and always whole cases", () => {
    for (let par = 0; par <= 40; par++) {
      for (let onHand = 0; onHand <= 40; onHand++) {
        for (const pack of [1, 2, 6, 12]) {
          const cases = suggestedCases({ parUnits: par, onHandUnits: onHand, packSize: pack });
          expect(cases).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(cases)).toBe(true);
          // Ordering the suggestion always reaches or exceeds par.
          if (par > onHand) expect(onHand + cases * pack).toBeGreaterThanOrEqual(par);
          // Never overshoot by a full pack or more.
          if (par > onHand) expect(onHand + (cases - 1) * pack).toBeLessThan(par);
        }
      }
    }
  });

  test("at or above par → no suggestion", () => {
    expect(suggestedCases({ parUnits: 24, onHandUnits: 24, packSize: 12 })).toBe(0);
    expect(suggestedCases({ parUnits: 24, onHandUnits: 30, packSize: 12 })).toBe(0);
  });

  test("products without a par are excluded from low stock", () => {
    const products = loadWithPars({ "080432400630": 60 });
    const low = lowStock(products);
    expect(low.length).toBe(1);
    expect(low[0].barcode).toBe("080432400630");
    expect(low[0].suggestedCases).toBe(1);
  });

  test("low list sorts by urgency: emptiest shelf first", () => {
    // Buffalo Trace at 0/24 (runway 0) outranks Johnnie Walker at 54/60.
    const products = loadWithPars({ "080432400630": 60, "721059001106": 24 });
    const low = lowStock(products);
    expect(low.map((p) => p.barcode)).toEqual(["721059001106", "080432400630"]);
  });

  test("inactive (delisted) products are excluded from all lists", () => {
    const products = loadWithPars({ "080432400630": 60, "721059001106": 24 });
    products["080432400630"].active = false; // delist Johnnie Walker (below par)
    products["721059001106"].active = false; // delist Buffalo Trace (zero stock)
    expect(lowStock(products).length).toBe(0);
    expect(orderSuggestions(products).length).toBe(0);
  });

  test("suggestions group by distributor, sorted", () => {
    const products = loadWithPars({
      "080432400630": 60,  // Johnnie Walker Black — Southern Glazers, short 6 → 1 cs
      "721059001106": 24,  // Buffalo Trace — RNDC, on hand 0 → 2 cs
      "811538013666": 18,  // Espolon Blanco pack 6 — RNDC, on hand 12 → 1 cs
      "031259247223": 60,  // Titos — RNDC, on hand 88 → not low
    });
    const groups = orderSuggestions(products);
    expect(groups.map((g) => g.distributor)).toEqual(["RNDC", "Southern Glazers"]);
    const rndc = groups[0];
    expect(rndc.lines.map((l) => [l.name, l.suggestedCases])).toEqual([
      ["Buffalo Trace", 2],
      ["Espolon Blanco", 1],
    ]);
  });

  test("golden master: order sheet text is stable", () => {
    const products = loadWithPars({
      "721059001106": 24,
      "811538013666": 18,
    });
    const [rndc] = orderSuggestions(products);
    const text = sheetText(rndc, { storeName: "Store A", date: "2026-07-22" });
    expect(text).toBe(
      [
        "ORDER — RNDC",
        "Store A",
        "2026-07-22",
        "",
        "2 cs — Buffalo Trace 750ml",
        "1 cs — Espolon Blanco 750ml",
        "",
        "2 items",
      ].join("\n"),
    );
  });

  test("suggestion explanation shows the arithmetic (plan §10.10)", () => {
    const products = loadWithPars({ "080432400630": 60 });
    const [item] = lowStock(products);
    expect(explainSuggestion(item)).toBe(
      "par 5 cs − on hand 4 cs 6 btl = short 6 → 1 cs (pack of 12)",
    );
  });
});
