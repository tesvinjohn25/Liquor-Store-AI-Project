// E2E for the real LiquorPOS format: builds an .xlsx (same shape as the real
// export — Sheet1 data + derived Sheet2/Sheet3 that must be ignored), imports
// it through the browser UI, and verifies the auto-target reorder flow.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium bun test/real-format-check.js
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..", "app");
const outDir = process.env.SHOT_DIR ?? join(here, "screenshots");
mkdirSync(outDir, { recursive: true });

const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };

// Build the workbook from the fixture CSV so both test paths share one source.
const csv = readFileSync(join(here, "fixtures", "real-format-sample.csv"), "utf8");
const rows = csv.trim().split("\n").map((l) => {
  // fixture is machine-generated simple CSV (no embedded commas)
  const c = l.split(",");
  return c;
});
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
// Derived sheets like the real file has — the importer must ignore them.
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["JUNK", "SHOULD", "BE", "IGNORED"]]), "Sheet2");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["MORE", "JUNK"]]), "Sheet3");
const xlsxBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const file = Bun.file(join(appDir, path === "/" ? "index.html" : path));
    return (await file.exists()) ? new Response(file) : new Response("nf", { status: 404 });
  },
});
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage({ viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true });
page.on("pageerror", (err) => fail(`page JS error: ${err.message}`));
await page.goto(`http://localhost:${server.port}`);

// Import the .xlsx through the real file input.
await page.click('[data-tab="data"]');
await page.setInputFiles("#import-file", {
  name: "062226.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  buffer: xlsxBuffer,
});
await page.waitForSelector("#import-report .notice.ok");
const notice = await page.textContent("#import-report");
if (!notice.includes("LiquorPOS item export")) fail(`format not detected: ${notice}`);
if (!notice.includes("negative stock")) fail("negative-stock notice missing");
await page.screenshot({ path: join(outDir, "7-real-import.png") });

// Low Stock should be populated purely from the auto sales-velocity rule.
await page.click('[data-tab="low"]');
const lowText = await page.textContent("#view");
if (!lowText.includes("auto target")) fail("auto-target items missing from low list");
if (!lowText.includes("sells ~")) fail("sales-velocity explanation missing");
if (!lowText.includes("negative stock — inventory update needed")) fail("needs-fix notice missing");
await page.screenshot({ path: join(outDir, "8-real-low-stock.png") });

// The negative-stock shortcut filters inventory to the broken items.
await page.click("#go-needs-fix");
const fixCount = await page.locator("#inv-list .item").count();
if (fixCount < 1) fail("needs-fix filter shows nothing");
const fixText = await page.textContent("#inv-list");
if (!/-\d/.test(fixText)) fail("negative quantities not visible in fix list");
await page.screenshot({ path: join(outDir, "9-negative-stock.png") });

// Order sheet exists as a single "Order list" (no vendor data yet), in units.
await page.click('[data-tab="orders"]');
const sheet = await page.textContent("pre.sheet");
if (!sheet.includes("ORDER — Order list")) fail("order sheet missing");
if (/\d cs —/.test(sheet)) fail("order sheet wrongly uses cases without pack data");
await page.screenshot({ path: join(outDir, "10-real-order-sheet.png") });

// Dashboard "Must order now": preview of 5 rows, See-more expands the rest.
await page.click('[data-tab="low"]');
await page.click('.dl-col[data-col="0"]');
const previewRows = await page.locator("#dl-detail .dl-row").count();
if (previewRows > 5) fail(`detail preview shows ${previewRows} rows, expected <= 5`);
const seeMore = page.locator("#dl-see-more");
if ((await seeMore.count()) !== 1) fail("See more button missing");
await seeMore.click();
const allRows = await page.locator("#dl-detail .dl-row").count();
if (allRows <= previewRows) fail("See more did not expand the list");

// Manual par override wins over the auto target, via the single-unit editor.
await page.click('[data-tab="inventory"]');
const firstItem = page.locator("#inv-list .item").first();
const barcode = await firstItem.getAttribute("data-barcode");
await firstItem.click();
if ((await page.locator("#par-units").count()) !== 1) fail("pack-unknown editor should show a single units input");
await page.fill("#par-units", "500");
await page.click("#par-save");
const state = await page.evaluate(() => JSON.parse(localStorage.getItem("store-reorder-v1")));
if (state.products[barcode].parUnits !== 500) fail("manual par did not save");

console.log("PASS: real-format xlsx import → auto targets → fix list → order sheet → par override.");
await browser.close();
server.stop();
