import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { importExport } from "../app/js/importer.js";

const FIXTURE = readFileSync(
  new URL("../app/demo-data.csv", import.meta.url),
  "utf8",
);

describe("POS export import (plan §3.1, §12)", () => {
  test("imports the full fixture with no bad rows", () => {
    const { products, report } = importExport(FIXTURE, {}, { filename: "fixture.csv" });
    expect(report.ok).toBe(true);
    expect(report.imported).toBe(40);
    expect(report.badRows).toEqual([]);
    expect(Object.keys(products).length).toBe(40);

    const jw = products["080432400630"];
    expect(jw.name).toBe("Johnnie Walker Black");
    expect(jw.packSize).toBe(12);
    expect(jw.onHandUnits).toBe(54);
    expect(jw.distributor).toBe("Southern Glazers");
    expect(jw.parUnits).toBe(null);
  });

  test("re-import preserves par levels (the load-bearing P0a scenario)", () => {
    const first = importExport(FIXTURE, {});
    first.products["080432400630"].parUnits = 60;

    const second = importExport(FIXTURE, first.products);
    expect(second.products["080432400630"].parUnits).toBe(60);
    expect(second.products["080432400630"].onHandUnits).toBe(54);
  });

  test("re-importing the same file twice changes nothing (idempotent)", () => {
    const first = importExport(FIXTURE, {});
    const second = importExport(FIXTURE, first.products);
    expect(second.products).toEqual(first.products);
  });

  test("re-import refreshes on-hand from the new file", () => {
    const first = importExport(FIXTURE, {});
    first.products["080432400630"].parUnits = 60;
    const updated = FIXTURE.replace(
      "080432400630,Johnnie Walker Black,750ml,12,Whiskey,Southern Glazers,54",
      "080432400630,Johnnie Walker Black,750ml,12,Whiskey,Southern Glazers,30",
    );
    const second = importExport(updated, first.products);
    expect(second.products["080432400630"].onHandUnits).toBe(30);
    expect(second.products["080432400630"].parUnits).toBe(60);
  });

  test("bad rows are reported with line numbers, not silently skipped", () => {
    const csv = [
      "Barcode,Description,Size,Pack,Dept,Vendor,On Hand",
      "111,Good Vodka,750ml,12,Vodka,Acme,10",
      ",Missing Barcode,750ml,12,Vodka,Acme,10",
      "222,Bad Pack,750ml,zero,Vodka,Acme,10",
      "333,Bad OnHand,750ml,12,Vodka,Acme,-3",
      "111,Duplicate Barcode,750ml,12,Vodka,Acme,10",
    ].join("\n");
    const { products, report } = importExport(csv, {});
    expect(report.ok).toBe(true);
    expect(report.imported).toBe(1);
    expect(Object.keys(products)).toEqual(["111"]);
    expect(report.badRows).toEqual([
      { line: 3, reason: "missing barcode" },
      { line: 4, reason: 'invalid pack size "zero"' },
      { line: 5, reason: 'invalid on-hand quantity "-3"' },
    ]);
    // Duplicate rows merge quantities (real exports list some SKUs twice).
    expect(report.merged).toBe(1);
    expect(products["111"].onHandUnits).toBe(20);
  });

  test("unrecognized format fails loudly and keeps existing data", () => {
    const existing = importExport(FIXTURE, {}).products;
    const { products, report } = importExport("Wrong,Header\n1,2", existing);
    expect(report.ok).toBe(false);
    expect(report.error).toContain("unrecognized export format");
    expect(products).toEqual(existing);
  });

  test("empty file fails loudly", () => {
    const { report } = importExport("", {});
    expect(report.ok).toBe(false);
  });

  test("products missing from a new export are marked inactive", () => {
    const first = importExport(FIXTURE, {});
    first.products["721733000029"].parUnits = 24; // Malibu
    const withoutMalibu = FIXTURE.split("\n").filter((l) => !l.startsWith("721733000029")).join("\n");
    const second = importExport(withoutMalibu, first.products);
    expect(second.report.delisted).toBe(1);
    expect(second.products["721733000029"].active).toBe(false);
    // Everything still present stays active.
    expect(second.products["080432400630"].active).toBe(true);
  });

  test("a returning product is reactivated with its par intact", () => {
    const first = importExport(FIXTURE, {});
    first.products["721733000029"].parUnits = 24;
    const withoutMalibu = FIXTURE.split("\n").filter((l) => !l.startsWith("721733000029")).join("\n");
    const second = importExport(withoutMalibu, first.products);
    const third = importExport(FIXTURE, second.products);
    expect(third.products["721733000029"].active).toBe(true);
    expect(third.products["721733000029"].parUnits).toBe(24);
    expect(third.report.delisted).toBe(0);
  });

  test("a broken row does not delist its product", () => {
    const first = importExport(FIXTURE, {});
    const corrupted = FIXTURE.replace(
      "721733000029,Malibu Coconut,750ml,12,Rum,RNDC,18",
      "721733000029,Malibu Coconut,750ml,BAD,Rum,RNDC,18",
    );
    const second = importExport(corrupted, first.products);
    expect(second.report.badRows.length).toBe(1);
    expect(second.report.delisted).toBe(0);
    // Keeps last known good data, still active.
    expect(second.products["721733000029"].active).toBe(true);
    expect(second.products["721733000029"].onHandUnits).toBe(18);
  });
});
