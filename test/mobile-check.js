// Phone-reality check (plan §13.6): drives the core P0a flow in a mobile
// viewport — import fixture → set a par → low-stock list → order sheet —
// and saves screenshots for human review. Run: bun test/mobile-check.js
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..", "app");
const outDir = process.env.SHOT_DIR ?? join(here, "screenshots");
mkdirSync(outDir, { recursive: true });

// Serve the static app so ES modules load (file:// blocks them).
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const file = Bun.file(join(appDir, path === "/" ? "index.html" : path));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
const base = `http://localhost:${server.port}`;

// CHROMIUM_PATH overrides for environments with a pre-installed browser.
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage({
  viewport: { width: 393, height: 851 }, // mid-range Android
  hasTouch: true,
  isMobile: true,
});
const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`), fullPage: false });

const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };

// Low Stock tiers render collapsed by default (plan: less scrolling, tap to
// expand). Tests that need to see inside a tier open it explicitly.
const openAllTiers = () => page.evaluate(() => {
  document.querySelectorAll("details.tier").forEach((d) => { d.open = true; });
});

await page.goto(base);
await shot("1-empty-state");

// Import the fixture through the real file input.
await page.click('[data-tab="data"]');
await page.setInputFiles(
  "#import-file",
  {
    name: "fake-liquorpos-export.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(readFileSync(join(appDir, "demo-data.csv"))),
  },
);
await page.waitForSelector("#import-report .notice.ok");
const notice = await page.textContent("#import-report .notice.ok");
if (!notice.includes("Imported 40 products")) fail(`unexpected import notice: ${notice}`);
await shot("2-import-done");

// Set a par: Johnnie Walker Black to 5 cases. Type letter-by-letter to
// catch the focus-loss regression (re-rendering the input closed the
// phone keyboard after every keystroke).
await page.click('[data-tab="inventory"]');
await page.click("#inv-search");
await page.locator("#inv-search").pressSequentially("Johnnie Walker Black", { delay: 25 });
const focusedId = await page.evaluate(() => document.activeElement?.id);
if (focusedId !== "inv-search") fail("search input lost focus while typing");
const typed = await page.inputValue("#inv-search");
if (typed !== "Johnnie Walker Black") fail(`search text mangled: "${typed}"`);
await page.click('.item[data-barcode="080432400630"]');
await page.fill("#par-cases", "5");
await page.fill("#par-bottles", "0");
await shot("3-par-editor");
await page.click("#par-save");

// Low-stock list should now show it, short 1 case, with the summary strip
// and the tab badge. Tiers start collapsed — verify that, then open one via
// its actual summary click (not the test helper) to prove the interaction.
await page.click('[data-tab="low"]');
const collapsedText = await page.textContent("#view");
if (!collapsedText.includes("item to order")) fail("summary strip missing");
if (!collapsedText.includes("Johnnie Walker Black")) fail("collapsed tier content should still be in the DOM");
if (await page.locator(".badge.low").first().isVisible()) fail("tier should start collapsed, not showing items");
const badge = await page.textContent('[data-tab="low"]');
if (!badge.includes("1")) fail("Low Stock tab badge missing");

await page.locator("details.tier summary").first().click();
if (!(await page.locator(".badge.low").first().isVisible())) fail("tier did not expand on tap");
await shot("4-low-stock");

// The needs-par shortcut filters inventory to products without a par.
await page.click("#go-needs-par");
const needsParCount = await page.locator("#inv-list .item").count();
if (needsParCount !== 39) fail(`needs-par filter shows ${needsParCount}, expected 39`);
await page.click("#clear-inv-mode");

// Order By tab: below-par Johnnie Walker shows as overdue/due today.
await page.click('[data-tab="deadlines"]');
const dlText = await page.textContent("#view");
if (!dlText.includes("Order now (overdue)")) fail("Order By missing overdue bucket");
if (!dlText.includes("Johnnie Walker Black")) fail("Order By missing the below-par product");
if (!dlText.includes("must order by")) fail("Order By missing deadline wording");
await page.locator("details.tier summary").first().click();
if (!(await page.locator("#view .item").first().isVisible())) fail("deadline bucket did not expand");
await shot("11-order-by");

// Summary strip button jumps straight to the order sheets.
await page.click('[data-tab="low"]');
await page.click("#go-orders");
const sheet = await page.textContent("pre.sheet");
if (!sheet.includes("ORDER — Southern Glazers")) fail("order sheet missing distributor header");
if (!sheet.includes("1 cs — Johnnie Walker Black 750ml")) fail("order sheet missing suggestion line");
await shot("5-order-sheet");

// Persistence: reload and confirm the par survived localStorage.
await page.reload();
await page.click('[data-tab="low"]');
const afterReload = await page.textContent("#view");
if (!afterReload.includes("Johnnie Walker Black")) fail("state did not survive reload");

// Demo button: clear storage, load demo data from the empty state.
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.click("#load-demo");
await page.waitForSelector(".summary-row, .empty");
await openAllTiers();
const demoText = await page.textContent("#view");
if (!demoText.includes("Johnnie Walker Black")) fail("demo data did not load");
await shot("6-demo-loaded");

console.log("PASS: import → par → low stock → order sheet, state persisted.");
console.log("Screenshots in", outDir);

await browser.close();
server.stop();
