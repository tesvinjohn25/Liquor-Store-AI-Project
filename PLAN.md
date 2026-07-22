# Store Reorder & Multi-Store Inventory Tool — MVP Plan for Codex

**Builder:** Codex.
**Primary users:** the owner of Store A; later the owners/operators of partner Stores B and C.
**Delivery:** a phone-friendly web app on GitHub Pages, growing into three private
store workspaces connected by a shared coordination layer.

**MVP definition (the bar every phase is measured against):** the shortest path
to a working product whose value is felt immediately. Anything not on that path
ships in a later phase, not the current one.

---

## 1. Executive summary

Replace memory-based reordering with a simple inventory and reorder tool, then
grow into a coordinated three-store stock-sharing system.

Two functional layers:

1. **Private store workspaces.** Each store has its own inventory, par levels,
   distributors, sections, adjustments and orders. One store never edits
   another store's private records.
2. **Shared coordination layer.** The stores expose only what cooperation
   needs — transferable availability, requests, reservations, transfer status,
   direct-payment settlement records.

**Confirmed decisions:**

- All reorder and redistribution logic is **deterministic arithmetic**. No LLM
  in the core loop. AI appears only later, as optional advice a human can
  override.
- The LiquorPOS connector is a **store-side script that exports only**. It
  automates the POS's own Excel/CSV export and uploads it. It never writes to
  the POS. A workaround for getting app-recorded movements back into the POS
  will be investigated separately and is out of scope for every phase below;
  until then the app *prompts* the exact manual POS adjustment and a person
  enters it at the register.
- Inter-store transfers are settled by **direct payment between stores**; the
  app records amount and payment status, it never moves money and keeps no
  favour balance.
- Quantities display as **cases + bottles** but all storage and math use the
  smallest unit (bottles), with the pack size recorded per calculation.

---

## 2. Assumptions to verify (week-one tasks, not decrees)

These are *probably* true but are cheap to check and expensive to be wrong
about. Verify them on real data before any phase that depends on them.

| Assumption | Verify by | Needed before |
|---|---|---|
| The LiquorPOS export reliably contains barcode, name, size, pack size, distributor, section, on-hand | Inspect a real export from Store A; document the exact columns | P0a (first build task) |
| Barcodes are consistent across the three stores for the same product | Get one export from each store, diff barcodes for ~20 common products | P2 design freeze |
| Weekly export cadence is acceptable until the script automates it | Run P0a through 2–3 real weekly cycles | P1 |

If cross-store barcodes turn out messy, P2 adds a small product-matching/alias
step; discovering that now costs an afternoon, discovering it in P2 costs a
redesign.

### 2.1 Real export findings (verified 2026-07-22, owner-confirmed)

The real LiquorPOS export (7,984 rows) differs from the original assumptions:

- Columns are BRAND, DESCRIP, SIZE, QTY_ON_HND, and four monthly unit-sales
  columns (FIRST..FOURT) plus their average. **No barcode, pack size, vendor,
  or department yet** — the owner confirmed those can be added to the export
  later; until then identity is brand|descrip|size, orders are in units, and
  order sheets are a single list.
- **Owner's confirmed reorder rule: flag when on-hand < average monthly
  sales.** Implemented as the auto target (configurable months of cover);
  manual pars override per product.
- **Negative on-hand is expected data** (deliveries sold before the inventory
  update); imported as-is, counted as 0 in order math, and surfaced as a
  "needs inventory fix" list. Periodic inventory updates in the POS reset it.
- **~66% of the catalog has zero sales** — intentional (kept for rare special
  orders). Dead items never alert; they stay searchable.
- Duplicate brand|descrip|size rows exist (64) — merged by summing.
- The app imports the .xlsx directly (first sheet; the export's other sheets
  are derived reports and are ignored).

---

## 3. P0a — the MVP kernel (build this first, ship in days)

