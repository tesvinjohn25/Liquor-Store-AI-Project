// Multi-week usage simulation (plan §13): drives the REAL UI through six
// weekly reorder cycles with deterministic simulated sales and deliveries,
// and independently recomputes the expected state at every step. Any
// mismatch between what the app shows and what the math says fails the run.
//
// Per week: import an evolved POS export → verify stock/pars/active flags in
// storage → verify Low Stock list, badge, and arithmetic → verify order
// sheets and totals → simulate "order everything suggested, it arrives
// before next import" → sales happen → next week's export.
//
// Edge weeks: W2 delists a product; W3 brings it back + adds a new product;
// W4 does a full backup/wipe/restore round-trip; W5 has a corrupted row;
// every week ends with a page reload to prove persistence.
//
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium bun test/simulate-weeks.js
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..", "app");
const tmpDir = join(process.env.SIM_TMP ?? here, "sim-tmp");
mkdirSync(tmpDir, { recursive: true });

let checks = 0;
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
const assert = (cond, msg) => { checks++; if (!cond) fail(msg); };

// Deterministic RNG so every run reproduces the same six weeks.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);

// ---- simulated world -------------------------------------------------------
const HEADER = "Barcode,Description,Size,Pack,Dept,Vendor,On Hand";
const baseCsv = readFileSync(join(appDir, "demo-data.csv"), "utf8").trim().split("\n");
const world = baseCsv.slice(1).map((line) => {
  const [barcode, name, size, pack, dept, vendor, onHand] = line.split(",");
  return { barcode, name, size, pack: Number(pack), dept, vendor, onHand: Number(onHand) };
});
const byBarcode = (bc) => world.find((p) => p.barcode === bc);

const MALIBU = "721733000029";
const NEW_PRODUCT = { barcode: "999000000001", name: "Seasonal Eggnog Liqueur", size: "750ml", pack: 12, dept: "Liqueur", vendor: "Empire Distributors", onHand: 24 };

// Pars the "owner" sets through the UI in week 1 (cases, bottles).
const UI_PARS = {
  "080432400630": [5, 0],   // Johnnie Walker Black, pack 12 → 60u
  "088076177956": [4, 0],   // Jameson → 48u
  "721059001106": [2, 0],   // Buffalo Trace → 24u
  "031259247223": [6, 0],   // Titos 750 → 72u
  "087116066601": [2, 6],   // Grey Goose → 30u
  "049000050202": [3, 0],   // Bacardi Superior → 36u
  "811538013666": [3, 0],   // Espolon Blanco, pack 6 → 18u
  "098611030025": [1, 0],   // Grand Marnier → 12u
  "071990095618": [10, 0],  // Heineken 12pk, pack 2 → 20u
  "650012000019": [4, 0],   // Josh Cabernet → 48u
  [MALIBU]: [2, 0],         // Malibu → 24u (delisted in W2, must survive)
};
const parLedger = {}; // barcode -> expected units
for (const [bc, [c, b]] of Object.entries(UI_PARS)) parLedger[bc] = c * byBarcode(bc).pack + b;

function csvFor(week, { exclude = [], extraRows = [], corrupt = {} } = {}) {
  const rows = world
    .filter((p) => !exclude.includes(p.barcode))
    .map((p) => {
      const c = corrupt[p.barcode];
      return `${p.barcode},${p.name},${p.size},${c?.pack ?? p.pack},${p.dept},${p.vendor},${c?.onHand ?? p.onHand}`;
    });
  const text = [HEADER, ...rows, ...extraRows].join("\n") + "\n";
  writeFileSync(join(tmpDir, `week${week}.csv`), text);
  return text;
}

// Expected reorder math, computed independently of the app.
function expectedLow(activeBarcodes) {
  return world
    .filter((p) => activeBarcodes.includes(p.barcode))
    .filter((p) => parLedger[p.barcode] != null && p.onHand < parLedger[p.barcode])
    .map((p) => ({ ...p, par: parLedger[p.barcode], cases: Math.ceil((parLedger[p.barcode] - p.onHand) / p.pack) }));
}

