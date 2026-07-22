import { describe, test, expect } from "bun:test";
import { toUnits, toCasesBottles, formatUnits } from "../app/js/units.js";

describe("unit conversions (plan §4.4, §12)", () => {
  test("plan worked example: 4 cases 6 bottles at pack 12 = 54 units", () => {
    expect(toUnits(4, 6, 12)).toBe(54);
  });

  test("round-trip invariant: units -> cases+bottles -> units for many packs", () => {
    for (const pack of [1, 2, 6, 12, 24]) {
      for (let units = 0; units <= 5 * pack + pack - 1; units++) {
        const { cases, bottles } = toCasesBottles(units, pack);
        expect(bottles).toBeLessThan(pack);
        expect(toUnits(cases, bottles, pack)).toBe(units);
      }
    }
  });

  test("rejects invalid pack sizes", () => {
    expect(() => toUnits(1, 0, 0)).toThrow();
    expect(() => toCasesBottles(5, -1)).toThrow();
  });

  test("rejects negative quantities", () => {
    expect(() => toUnits(-1, 0, 12)).toThrow();
  });

  test("formatting", () => {
    expect(formatUnits(54, 12)).toBe("4 cs 6 btl");
    expect(formatUnits(60, 12)).toBe("5 cs");
    expect(formatUnits(6, 12)).toBe("6 btl");
  });
});
