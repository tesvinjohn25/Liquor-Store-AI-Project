import { describe, test, expect } from "bun:test";
import { parseCsv, parseCsvWithHeader } from "../app/js/csv.js";

describe("CSV parser", () => {
  test("basic rows and CRLF", () => {
    expect(parseCsv("a,b\r\nc,d\r\n")).toEqual([["a", "b"], ["c", "d"]]);
  });

  test("quoted fields with commas and escaped quotes", () => {
    expect(parseCsv('"Smith, John","5\'10"" tall","say ""hi"""\n')).toEqual([
      ["Smith, John", '5\'10" tall', 'say "hi"'],
    ]);
  });

  test("header records carry line numbers and trim whitespace", () => {
    const { header, records } = parseCsvWithHeader("Name , Qty\nVodka,3\n\nGin,5\n");
    expect(header).toEqual(["Name", "Qty"]);
    expect(records).toEqual([
      { __line: 2, Name: "Vodka", Qty: "3" },
      { __line: 3, Name: "Gin", Qty: "5" },
    ]);
  });
});