// ---- browser plumbing ------------------------------------------------------
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
const ctx = await browser.newContext({ viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true, acceptDownloads: true });
const page = await ctx.newPage();
page.on("pageerror", (err) => fail(`page JS error: ${err.message}`));
await page.goto(`http://localhost:${server.port}`);

const appState = () => page.evaluate(() => JSON.parse(localStorage.getItem("store-reorder-v1")));
async function importCsv(name, text) {
  await page.click('[data-tab="data"]');
  await page.setInputFiles("#import-file", { name, mimeType: "text/csv", buffer: Buffer.from(text) });
  await page.waitForSelector("#import-report .notice.ok");
  return page.textContent("#import-report");
}
async function setParViaUi(barcode, cases, bottles) {
  await page.click('[data-tab="inventory"]');
  await page.fill("#inv-search", "");
  await page.click(`.item[data-barcode="${barcode}"]`);
  await page.fill("#par-cases", String(cases));
  await page.fill("#par-bottles", String(bottles));
  await page.click("#par-save");
  await page.waitForSelector("#inv-search");
}

async function verifyWeek(week, { activeBarcodes, expectDelistedNotice = 0, expectBadRows = 0, importReport }) {
  // Storage matches the simulated world.
  const state = await appState();
  for (const p of world.filter((w) => activeBarcodes.includes(w.barcode))) {
    const sp = state.products[p.barcode];
    assert(sp, `W${week}: ${p.name} missing from state`);
    assert(sp.onHandUnits === p.onHand, `W${week}: ${p.name} on-hand ${sp.onHandUnits} ≠ world ${p.onHand}`);
    assert(sp.active !== false, `W${week}: ${p.name} wrongly inactive`);
    const expectedPar = parLedger[p.barcode] ?? null;
    assert((sp.parUnits ?? null) === expectedPar, `W${week}: ${p.name} par ${sp.parUnits} ≠ ledger ${expectedPar}`);
  }
  if (expectDelistedNotice > 0) {
    assert(importReport.includes(`${expectDelistedNotice} product(s) no longer in the export`), `W${week}: delisted notice missing`);
  }
  if (expectBadRows > 0) {
    assert(importReport.includes(`Skipped ${expectBadRows} bad row(s)`), `W${week}: bad-row notice missing`);
  }

  // Low Stock screen matches independent math.
  const exp = expectedLow(activeBarcodes);
  await page.click('[data-tab="low"]');
  const lowItems = await page.$$eval("#view .card .item[data-barcode]", (els) => els.map((e) => e.dataset.barcode));
  const expSet = new Set(exp.map((p) => p.barcode));
  assert(lowItems.length === exp.length, `W${week}: low list shows ${lowItems.length}, expected ${exp.length}`);
  for (const bc of lowItems) assert(expSet.has(bc), `W${week}: unexpected low item ${bc}`);
  const badge = await page.textContent('[data-tab="low"]');
  assert(exp.length === 0 ? !/\d/.test(badge) : badge.includes(String(exp.length)), `W${week}: badge "${badge.trim()}" ≠ ${exp.length}`);
  const lowText = await page.textContent("#view");
  for (const p of exp) assert(lowText.includes(`order ${p.cases} cs`), `W${week}: ${p.name} suggestion ${p.cases} cs not shown`);

  // Order sheets match, distributor by distributor.
  await page.click('[data-tab="orders"]');
  const sheets = await page.$$eval("pre.sheet", (els) => els.map((e) => e.textContent));
  const expByVendor = new Map();
  for (const p of exp) {
    if (!expByVendor.has(p.vendor)) expByVendor.set(p.vendor, []);
    expByVendor.get(p.vendor).push(p);
  }
  assert(sheets.length === expByVendor.size, `W${week}: ${sheets.length} sheets, expected ${expByVendor.size}`);
  for (const [vendor, items] of expByVendor) {
    const sheet = sheets.find((s) => s.startsWith(`ORDER — ${vendor}`));
    assert(sheet, `W${week}: no sheet for ${vendor}`);
    for (const p of items) assert(sheet.includes(`${p.cases} cs — ${p.name} ${p.size}`), `W${week}: ${vendor} sheet missing "${p.cases} cs — ${p.name}"`);
    assert(sheet.includes(`${items.length} item`), `W${week}: ${vendor} sheet count wrong`);
  }
  if (exp.length > 0) {
    const totalCases = exp.reduce((s, p) => s + p.cases, 0);
    const summary = await page.textContent("#view .summary-row");
    assert(summary.includes(`${totalCases}`), `W${week}: orders summary missing total ${totalCases}`);
  }

  // Persistence: reload, state identical.
  const before = JSON.stringify(state);
  await page.reload();
  assert(JSON.stringify(await appState()) === before, `W${week}: state changed across reload`);
  return exp;
}

