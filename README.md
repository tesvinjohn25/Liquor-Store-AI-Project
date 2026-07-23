# Liquor Store AI Project

Phone-friendly reorder & inventory tool for a liquor store. Static site, no
backend, deployed on GitHub Pages. See `PLAN.md` for the full roadmap and
`VERIFICATION.md` for what's been verified and how.

```
.
├── PLAN.md                # the plan (source of truth)
├── VERIFICATION.md        # traceability table (plan §13.5)
├── app/                   # the deployable static site
│   ├── index.html
│   ├── css/style.css
│   ├── demo-data.csv      # synthetic POS export (bundled demo data)
│   ├── vendor/xlsx.full.min.js  # SheetJS, for reading .xlsx POS exports client-side
│   └── js/
│       ├── posAdapter.js  # ← THE RELINK POINT — POS export format(s) live here
│       ├── csv.js         # CSV parsing
│       ├── importer.js    # import + merge (pars survive re-imports)
│       ├── units.js       # cases+bottles ↔ base units
│       ├── reorder.js     # low stock tiers + auto reorder targets
│       ├── ordersheet.js  # WhatsApp/print text + arithmetic explanations
│       ├── backup.js      # JSON backup/restore
│       ├── store.js       # StorageAdapter (localStorage now, cloud in P1)
│       ├── demo.js        # "Load demo data" button logic + preset pars
│       └── app.js         # UI
└── test/
    ├── *.test.js               # bun test suite
    ├── fixtures/               # anonymized sample exports used by the tests
    ├── mobile-check.js         # Playwright phone-viewport E2E
    ├── real-format-check.js    # E2E for the real LiquorPOS .xlsx format
    └── simulate-weeks.js       # multi-week usage simulation (~1,400 assertions)
```

## Run locally

```bash
cd app && python3 -m http.server 8080
# then open http://localhost:8080 (phone: use your machine's LAN IP)
```

## Test

```bash
bun install
bun test                                                  # unit + scenario suite
CHROMIUM_PATH=/opt/pw-browsers/chromium bun test/mobile-check.js
CHROMIUM_PATH=/opt/pw-browsers/chromium bun test/real-format-check.js
CHROMIUM_PATH=/opt/pw-browsers/chromium bun test/simulate-weeks.js
```

(`CHROMIUM_PATH` only needed if Playwright's bundled browser isn't already
installed — omit it and Playwright will use its own.)

## Deploy to GitHub Pages

`.github/workflows/pages.yml` publishes the `app/` directory automatically on
every push to `main`. In the repo's Settings → Pages, set **Source** to
**GitHub Actions** — no folder/branch picker needed after that.

## How reordering works

Two POS export formats are supported and auto-detected from the file's
header row (see `app/js/posAdapter.js`):

- **The real LiquorPOS export** (`liquorpos-v1`): BRAND, DESCRIP, SIZE,
  QTY_ON_HND, and four months of unit sales. No barcode/pack size/vendor yet.
  A product's reorder target defaults to its average monthly sales (the
  owner's rule — configurable "months of cover" in the Data tab); a manual
  par overrides that per product. Negative on-hand (sales rung up before an
  inventory update) is treated as real data, not an error.
- **The demo/fake format** (`fake-v1`): barcode-keyed, used by "Load demo
  data" and most of the test suite.

Low Stock is sorted by **urgency** (how soon a product runs out), and split
into three tiers — 🔥 Fast movers, Steady sellers, and a collapsed Slow &
limited tier — so a handful of empty shelves don't get buried under hundreds
of slow-moving items.

Low Stock opens with a **dashboard**: a color-coded health bar (healthy /
low / out / needs-fix, with counts) and a tappable two-week timeline of how
many bottles must be ordered each day — tap a bar to see which bottles.

The **Order By** tab turns the same math into a schedule: for every product
with a depletion clock, the date it must be ordered (run-out date minus the
configurable delivery lead time), bucketed into Order now / this week /
2 weeks / this month.

## If the export format changes (e.g. barcode/pack size/vendor get added)

Everything POS-format-specific lives in **one file**: `app/js/posAdapter.js`.

1. Save an anonymized sample as `test/fixtures/<name>.csv`.
2. Add a new format object to `posAdapter.js` (or extend `REAL_EXPORT_FORMAT`)
   mapping the new columns, and handle any quirks inside `normalizeRow`.
3. Point a test at the new fixture and run `bun test` — re-import
   idempotency, par survival, and bad-row reporting must all still pass.
4. Update `VERIFICATION.md` with the new evidence.

Nothing outside `posAdapter.js` (plus test fixture wiring) should need to
change.
