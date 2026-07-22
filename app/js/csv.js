// Minimal CSV parser: quoted fields, escaped quotes, CR/LF line endings.
// Returns an array of rows; each row is an array of string cells.

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;

  const pushCell = () => { row.push(cell); cell = ""; };
  const pushRow = () => {
    // Skip rows that are entirely empty (trailing newline artifacts).
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { pushCell(); i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { pushCell(); pushRow(); i++; continue; }
    cell += ch; i++;
  }
  if (cell !== "" || row.length > 0) { pushCell(); pushRow(); }
  return rows;
}

// Parse with a header row: returns array of objects keyed by header name,
// each tagged with its 1-based source line number for error reporting.
export function parseCsvWithHeader(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { header: [], records: [] };
  const header = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((cells, idx) => {
    const rec = { __line: idx + 2 };
    header.forEach((name, col) => { rec[name] = (cells[col] ?? "").trim(); });
    return rec;
  });
  return { header, records };
}