One store, one browser, no backend, no accounts. localStorage behind a
`StorageAdapter` module (the seam for P1's cloud swap). Deployed on GitHub
Pages.

**The value moment:** the owner looks at a generated order sheet and says
"that's basically what I would have ordered."

1. **LiquorPOS import — the source of inventory.** Read the POS CSV/Excel
   export: barcode (product key), name, size, pack size, distributor, section,
   on-hand quantity. Re-importing a fresh export refreshes on-hand numbers.
   **Par levels always survive re-imports.** Show import time and source
   filename; the UI says "inventory as of \<timestamp\>", never "live".
2. **Manual par levels — the app's own given.** The one thing the POS doesn't
   know. Entered and edited per product in cases + bottles, converted to base
   units internally, always overridable.
3. **Low-stock list.** Available stock vs. par for every product; zero-stock
   items shown separately; last-refresh time visible.
4. **Distributor order suggestions.** Grouped by distributor;
   `suggested = (par − on hand)` rounded **up** to the next valid pack.
5. **Order sheets.** Printable, plus clean text for WhatsApp/email.
6. **Backup.** Export/import all app-created data (pars, adjustments) as one
   JSON file; show last-backup date as a reminder. Original POS export files
   are retained separately by the store.

**P0a is done when:** someone imports a real weekly export, pars are set, the
owner reviews the low-stock list and sends every distributor order in about
five minutes — and a backup restore round-trips correctly.

**Accepted P0a limitations** (conscious trades for speed): single browser, no
cloud, weekly snapshot freshness, no order tracking, no multi-store, manual
backup only.

---

## 4. P0b — first fast-follow (after 1+ real weekly cycle on P0a)

Feedback from real use decides the order of these; do not build them before
P0a has been used for at least one real reorder.

1. **Minimal order lifecycle.** Draft → sent → received/cancelled. Sent-but-
   unreceived quantities count as inbound stock so nothing is suggested twice:

   ```text
   net requirement = par − on hand − open distributor orders − confirmed inbound
   suggested order = positive net requirement rounded up to a valid pack
   ```

   Preserve a snapshot of each sent order even if inventory later changes.
2. **Count/adjust screen.** Fast phone-friendly entry grouped by shelf
   section, for spot corrections between imports (breakage, shelf ≠ system).
   Clearly labelled +/− adjustments with reason and time.
3. **Calculation transparency.** Every suggestion can show its arithmetic in
   plain language so the owner can trust and override it.

---

## 5. P1 — Cloud-backed private workspaces

Checkable from home; the foundation for multi-store.

1. **Backend:** Supabase (Postgres) free tier; GitHub Pages frontend stays.
   Row-level security separates stores from day one — enforced by the
   database, not hidden by the UI.
2. **Auth:** one shared login per store (matches the trust model). Individual
   staff accounts are a future improvement, not a requirement.
3. **Owner dashboard:** below-par, zero-stock, stale sections, open orders,
   last import time, last successful sync.
4. **Event-based history:** imports, adjustments, orders and receipts recorded
   as events with a current snapshot for fast display. No whole-product
   last-write-wins overwrites.
5. **Offline working copy:** local copy for connectivity loss; queued changes;
   visible sync state (synced / offline / waiting / needs attention). A failed
   sync is never silent.

---

## 6. P1.5 — Store-side export script (read-only POS bridge)

**Decision locked: this script exports only. It never writes to LiquorPOS.**

A small script on each store's Windows POS machine, run by Task Scheduler:

1. Runs the LiquorPOS item export (or reads its local data files read-only).
2. Uploads the export to the backend over **outbound HTTPS only** — no open
   ports, no inbound access, credentials never leave the machine.
3. Reports every run (success/failure, row count, timestamp) so a store whose
   script has died shows as **stale** on the dashboard instead of silently
   drifting.
4. Is simple enough to reinstall in five minutes; survives reboots.

Effect: the weekly manual export becomes nightly (or hourly) and hands-free —
most of the value of "live inventory" at near-zero risk. The UI still says
"inventory as of \<timestamp\>" until freshness is proven in practice.

**POS write-back is explicitly out of scope.** App-recorded movements that the
POS should know about (transfer pickups/deliveries, adjustments) appear as a
**pending POS entries list** — the app shows the exact adjustment to key into
LiquorPOS at the register, and a person marks it entered. A future workaround
for automating this will be evaluated separately; nothing below depends on it.

---

## 7. P2 — Three-store coordination and transfers

Connect the three private workspaces through the shared layer. **No POS
writing anywhere in this phase** — transfers update app inventories, and the
pending-POS-entries list (§6) covers the register side.

1. **Shared product catalogue.** Barcode as the shared key; shared name, size,
   pack size stored once. Distributor, par, section, inventory stay
   store-private. (Add an alias/matching step if the week-one barcode check
   found mismatches.)
2. **Controlled availability sharing.** A store below par can see partner
   *transferable* quantity and its freshness — nothing else. No store edits
   another's inventory. Costs, margins, sales history are never shared.
3. **Partner-first suggestions (deterministic).**

   ```text
   transferable = on hand − reserved outbound − partner's own par − safety buffer
   ```

   Below-par item → check both partners for surplus → suggest "request N from
   Store B", else fall back to the distributor order list. Always a
   suggestion, never an automatic transfer. Stale partner data (older than an
   agreed threshold) blocks the automatic suggestion.
4. **Reservation requests.** Request products/quantities from a partner; the
   giving store approves all, part, or declines. Approval reserves the stock
   atomically (a database transaction — two requests can never reserve the
   same units). Reservations can expire or be cancelled under defined rules.
5. **Transfer status workflow.**

   ```text
   requested → approved/reserved → picked up → delivered
            ↘ declined           ↘ cancelled
   ```

   Partial approval/pickup/delivery supported; every transition records who
   and when, and is repeat-safe. Mistakes are corrected by reversal events,
   never by deleting history.
6. **Inventory effects.** Approval reduces the giver's available-to-promise
   (not physical stock). Pickup deducts actual quantity from the giver;
   delivery adds actual quantity to the receiver; in-transit stays visible
   between the two. Both private events and the shared transfer share one
   transfer ID. Each pickup/delivery also creates its pending-POS-entry
   prompts for both stores.
7. **Direct payment settlement.** Agreed amount, currency, payer, payee,
   status (unpaid/paid/disputed), optional reference. Money moves outside the
   app.

**P2 is a major phase, not an add-on.** Pilot it with a limited product set
before enabling the full catalogue.

---

## 8. P3 — Reporting and optional intelligence

Only after the workflows above are demonstrably reliable.

1. **Activity reports:** below-par history, distributor orders/receipts,
   inter-store requests/transfers, payments and outstanding settlements,
   adjustments/reversals — weekly, monthly, seasonal; exportable.
2. **Combined distributor orders:** merge eligible store orders to hit case
   minimums/delivery thresholds, with per-store allocation sheets.
3. **AI-assisted reservation advice (optional):** drafts a recommendation from
   stock, par, freshness, movement and season — shows its supporting facts,
   never approves or moves stock itself. Deterministic math stays
   authoritative for quantities.
4. **Seasonal placement suggestions:** experimental, owner-controlled, only
   once reliable history and layout data exist.

---

## 9. Data model (target shape; P0a uses only the parts it needs)

**Shared catalogue:** `catalog_products` (id, barcode unique, name, size,
base_unit, units_per_case, active).

**Store-private:** `stores`; `store_products` (store_id, product_id,
distributor, section, target_units, safety_buffer_units, active);
`inventory_snapshots` (store_id, product_id, on_hand_units,
reserved_outbound_units, source, source_timestamp, updated_at);
`inventory_events` (store_id, product_id, event_type, quantity_delta_units,
source_reference, occurred_at, created_by, reversal_of_event_id);
`purchase_orders` + `purchase_order_lines`;
`pending_pos_entries` (store_id, source_event_id, description,
suggested_adjustment_units, status: pending/entered/skipped, entered_at).

**Shared coordination:** `transfer_requests` (from/to store, status,
timestamps); `transfer_lines` (requested/approved/picked_up/delivered units);
`transfer_events` (event_type, quantity, performed_by, occurred_at,
idempotency_key, reversal_of_event_id); `transfer_payments` (amount, currency,
payer, payee, status, reference, paid_at).

**Export script telemetry:** `pos_export_runs` (store_id, ran_at, status,
row_count, error).

---

## 10. Deterministic redistribution rules

1. Never recommend more than the giver's calculated transferable quantity.
2. Subtract existing reservations before computing surplus.
3. Respect the giver's par and safety buffer.
4. Require confirmation (or block suggestion) on stale data.
5. Prefer a partner only when the transfer is operationally worthwhile.
6. The giving store always approves; nothing moves automatically.
7. Reserve approved units atomically.
8. Use actual pickup/delivery quantities for inventory movements.
9. Fall back to a distributor order when no partner confirms surplus.
10. Show the arithmetic behind every suggestion.

---

## 11. Security by phase

- **P0a/P0b:** local browser data, no accounts, manual backup — risk accepted
  for speed.
- **P1+ (mandatory once data is in the cloud):** authenticated store access;
  database-enforced store isolation; encrypted transport; basic event/error
  logs; tested backup and recovery.
- **P1.5:** script credentials live only on the store machine; outbound-only
  traffic; minimal run log.
- Staff accounts, roles, approval limits: future, not required.

---

## 12. Testing (minimum scenarios)

**P0a/P0b:** re-import preserves pars; cases↔bottles conversion correct; pack
rounding correct; open order not suggested twice (P0b); cancel restores
requirement (P0b); backup export/restore round-trips; main flow usable
one-handed on a mid-range Android.

**P1/P1.5:** Store A cannot read/edit Store B's records; offline changes sync
or error visibly; a dead export script shows the store as stale; a re-uploaded
identical export causes no double-counting.

**P2:** two simultaneous reservations cannot claim the same stock; partial
approval/delivery quantities correct; repeated status calls have no duplicate
inventory effect; pickup reduces giver, delivery increases receiver; reversal
restores totals with an audit trail; payment status independent of delivery
status; every pickup/delivery generates its pending-POS-entry prompts.

---

## 13. Codex self-verification protocol

No phase is declared complete on Codex's say-so. Every claim of "done" must be
backed by evidence produced the same way, every time:

1. **Every scenario in §12 becomes an automated test before the phase ends.**
   The testing scenarios are not suggestions — they are the acceptance suite.
   A phase with an untested §12 scenario is an unfinished phase. Tests run
   with one command (`npm test` / `bun test`) and in CI on every push, so
   regressions in earlier phases surface immediately.

2. **Fixture-first development.** Task one of P0a (§15 step 1) produces a real
   anonymized LiquorPOS export checked into the repo as a fixture. All
   importer and calculation tests run against that file — not hand-invented
   data — so the tests exercise the real column names, encodings and quirks.

3. **Golden-master order sheets.** Once the owner confirms one generated order
   sheet is right ("that's what I would have ordered"), that input → output
   pair is frozen as a regression test. Future changes that alter the output
   of a locked golden master must justify the diff, not silently change it.

4. **Property checks on the arithmetic.** The deterministic core (§10, §4.4
   conversions) gets invariant tests, not just examples: cases+bottles →
   base units → cases+bottles always round-trips; suggested orders are never
   negative and always whole packs; a transfer suggestion never exceeds
   transferable quantity; re-importing the same file twice changes nothing.

5. **A traceability table per phase, kept in the repo**
   (`VERIFICATION.md`). One row per numbered requirement in the
   phase's scope section:

   | Requirement (plan §) | Implemented in | Proven by (test/command) | Status |

   Codex fills every row with a pointer to real evidence — a named test, a
   command and its output, a screenshot. A row that says "done" with no
   evidence pointer is treated as not done. This table is the self-check:
   producing it forces Codex to re-read the plan section against the code.

6. **Phone-reality check.** UI acceptance runs in a mobile viewport via
   headless browser (Playwright) covering the core flow — import → set par →
   low-stock list → order sheet — with screenshots attached to the
   verification table so a human can eyeball what a phone user actually sees.

7. **The human gates stay human.** Two checks can never be self-certified and
   are listed as explicit owner sign-offs in the table: (a) the P0a value
   moment — the owner compares a generated sheet to what he would have
   ordered; (b) each phase's real-world cycle requirement (e.g. P0a run
   through a real weekly reorder) before the next phase starts.

