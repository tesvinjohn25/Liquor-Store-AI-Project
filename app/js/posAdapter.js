// ============================================================================
// RELINK POINT — the only file that knows what POS exports look like.
//
// Two formats are supported and auto-detected from the header row:
//
//  - REAL_EXPORT_FORMAT ("liquorpos-v1"): the store's actual LiquorPOS
//    item-movement export (BRAND, DESCRIP, SIZE, QTY_ON_HND, FIRST..FOURT =
//    the last four months' unit sales; the unnamed last column is the
//    4-month average, which we recompute ourselves rather than trust).
//    No barcode / pack size / vendor yet — the owner confirmed those can be
//    added to the export later; when they arrive, extend this format and
//    nothing outside this file changes.
//
//  - FAKE_EXPORT_FORMAT ("fake-v1"): the synthetic demo file
//    (app/demo-data.csv), barcode-keyed, used by the demo button and tests.
// ============================================================================

export const FAKE_EXPORT_FORMAT = {
  id: "fake-v1",
  label: "Synthetic demo export",
  columns: {
    barcode: "Barcode",
    name: "Description",
    size: "Size",
    packSize: "Pack",
    distributor: "Vendor",
    section: "Dept",
    onHand: "On Hand",
  },
};

export const REAL_EXPORT_FORMAT = {
  id: "liquorpos-v1",
  label: "LiquorPOS item export",
  columns: {
    brand: "BRAND",
    descrip: "DESCRIP",
    size: "SIZE",
    onHand: "QTY_ON_HND",
    m1: "FIRST",
    m2: "SECON",
    m3: "THIRD",
    m4: "FOURT",
  },
};

const FORMATS = [REAL_EXPORT_FORMAT, FAKE_EXPORT_FORMAT];

// Pick the format whose expected columns all appear in the header.
export function detectFormat(header) {
  for (const f of FORMATS) {
    if (Object.values(f.columns).every((c) => header.includes(c))) return f;
  }
  return null;
}

export function missingColumns(header) {
  // For the error message, report against the closest format (most matches).
  let best = FORMATS[0], bestHits = -1;
  for (const f of FORMATS) {
    const hits = Object.values(f.columns).filter((c) => header.includes(c)).length;
    if (hits > bestHits) { best = f; bestHits = hits; }
  }
  return Object.values(best.columns).filter((c) => !header.includes(c));
}

const intOrNull = (raw) => {
  if (raw === "" || raw == null) return 0; // blank month cell = no sales
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
};

// Normalize one raw CSV record into the app's internal product shape.
// Returns { product } or { error } — never throws on bad data.
export function normalizeRow(rec, format) {
  const col = format.columns;
  const get = (key) => rec[col[key]] ?? "";

  if (format.id === "liquorpos-v1") {
    const brand = get("brand");
    const descrip = get("descrip");
    const size = String(get("size"));
    if (!brand && !descrip) return { error: "missing brand and description" };

    const onHand = intOrNull(get("onHand"));
    if (onHand === null) return { error: `invalid on-hand quantity "${get("onHand")}"` };

    const months = [intOrNull(get("m1")), intOrNull(get("m2")), intOrNull(get("m3")), intOrNull(get("m4"))];
    if (months.some((m) => m === null)) return { error: "invalid monthly sales value" };

    const name = [brand, descrip].filter(Boolean).join(" ");
    return {
      product: {
        // No barcode in this export yet: identity is brand|descrip|size.
        barcode: `${brand}|${descrip}|${size}`,
        name,
        size,
        packSize: 1,               // unknown until the export includes it
        distributor: "",           // unknown until the export includes it
        section: (brand[0] || "#").toUpperCase(), // A–Z browsing groups
        onHandUnits: onHand,       // negatives kept — they mean "fix inventory"
        salesMonths: months,
        avgMonthlyUnits: (months[0] + months[1] + months[2] + months[3]) / 4,
      },
    };
  }

  // fake-v1
  const barcode = get("barcode");
  const name = get("name");
  const packRaw = get("packSize");
  const onHandRaw = get("onHand");
  if (!barcode) return { error: "missing barcode" };
  if (!name) return { error: "missing description" };
  const packSize = Number(packRaw);
  if (!Number.isInteger(packSize) || packSize < 1) return { error: `invalid pack size "${packRaw}"` };
  const onHandUnits = Number(onHandRaw);
  if (!Number.isFinite(onHandUnits) || onHandUnits < 0 || !Number.isInteger(onHandUnits)) {
    return { error: `invalid on-hand quantity "${onHandRaw}"` };
  }
  return {
    product: {
      barcode,
      name,
      size: get("size"),
      packSize,
      distributor: get("distributor") || "(no distributor)",
      section: get("section") || "(no section)",
      onHandUnits,
      salesMonths: null,
      avgMonthlyUnits: null,
    },
  };
}
