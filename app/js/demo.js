import { importExport } from "./importer.js";

// Par levels (in base units) applied by "Load demo data" so the low-stock
// list and order sheets have something to show immediately. Several
// distributors are deliberately left short; most products get no par so the
// "set par" prompt is visible too.
export const DEMO_PARS = {
  "080432400630": 60, // Johnnie Walker Black, on hand 54 → 1 cs (Southern Glazers)
  "087116066601": 24, // Grey Goose, on hand 19 → 1 cs (Southern Glazers)
  "721059001106": 24, // Buffalo Trace, on hand 0 → 2 cs (RNDC)
  "811538013666": 18, // Espolon Blanco pack 6, on hand 12 → 1 cs (RNDC)
  "811175030039": 12, // Casamigos Blanco pack 6, on hand 4 → 2 cs (Empire)
  "098611030025": 12, // Grand Marnier, on hand 6 → 1 cs (Empire)
  "071990095618": 20, // Heineken 12pk pack 2, on hand 8 → 6 cs (City Beverage)
  "031259247223": 60, // Titos 750ml, on hand 88 → comfortably above par
};

// Replaces the current state's products with the bundled demo export.
export async function loadDemoData() {
  const res = await fetch("demo-data.csv");
  if (!res.ok) throw new Error(`could not fetch demo data (HTTP ${res.status})`);
  const text = await res.text();
  const { products, report } = importExport(text, {}, { filename: "demo-data.csv" });
  if (!report.ok) throw new Error(report.error);
  for (const [barcode, parUnits] of Object.entries(DEMO_PARS)) {
    if (products[barcode]) products[barcode].parUnits = parUnits;
  }
  return { products, report };
}