**Definition of done for any phase:** all §12 scenarios for the phase are
green in CI + the traceability table is complete with evidence + the human
gates are signed off. All three, or the phase is still open.

---

## 14. Risks and mitigations

- **Export quality** — verify real files week one (§2); the importer validates
  and reports bad rows instead of silently skipping.
- **Snapshot staleness before the script exists** — timestamps everywhere;
  giving store confirms before any transfer; P1.5 shortens the gap.
- **P0 data loss (localStorage)** — JSON backup + reminder; source files
  retained; cloud persistence in P1. Consciously accepted for the MVP.
- **Manual POS entry drift** — the pending-entries list makes the gap visible
  and finite instead of invisible; the next export reconciles reality anyway.
- **Transfer workflow complexity** — P2 treated as a major transactional
  phase; event history + transactions; failure paths tested before rollout;
  limited-product pilot first.
- **Shared login can't identify individuals** — accepted under the current
  trust model; store-level attribution retained; revisit only if experience
  demands it.
- **Payment disputes** — record agreed value, delivered quantity, reference,
  and a disputed state; the app never adjudicates.

---

## 15. Build order

1. Verify the real export columns (Store A) and document them.
2. Build P0a against real files; test on the target phone.
3. Run P0a through real weekly reorder cycles; collect friction.
4. Build P0b in the order real use demands.
5. Run the three-store barcode spot-check (20 common products).
6. P1: cloud model, store isolation, event history, dashboard.
7. P1.5: export script at Store A; prove it for a few weeks; roll to B and C.
8. P2: shared catalogue → availability → reservations → transfer workflow →
   payments; pilot on a limited product set.
9. P3: reports first, then optional AI advice and seasonal features.

---

## 16. Out of scope (all phases as planned)

POS write-back by the script (workaround investigated separately); payment
processing; true live POS feeds (until the export cadence proves itself);
individual staff accounts and roles; sales forecasting; AI-made ordering or
transfer decisions.