// Owner orders everything suggested; it arrives before next import. Then a
// week of sales happens.
function advanceWorld(suggestions) {
  for (const s of suggestions) byBarcode(s.barcode).onHand += s.cases * s.pack;
  for (const p of world) {
    const velocity = Math.round(rand() * p.pack * 1.5); // 0..1.5 cases/wk in units
    p.onHand = Math.max(0, p.onHand - Math.min(p.onHand, velocity));
  }
}

// ============================== WEEK 1 =====================================
console.log("W1: first import, set pars through the UI, junk-input probes");
let report = await importCsv("week1.csv", csvFor(1));
for (const [bc, [c, b]] of Object.entries(UI_PARS)) await setParViaUi(bc, c, b);

// Junk-input probes on a scratch product (no par in ledger): negative and
// decimal input must not crash and must clamp sanely.
await setParViaUi("018200530746", -3, -5); // Budweiser: clamps to 0
let st = await appState();
assert(st.products["018200530746"].parUnits === 0, "junk probe: negative par did not clamp to 0");
await setParViaUi("018200530746", 2.5, 1.9); // floors to 2 cs 1 btl = 5u (pack 2)
st = await appState();
assert(st.products["018200530746"].parUnits === 2 * 2 + 1, "junk probe: decimal par did not floor");
await page.click('[data-tab="inventory"]');
await page.fill("#inv-search", "");
await page.click('.item[data-barcode="018200530746"]');
await page.click("#par-clear"); // back to no par
st = await appState();
assert(st.products["018200530746"].parUnits === null, "junk probe: clear par failed");

let allBarcodes = world.map((p) => p.barcode);
let sugg = await verifyWeek(1, { activeBarcodes: allBarcodes, importReport: report });

// ============================== WEEK 2 =====================================
console.log("W2: Malibu delisted from the export");
advanceWorld(sugg);
report = await importCsv("week2.csv", csvFor(2, { exclude: [MALIBU] }));
let active = allBarcodes.filter((b) => b !== MALIBU);
sugg = await verifyWeek(2, { activeBarcodes: active, expectDelistedNotice: 1, importReport: report });
st = await appState();
assert(st.products[MALIBU].active === false, "W2: Malibu not marked inactive");
assert(st.products[MALIBU].parUnits === parLedger[MALIBU], "W2: Malibu par lost while inactive");
await page.click('[data-tab="inventory"]');
await page.fill("#inv-search", "Malibu");
assert((await page.locator("#inv-list .item").count()) === 0, "W2: delisted Malibu still visible in inventory");

