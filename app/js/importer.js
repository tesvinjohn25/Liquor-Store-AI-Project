import { parseCsvWithHeader } from "./csv.js";
import { detectFormat, missingColumns, normalizeRow } from "./posAdapter.js";

// Import a POS export (format auto-detected from the header). Merges into
// the existing product map by product key: POS-owned fields (name, size,
// on-hand, sales) refresh; app-owned fields (par) always survive re-imports.
//
// Real-export realities handled here:
//  - duplicate keys (same brand/descrip/size listed twice) are merged by
//    summing on-hand and monthly sales — reported, not dropped;
//  - negative on-hand is VALID data ("sold before the inventory update") —
//    imported as-is and counted in report.negativeOnHand so the UI can flag
//    the items needing an inventory fix;
//  - products absent from the export are delisted (hidden, par kept).
export function importExport(csvText, existingProducts = {}, meta = {}) {
  const { header, records } = parseCsvWithHeader(csvText);

  const format = header.length ? detectFormat(header) : null;
  if (!format) {
    return {
      products: existingProducts,
      report: {
        ok: false,
        error: header.length === 0
          ? "file is empty"
          : `unrecognized export format — missing column(s): ${missingColumns(header).join(", ")}`,
        imported: 0,
        badRows: [],
      },
    };
  }

  const products = { ...existingProducts };
  const seenKeys = new Set();
  const badRowKeys = new Set();
  const badRows = [];
  let imported = 0;
  let merged = 0;

  for (const rec of records) {
    const result = normalizeRow(rec, format);
    if (result.error) {
      badRows.push({ line: rec.__line, reason: result.error });
      // If the broken row still identifies a product, don't delist it below.
      const bc = format.id === "liquorpos-v1"
        ? `${rec[format.columns.brand] ?? ""}|${rec[format.columns.descrip] ?? ""}|${rec[format.columns.size] ?? ""}`
        : rec[format.columns.barcode];
      if (bc) badRowKeys.add(bc);
      continue;
    }
    const p = result.product;

    if (seenKeys.has(p.barcode)) {
      // Same key twice in one export (real data does this): merge quantities.
      const prev = products[p.barcode];
      prev.onHandUnits += p.onHandUnits;
      if (prev.salesMonths && p.salesMonths) {
        prev.salesMonths = prev.salesMonths.map((v, i) => v + p.salesMonths[i]);
        prev.avgMonthlyUnits = prev.salesMonths.reduce((a, b) => a + b, 0) / 4;
      }
      merged++;
      continue;
    }
    seenKeys.add(p.barcode);

    const existing = products[p.barcode];
    products[p.barcode] = {
      ...p,
      parUnits: existing?.parUnits ?? null, // app-owned: survives re-import
      active: true,
    };
    imported++;
  }

  // Delist products absent from this export (kept, hidden, par preserved).
  let delisted = 0;
  for (const [key, p] of Object.entries(products)) {
    if (seenKeys.has(key) || badRowKeys.has(key)) continue;
    if (p.active !== false) delisted++;
    products[key] = { ...p, active: false };
  }

  const negativeOnHand = Object.values(products)
    .filter((p) => p.active !== false && p.onHandUnits < 0).length;

  return {
    products,
    report: {
      ok: true,
      imported,
      merged,
      badRows,
      delisted,
      negativeOnHand,
      formatId: format.id,
      formatLabel: format.label,
      filename: meta.filename ?? null,
      importedAt: meta.importedAt ?? new Date().toISOString(),
    },
  };
}
