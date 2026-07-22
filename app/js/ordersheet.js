import { formatUnits } from "./units.js";

// Quantity label: cases for packed products, plain units when the pack size
// is unknown (real export has no pack column yet).
export function qtyLabel(cases, packSize) {
  return packSize > 1 ? `${cases} cs` : `${cases}`;
}

// Plain-text order sheet for one distributor — clean enough to paste
// straight into WhatsApp or an email body.
export function sheetText(group, meta = {}) {
  const lines = [];
  const date = meta.date ?? new Date().toISOString().slice(0, 10);
  lines.push(`ORDER — ${group.distributor}`);
  if (meta.storeName) lines.push(meta.storeName);
  lines.push(date);
  lines.push("");
  for (const item of group.lines) {
    const label = item.size ? `${item.name} ${item.size}` : item.name;
    lines.push(`${qtyLabel(item.suggestedCases, item.packSize)} — ${label}`);
  }
  lines.push("");
  lines.push(`${group.lines.length} item${group.lines.length === 1 ? "" : "s"}`);
  return lines.join("\n");
}

// One-line explanation of the arithmetic behind a suggestion.
export function explainSuggestion(item) {
  const onHand = Math.max(0, item.onHandUnits);
  if (item.parSource === "auto") {
    return (
      `sells ~${item.avgMonthlyUnits}/mo − on hand ${onHand} → ` +
      `order ${qtyLabel(item.suggestedCases, item.packSize)}`
    );
  }
  return (
    `par ${formatUnits(item.effParUnits ?? item.parUnits, item.packSize)} − ` +
    `on hand ${formatUnits(onHand, item.packSize)} = ` +
    `short ${item.shortageUnits} → ` +
    `${qtyLabel(item.suggestedCases, item.packSize)}` +
    (item.packSize > 1 ? ` (pack of ${item.packSize})` : "")
  );
}
