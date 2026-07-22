import { StorageAdapter } from "./store.js";
import { importExport } from "./importer.js";
import { toUnits, toCasesBottles, formatUnits } from "./units.js";
import { lowStockTiers, TIER_FAST, TIER_STEADY, unsetPar, needsInventoryFix, orderSuggestions, effectivePar, DEFAULT_COVER_MONTHS } from "./reorder.js";
import { sheetText, explainSuggestion, qtyLabel } from "./ordersheet.js";
import { exportBackup, importBackup } from "./backup.js";
import { loadDemoData } from "./demo.js";

const INVENTORY_ROW_CAP = 250; // 8k-row exports: render at most this many

const storage = new StorageAdapter();
let state = storage.load();
let currentTab = "low";
let inventoryFilter = "";
let invMode = null; // null | "needs-par" | "needs-fix"

const view = document.getElementById("view");
const freshness = document.getElementById("freshness");

function save() { storage.save(state); }
function cover() { return state.coverMonths ?? DEFAULT_COVER_MONTHS; }

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function fmtDate(iso) {
  if (!iso) return "never";
  const d = new Date(iso);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function productCount() { return Object.keys(state.products).length; }

// ---------------------------------------------------------------- rendering

function render() {
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === currentTab);
  });
  freshness.textContent = state.lastImport
    ? `inventory as of ${fmtDate(state.lastImport.at)}`
    : "no inventory loaded";

  if (productCount() === 0 && currentTab !== "data") {
    view.innerHTML = `
      <div class="empty">
        <p>No products yet.</p>
        <p>Go to <b>Data</b> and import your POS export to get started —
        or try the app with sample data:</p>
        <div class="actions">
          <button class="action" id="load-demo">Load demo data</button>
        </div>
      </div>`;
    wireDemoButton();
    return;
  }

  updateTabBadge();

  if (currentTab === "low") renderLow();
  else if (currentTab === "inventory") renderInventory();
  else if (currentTab === "orders") renderOrders();
  else renderData();
}

// Red count on the Low Stock tab: PRIORITY items only (fast + steady +
// manual pars) — slow movers don't shout from the tab bar.
function updateTabBadge() {
  const t = lowStockTiers(state.products, cover());
  const n = t.fast.length + t.steady.length;
  const btn = document.querySelector('[data-tab="low"]');
  btn.innerHTML = n > 0 ? `Low&nbsp;Stock <span class="count">${n}</span>` : "Low&nbsp;Stock";
}

// Mini bar showing on-hand relative to the target — scannable at a glance.
function stockBar(p) {
  const onHand = Math.max(0, p.onHandUnits);
  const pct = Math.max(0, Math.min(100, Math.round((onHand / p.effParUnits) * 100)));
  return `<div class="stockbar"><div class="${onHand === 0 ? "zero" : "low"}" style="width:${Math.max(pct, 3)}%"></div></div>`;
}

function lowItemHtml(p, tierKey) {
  const soldTag = tierKey === "slow" && p.monthsActive != null
    ? ` · sold in ${p.monthsActive}/4 mo`
    : "";
  const urgency = p.runwayDays == null ? null
    : Math.max(0, p.onHandUnits) === 0 ? "OUT NOW"
    : `~${p.runwayDays} days left`;
  const sub = [urgency, p.distributor, p.parSource === "auto" ? `auto target (${cover()} mo)` : "manual par"]
    .filter(Boolean).join(" · ") + soldTag;
  return `
    <div class="item" data-barcode="${esc(p.barcode)}">
      <div style="flex:1">
        <div class="name">${esc(p.name)} <span class="sub">${esc(p.size)}</span></div>
        <div class="sub">${esc(sub)}</div>
        ${stockBar(p)}
        <div class="explain">${esc(explainSuggestion(p))}</div>
      </div>
      <div class="qty">
        <span class="badge ${Math.max(0, p.onHandUnits) === 0 ? "zero" : "low"}">order ${qtyLabel(p.suggestedCases, p.packSize)}</span>
        <div class="sub">${formatUnits(p.onHandUnits, p.packSize)} / ${formatUnits(p.effParUnits, p.packSize)}</div>
      </div>
    </div>`;
}

