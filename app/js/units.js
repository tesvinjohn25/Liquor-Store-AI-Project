// All stock math happens in base units (bottles). Cases + bottles is a
// display/input format only — never stored, never calculated with.

export function toUnits(cases, bottles, packSize) {
  if (!Number.isInteger(packSize) || packSize < 1) {
    throw new Error(`invalid pack size: ${packSize}`);
  }
  const c = Number(cases) || 0;
  const b = Number(bottles) || 0;
  if (c < 0 || b < 0) throw new Error("negative quantity");
  return c * packSize + b;
}

export function toCasesBottles(units, packSize) {
  if (!Number.isInteger(packSize) || packSize < 1) {
    throw new Error(`invalid pack size: ${packSize}`);
  }
  const u = Math.max(0, Number(units) || 0);
  return { cases: Math.floor(u / packSize), bottles: u % packSize };
}

export function formatUnits(units, packSize) {
  if (packSize <= 1) return `${Math.max(0, Number(units) || 0)}`; // pack unknown: plain units
  const { cases, bottles } = toCasesBottles(units, packSize);
  if (cases === 0) return `${bottles} btl`;
  if (bottles === 0) return `${cases} cs`;
  return `${cases} cs ${bottles} btl`;
}
