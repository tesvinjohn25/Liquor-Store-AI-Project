// Deterministic reorder math.
//
// The owner's confirmed rule: reorder when on-hand falls below the average
// monthly sales. That is the default here — the "effective par" for a
// product is its manual par if the owner set one, otherwise
// ceil(avgMonthlySales × coverMonths) with coverMonths defaulting to 1.
// Dead-catalog items (no sales, no manual par) never alert: the owner keeps
// them on purpose for rare special orders.
//
// Negative on-hand (sold before the inventory update) counts as 0 in the
// math and is surfaced separately via needsInventoryFix().

export const DEFAULT_COVER_MONTHS = 1;

function activeProducts(products) {
  return Object.values(products).filter((p) => p.active !== false);
}

export function effectiveOnHand(p) {
  return Math.max(0, p.onHandUnits);
}

// Manual par wins; otherwise derived from sales velocity; null = no target.
export function effectivePar(p, coverMonths = DEFAULT_COVER_MONTHS) {
  if (p.parUnits != null) return p.parUnits;
  if (p.avgMonthlyUnits > 0) return Math.ceil(p.avgMonthlyUnits * coverMonths);
  return null;
}

export function parSource(p) {
  if (p.parUnits != null) return "manual";
  if (p.avgMonthlyUnits > 0) return "auto";
  return null;
}

export function shortageUnits(p, coverMonths = DEFAULT_COVER_MONTHS) {
  const par = effectivePar(p, coverMonths);
  if (par == null) return 0;
  return Math.max(0, par - effectiveOnHand(p));
}

export function suggestedCases(p, coverMonths = DEFAULT_COVER_MONTHS) {
  const s = shortageUnits(p, coverMonths);
  if (s <= 0) return 0;
  return Math.ceil(s / p.packSize);
}

// Sorted by URGENCY: runway (fraction of the target still on the shelf)
// ascending — an empty shelf on a 70/mo wine outranks a fast seller that
// still has weeks of stock. Velocity breaks ties, so among the empty
// shelves the fastest seller is first.
export function lowStock(products, coverMonths = DEFAULT_COVER_MONTHS) {
  return activeProducts(products)
    .filter((p) => {
      const par = effectivePar(p, coverMonths);
      return par != null && par > 0 && effectiveOnHand(p) < par;
    })
    .map((p) => {
      const effParUnits = effectivePar(p, coverMonths);
      return {
        ...p,
        effParUnits,
        parSource: parSource(p),
        shortageUnits: shortageUnits(p, coverMonths),
        suggestedCases: suggestedCases(p, coverMonths),
        monthsActive: p.salesMonths ? p.salesMonths.filter((m) => m > 0).length : null,
        runway: effectiveOnHand(p) / effParUnits, // 0 = out now, 1 = at target
        runwayDays: p.avgMonthlyUnits > 0
          ? Math.round(effectiveOnHand(p) / (p.avgMonthlyUnits / 30))
          : null,
      };
    })
    .sort((a, b) =>
      a.runway - b.runway ||
      (b.avgMonthlyUnits ?? -1) - (a.avgMonthlyUnits ?? -1) ||
      a.name.localeCompare(b.name));
}

// Priority tiers for the Low Stock screen. Slow movers (auto-flagged, under
// TIER_STEADY sales/month — where limited editions live) are separated so
// they never drown the list; a manual par always promotes an item to
// priority, because the owner set it on purpose.
export const TIER_FAST = 30;
export const TIER_STEADY = 6;

export function lowStockTiers(products, coverMonths = DEFAULT_COVER_MONTHS) {
  const all = lowStock(products, coverMonths);
  const fast = [], steady = [], slow = [];
  for (const p of all) {
    if (p.parSource === "auto" && p.avgMonthlyUnits < TIER_STEADY) slow.push(p);
    else if ((p.avgMonthlyUnits ?? 0) >= TIER_FAST) fast.push(p);
    else steady.push(p);
  }
  return { fast, steady, slow, all };
}

// Products whose on-hand is negative: the inventory record needs fixing.
export function needsInventoryFix(products) {
  return activeProducts(products)
    .filter((p) => p.onHandUnits < 0)
    .sort((a, b) => a.onHandUnits - b.onHandUnits);
}

// "Set par" prompts only matter for exports without sales history (the demo
// format) — with real sales data the auto par covers everything that moves.
export function unsetPar(products) {
  return activeProducts(products)
    .filter((p) => p.parUnits == null && p.avgMonthlyUnits == null);
}

export function orderSuggestions(products, coverMonths = DEFAULT_COVER_MONTHS) {
  const byDistributor = new Map();
  for (const item of lowStock(products, coverMonths)) {
    if (item.suggestedCases <= 0) continue;
    const key = item.distributor || "Order list";
    if (!byDistributor.has(key)) byDistributor.set(key, []);
    byDistributor.get(key).push(item);
  }
  return [...byDistributor.entries()]
    .map(([distributor, lines]) => ({
      distributor,
      lines: lines.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.distributor.localeCompare(b.distributor));
}