function renderLow() {
  const tiers = lowStockTiers(state.products, cover());
  const low = tiers.all;
  const priority = tiers.fast.length + tiers.steady.length;
  const noPar = unsetPar(state.products);
  const fixes = needsInventoryFix(state.products);
  let html = "";

  if (low.length > 0) {
    const allPacked = low.every((p) => p.packSize > 1);
    const total = low.reduce((s, p) => s + p.suggestedCases, 0);
    const slowText = tiers.slow.length > 0
      ? ` — <b>${priority}</b> priority · <b>${tiers.slow.length}</b> slow`
      : "";
    html += `
      <div class="card summary-row">
        <div><b>${low.length}</b> item${low.length === 1 ? "" : "s"} to order
             (<b>${total}</b> ${allPacked ? "cs" : "units"})${slowText}</div>
        <button class="action" id="go-orders">Order sheets →</button>
      </div>`;
  }

  if (fixes.length > 0) {
    html += `<button class="notice warn linklike" id="go-needs-fix">${fixes.length} product${fixes.length === 1 ? " has" : "s have"} negative stock — inventory update needed › </button>`;
  }
  if (noPar.length > 0) {
    html += `<button class="notice warn linklike" id="go-needs-par">${noPar.length} product${noPar.length === 1 ? " has" : "s have"} no par level yet — tap to set them ›</button>`;
  }

  if (low.length === 0) {
    html += `<h2>Below target (0)</h2><div class="card"><div class="empty">Nothing below target. 🎉</div></div>`;
  } else {
    // All tiers start collapsed so the screen opens on the category counts,
    // not a long scroll — the owner taps into whichever tier matters right now.
    const tierDefs = [
      ["fast", `🔥 Fast movers (${TIER_FAST}+/mo)`],
      ["steady", tiers.fast.length || tiers.slow.length ? "Steady sellers" : "Below target"],
      ["slow", `Slow &amp; limited (under ${TIER_STEADY}/mo)`],
    ];
    for (const [key, label] of tierDefs) {
      const items = tiers[key];
      if (items.length === 0) continue;
      html += `
        <details class="card tier">
          <summary>${label} (${items.length})</summary>
          ${items.map((p) => lowItemHtml(p, key)).join("")}
        </details>`;
    }
  }

  view.innerHTML = html;

  document.getElementById("go-orders")?.addEventListener("click", () => {
    currentTab = "orders";
    render();
  });
  document.getElementById("go-needs-par")?.addEventListener("click", () => {
    currentTab = "inventory"; invMode = "needs-par"; inventoryFilter = "";
    render();
  });
  document.getElementById("go-needs-fix")?.addEventListener("click", () => {
    currentTab = "inventory"; invMode = "needs-fix"; inventoryFilter = "";
    render();
  });
}

// The search input is rendered ONCE and never rebuilt while typing — only the
// list below it re-renders. Rebuilding the input on each keystroke destroys
// focus and closes the phone keyboard.
function renderInventory() {
  const chipLabel = invMode === "needs-par" ? "Showing: needs par ✕"
    : invMode === "needs-fix" ? "Showing: negative stock ✕" : "";
  view.innerHTML = `
    <input type="search" id="inv-search" placeholder="Search products or sections" value="${esc(inventoryFilter)}">
    ${invMode ? `<button class="chip" id="clear-inv-mode">${chipLabel}</button>` : ""}
    <div id="inv-list"></div>`;

  document.getElementById("inv-search").addEventListener("input", (e) => {
    inventoryFilter = e.target.value;
    renderInventoryList();
  });
  document.getElementById("clear-inv-mode")?.addEventListener("click", () => {
    invMode = null;
    renderInventory();
  });

  renderInventoryList();
}