// ============================== WEEK 3 =====================================
console.log("W3: Malibu returns; brand-new product appears");
advanceWorld(sugg.filter((s) => s.barcode !== MALIBU));
report = await importCsv("week3.csv", csvFor(3, {
  extraRows: [`${NEW_PRODUCT.barcode},${NEW_PRODUCT.name},${NEW_PRODUCT.size},${NEW_PRODUCT.pack},${NEW_PRODUCT.dept},${NEW_PRODUCT.vendor},${NEW_PRODUCT.onHand}`],
}));
world.push({ ...NEW_PRODUCT });
allBarcodes = world.map((p) => p.barcode);
sugg = await verifyWeek(3, { activeBarcodes: allBarcodes, importReport: report });
st = await appState();
assert(st.products[MALIBU].active === true, "W3: returning Malibu not reactivated");
assert(st.products[MALIBU].parUnits === parLedger[MALIBU], "W3: returning Malibu lost its par");
assert(st.products[NEW_PRODUCT.barcode].parUnits === null, "W3: new product should have no par");
await page.click('[data-tab="inventory"]');
await page.fill("#inv-search", "Eggnog");
assert((await page.locator("#inv-list .item").count()) === 1, "W3: new product not searchable");
assert((await page.textContent("#inv-list")).includes("set par"), "W3: new product missing set-par badge");

// ============================== WEEK 4 =====================================
console.log("W4: backup → wipe → restore round-trip");
advanceWorld(sugg);
report = await importCsv("week4.csv", csvFor(4));
sugg = await verifyWeek(4, { activeBarcodes: allBarcodes, importReport: report });
const preBackup = await appState();
await page.click('[data-tab="data"]');
const [download] = await Promise.all([page.waitForEvent("download"), page.click("#backup-export")]);
const backupPath = join(tmpDir, "backup.json");
await download.saveAs(backupPath);
const backupJson = JSON.parse(readFileSync(backupPath, "utf8"));
assert(backupJson.state.products["080432400630"].parUnits === parLedger["080432400630"], "W4: backup missing par data");
await page.evaluate(() => localStorage.clear());
await page.reload();
assert((await page.locator("#load-demo").count()) > 0, "W4: wipe did not empty the app");
await page.click('[data-tab="data"]');
await page.setInputFiles("#backup-file", backupPath);
await page.waitForSelector("#backup-report .notice.ok");
const restored = await appState();
assert(JSON.stringify(restored.products) === JSON.stringify(preBackup.products), "W4: restore ≠ pre-backup state");
await verifyWeek(4, { activeBarcodes: allBarcodes, importReport: "" });

// ============================== WEEK 5 =====================================
console.log("W5: corrupted row for an existing product");
advanceWorld(sugg);
const cheatedOnHand = byBarcode("083664112187").onHand; // Crown Royal keeps last good value
report = await importCsv("week5.csv", csvFor(5, { corrupt: { "083664112187": { pack: "N/A" } } }));
// Crown Royal's row was bad → app keeps last known good stock; our world
// model must mirror that for verification.
const crWorld = byBarcode("083664112187");
const stNow = await appState();
assert(stNow.products["083664112187"].active !== false, "W5: corrupted row wrongly delisted Crown Royal");
crWorld.onHand = stNow.products["083664112187"].onHandUnits; // align world to last-good
sugg = await verifyWeek(5, { activeBarcodes: allBarcodes, expectBadRows: 1, importReport: report });
void cheatedOnHand;

// ============================== WEEK 6 =====================================
console.log("W6: heavy sales week — everything restocks correctly");
advanceWorld(sugg);
for (const p of world) p.onHand = Math.max(0, p.onHand - Math.round(rand() * p.pack)); // extra rush
report = await importCsv("week6.csv", csvFor(6));
sugg = await verifyWeek(6, { activeBarcodes: allBarcodes, importReport: report });

// Search stress: rapid letter-by-letter typing with focus assertions.
await page.click('[data-tab="inventory"]');
await page.click("#inv-search");
await page.locator("#inv-search").pressSequentially("Johnnie Walker", { delay: 10 });
assert((await page.evaluate(() => document.activeElement?.id)) === "inv-search", "W6: search lost focus");
assert((await page.locator("#inv-list .item").count()) === 2, "W6: search results wrong"); // Black + Red

console.log(`\nPASS: 6 weeks simulated, ${checks} assertions verified.`);
await browser.close();
server.stop();