function renderInventoryList() {
  const q = inventoryFilter.toLowerCase();
  const all = Object.values(state.products)
    .filter((p) => p.active !== false) // delisted products stay hidden
    .filter((p) => invMode !== "needs-par" || p.parUnits == null)
    .filter((p) => invMode !== "needs-fix" || p.onHandUnits < 0)
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.section.toLowerCase().includes(q))
    .sort((a, b) => a.section.localeCompare(b.section) || a.name.localeCompare(b.name));

  const shown = all.slice(0, INVENTORY_ROW_CAP);
  const bySection = new Map();
  for (const p of shown) {
    if (!bySection.has(p.section)) bySection.set(p.section, []);
    bySection.get(p.section).push(p);
  }

  let html = "";
  if (all.length === 0) {
    html = `<div class="empty">No matching products.</div>`;
  }
  for (const [section, items] of bySection) {
    html += `<h2>${esc(section)}</h2><div class="card">`;
    html += items.map((p) => {
      const target = effectivePar(p, cover());
      const parLabel = p.parUnits != null
        ? `<span class="sub">par ${formatUnits(p.parUnits, p.packSize)}</span>`
        : target != null
          ? `<span class="sub">auto ${formatUnits(target, p.packSize)}</span>`
          : p.avgMonthlyUnits != null
            ? `<span class="sub">no sales</span>`
            : `<span class="badge low">set par</span>`;
      const info = p.avgMonthlyUnits != null
        ? `sells ~${p.avgMonthlyUnits}/mo`
        : `${esc(p.distributor)} · pack of ${p.packSize}`;
      const qty = p.onHandUnits < 0
        ? `<span class="badge zero">${p.onHandUnits}</span>`
        : `<div>${formatUnits(p.onHandUnits, p.packSize)}</div>`;
      return `
        <div class="item" data-barcode="${esc(p.barcode)}">
          <div>
            <div class="name">${esc(p.name)} <span class="sub">${esc(p.size)}</span></div>
            <div class="sub">${info}</div>
          </div>
          <div class="qty">
            ${qty}
            ${parLabel}
          </div>
        </div>`;
    }).join("");
    html += `</div>`;
  }
  if (all.length > shown.length) {
    html += `<div class="empty">Showing ${shown.length} of ${all.length} — refine the search to see more.</div>`;
  }

  const list = document.getElementById("inv-list");
  list.innerHTML = html;
  list.querySelectorAll(".item[data-barcode]").forEach((el) => {
    el.addEventListener("click", () => openParEditor(el.dataset.barcode));
  });
}

function openParEditor(barcode) {
  const p = state.products[barcode];
  if (!p) return;
  const packed = p.packSize > 1;
  const cur = p.parUnits == null
    ? { cases: "", bottles: "" }
    : packed ? toCasesBottles(p.parUnits, p.packSize) : { cases: p.parUnits, bottles: 0 };
  const autoTarget = p.avgMonthlyUnits > 0 ? Math.ceil(p.avgMonthlyUnits * cover()) : null;

  view.innerHTML = `
    <h2>${esc(p.name)} ${esc(p.size)}</h2>
    <div class="card">
      <div class="sub">${esc([p.distributor, packed ? `pack of ${p.packSize}` : null].filter(Boolean).join(" · "))}</div>
      <p>On hand: <b>${p.onHandUnits < 0 ? `${p.onHandUnits} (needs inventory fix)` : formatUnits(p.onHandUnits, p.packSize)}</b></p>
      ${p.avgMonthlyUnits != null ? `<p class="sub">Sells ~${p.avgMonthlyUnits}/month.
        ${autoTarget != null ? `Auto target: reorder below <b>${autoTarget}</b> (${cover()} month${cover() === 1 ? "" : "s"} of sales). Set a par below to override.` : "No sales in the last 4 months — no auto target."}</p>` : ""}
      <p><b>Preferred level (par)</b> — the minimum you want on the shelf:</p>
      <div class="par-inputs">
        ${packed
          ? `<input type="number" id="par-cases" min="0" inputmode="numeric" value="${cur.cases}">
             <span class="unit-label">cases</span>
             <input type="number" id="par-bottles" min="0" inputmode="numeric" value="${cur.bottles}">
             <span class="unit-label">bottles</span>`
          : `<input type="number" id="par-units" min="0" inputmode="numeric" value="${cur.cases === "" ? "" : p.parUnits}">
             <span class="unit-label">units (bottles)</span>`}
      </div>
      <div class="actions">
        <button class="action" id="par-save">Save par</button>
        <button class="action secondary" id="par-clear">${p.parUnits != null ? "Clear par (back to auto)" : "Back to auto"}</button>
        <button class="action secondary" id="par-back">Back</button>
      </div>
    </div>`;

  // Clamp to whole non-negative numbers so junk input ("-3", "2.5", "abc")
  // can never throw inside toUnits or store a nonsense par.
  const cleanQty = (id) => Math.max(0, Math.floor(Number(document.getElementById(id).value) || 0));

  document.getElementById("par-save").addEventListener("click", () => {
    p.parUnits = packed
      ? toUnits(cleanQty("par-cases"), cleanQty("par-bottles"), p.packSize)
      : cleanQty("par-units");
    save();
    render(); // full render keeps the Low Stock tab badge in sync
  });
  document.getElementById("par-clear").addEventListener("click", () => {
    p.parUnits = null;
    save();
    render();
  });
  document.getElementById("par-back").addEventListener("click", render);
}

function renderOrders() {
  const groups = orderSuggestions(state.products, cover());
  let html = "";
  if (groups.length === 0) {
    html = `<div class="empty">No orders needed — nothing is below target.</div>`;
  } else {
    const allLines = groups.flatMap((g) => g.lines);
    const allPacked = allLines.every((l) => l.packSize > 1);
    const total = allLines.reduce((s, l) => s + l.suggestedCases, 0);
    html += `<div class="card summary-row"><div><b>${groups.length}</b> order sheet${groups.length === 1 ? "" : "s"} · <b>${total}</b> ${allPacked ? "cases" : "units"} total — copy each into WhatsApp or print</div></div>`;
  }
  for (const g of groups) {
    const text = sheetText(g, { storeName: state.storeName });
    html += `
      <h2>${esc(g.distributor)} (${g.lines.length})</h2>
      <pre class="sheet">${esc(text)}</pre>
      <div class="actions no-print">
        <button class="action" data-copy="${esc(encodeURIComponent(text))}">Copy for WhatsApp</button>
      </div>`;
  }
  if (groups.length > 0) {
    html += `<div class="actions no-print"><button class="action secondary" id="print-all">Print all sheets</button></div>`;
  }
  view.innerHTML = html;

  view.querySelectorAll("[data-copy]").forEach((b) => {
    b.addEventListener("click", async () => {
      await navigator.clipboard.writeText(decodeURIComponent(b.dataset.copy));
      b.textContent = "Copied ✓";
      setTimeout(() => { b.textContent = "Copy for WhatsApp"; }, 1500);
    });
  });
  document.getElementById("print-all")?.addEventListener("click", () => window.print());
}

// Read a POS export file: .xlsx via the vendored SheetJS (first sheet only —
// the POS workbook's other sheets are derived reports), .csv as plain text.
function readExportFile(file, done) {
  const isExcel = /\.(xlsx|xls)$/i.test(file.name);
  const reader = new FileReader();
  reader.onload = () => {
    if (!isExcel) return done(String(reader.result));
    if (typeof XLSX === "undefined") return done(null, "Excel support failed to load — export as CSV instead.");
    try {
      const wb = XLSX.read(reader.result, { type: "array" });
      const first = wb.Sheets[wb.SheetNames[0]];
      done(XLSX.utils.sheet_to_csv(first));
    } catch (err) {
      done(null, `could not read Excel file: ${err.message}`);
    }
  };
  if (isExcel) reader.readAsArrayBuffer(file);
  else reader.readAsText(file);
}

function renderData() {
  const li = state.lastImport;
  view.innerHTML = `
    <h2>POS import</h2>
    <div class="card">
      <p class="sub">Import the item export from the POS — Excel (.xlsx) straight from
      LiquorPOS, or CSV. Re-importing refreshes stock and sales numbers; your
      par levels are kept.</p>
      <p>Last import: <b>${li ? `${fmtDate(li.at)} — ${esc(li.filename ?? "?")} (${li.imported} products${li.badRows?.length ? `, ${li.badRows.length} bad rows` : ""})` : "never"}</b></p>
      <div class="actions">
        <label class="action" for="import-file">Import POS export (Excel or CSV)</label>
        <input type="file" id="import-file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
      </div>
      <div id="import-report"></div>
    </div>

    <h2>Reorder rule</h2>
    <div class="card">
      <p class="sub">A product is flagged when stock falls below this many months of
      its average sales (your current rule: 1). Manual pars override this per
      product.</p>
      <div class="par-inputs">
        <input type="number" id="cover-months" min="0.25" step="0.25" inputmode="decimal" value="${cover()}">
        <span class="unit-label">months of cover</span>
      </div>
    </div>

    <h2>Demo data</h2>
    <div class="card">
      <p class="sub">Load a 40-product sample inventory (with a few par levels
      preset) to try the app. Replaces whatever is currently loaded.</p>
      <div class="actions">
        <button class="action secondary" id="load-demo">Load demo data</button>
      </div>
    </div>

    <h2>Backup</h2>
    <div class="card">
      <p class="sub">Everything you've entered (par levels, settings) lives only in
      this browser — back it up regularly.</p>
      <p>Last backup: <b>${fmtDate(state.lastBackupAt)}</b></p>
      <div class="actions">
        <button class="action" id="backup-export">Download backup file</button>
        <label class="action secondary" for="backup-file">Restore from backup</label>
        <input type="file" id="backup-file" accept=".json,application/json">
      </div>
      <div id="backup-report"></div>
    </div>

    <h2>Store</h2>
    <div class="card">
      <p class="sub">Shown on order sheets.</p>
      <input type="text" id="store-name" placeholder="Store name" value="${esc(state.storeName)}">
    </div>`;

  document.getElementById("import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const box = document.getElementById("import-report");
    readExportFile(file, (csvText, readError) => {
      if (readError) {
        box.innerHTML = `<div class="notice warn">Import failed: ${esc(readError)}</div>`;
        return;
      }
      const { products, report } = importExport(csvText, state.products, { filename: file.name });
      if (!report.ok) {
        box.innerHTML = `<div class="notice warn">Import failed: ${esc(report.error)}</div>`;
        return;
      }
      state.products = products;
      state.lastImport = {
        at: report.importedAt,
        filename: report.filename,
        imported: report.imported,
        badRows: report.badRows,
      };
      save();
      const notes = [];
      if (report.merged) notes.push(`${report.merged} duplicate row(s) merged`);
      if (report.negativeOnHand) notes.push(`${report.negativeOnHand} product(s) with negative stock — see Low Stock`);
      const bad = report.badRows.length
        ? `<div class="notice warn">Skipped ${report.badRows.length} bad row(s):<br>` +
          report.badRows.slice(0, 10).map((r) => `line ${r.line}: ${esc(r.reason)}`).join("<br>") +
          (report.badRows.length > 10 ? "<br>…" : "") + `</div>`
        : "";
      const gone = report.delisted
        ? `<div class="notice warn">${report.delisted} product(s) no longer in the export — hidden from lists (pars kept in case they return).</div>`
        : "";
      const extra = notes.length ? `<div class="notice warn">${esc(notes.join(" · "))}</div>` : "";
      box.innerHTML = `<div class="notice ok">Imported ${report.imported} products from ${esc(file.name)} (${esc(report.formatLabel)}).</div>${extra}${bad}${gone}`;
      renderDataHeaderOnly();
    });
  });

  document.getElementById("cover-months").addEventListener("change", (e) => {
    const v = Number(e.target.value);
    state.coverMonths = Number.isFinite(v) && v > 0 ? v : DEFAULT_COVER_MONTHS;
    e.target.value = state.coverMonths;
    save();
    updateTabBadge();
  });

  document.getElementById("backup-export").addEventListener("click", () => {
    state.lastBackupAt = new Date().toISOString();
    save();
    const blob = new Blob([exportBackup(state)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `store-reorder-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    renderData();
  });

  document.getElementById("backup-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = importBackup(String(reader.result));
      const box = document.getElementById("backup-report");
      if (result.error) {
        box.innerHTML = `<div class="notice warn">Restore failed: ${esc(result.error)}</div>`;
        return;
      }
      state = result.state;
      save();
      box.innerHTML = `<div class="notice ok">Backup restored — ${productCount()} products.</div>`;
      renderDataHeaderOnly();
    };
    reader.readAsText(file);
  });

  document.getElementById("store-name").addEventListener("change", (e) => {
    state.storeName = e.target.value;
    save();
  });

  wireDemoButton();
}

function wireDemoButton() {
  const btn = document.getElementById("load-demo");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Loading…";
    try {
      const { products, report } = await loadDemoData();
      state.products = products;
      state.lastImport = {
        at: report.importedAt,
        filename: report.filename,
        imported: report.imported,
        badRows: report.badRows,
      };
      if (!state.storeName) state.storeName = "Demo Store";
      save();
      currentTab = "low";
      render();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Load demo data";
      alert(`Demo load failed: ${err.message}`);
    }
  });
}

// Refresh the freshness line without re-rendering (keeps report notices visible).
function renderDataHeaderOnly() {
  freshness.textContent = state.lastImport
    ? `inventory as of ${fmtDate(state.lastImport.at)}`
    : "no inventory loaded";
  updateTabBadge();
}

// ------------------------------------------------------------------- wiring

document.querySelectorAll(".tab").forEach((b) => {
  b.addEventListener("click", () => {
    currentTab = b.dataset.tab;
    invMode = null; // tab bar always opens the full inventory view
    render();
  });
});

render();
