import { StorageAdapter } from "./store.js";
import { importExport } from "./importer.js";
import { toUnits, toCasesBottles, formatUnits } from "./units.js";
import { lowStockTiers, TIER_FAST, TIER_STEADY, unsetPar, needsInventoryFix, orderSuggestions, effectivePar, deadlineBuckets, orderDeadlines, inventoryHealth, DEFAULT_COVER_MONTHS, DEFAULT_LEAD_TIME_DAYS } from "./reorder.js";
import { sheetText, explainSuggestion, qtyLabel } from "./ordersheet.js";
import { exportBackup, importBackup } from "./backup.js";
import { loadDemoData } from "./demo.js";
import { savePhoto, deletePhoto, getPhotoURL, hydratePhotos, thumbHtml } from "./photos.js";

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
function leadTime() { return state.leadTimeDays ?? DEFAULT_LEAD_TIME_DAYS; }

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
  else if (currentTab === "deadlines") renderDeadlines();
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

// Inventory dashboard: a stacked health bar (status colors, always paired
// with labels and counts — never color alone) and a tappable 14-day
// must-order-by timeline. Sits between the notices and the tier list.
const DAY_MS_UI = 86400000;

function healthDashboardHtml() {
  const h = inventoryHealth(state.products, cover());
  if (h.tracked === 0) return "";
  const pct = Math.round((h.healthy / h.tracked) * 100);
  const seg = (n, cls) => n > 0 ? `<div class="seg ${cls}" style="flex:${n}"></div>` : "";
  // Segment order (good→warning→critical→serious) is CVD-validated.
  const bar = `
    <div class="healthbar" role="img" aria-label="${pct}% of tracked items healthy">
      ${seg(h.healthy, "good")}${seg(h.low, "warn")}${seg(h.out, "crit")}${seg(h.negative, "fix")}
    </div>
    <div class="health-legend">
      <span><i class="dot good"></i>healthy ${h.healthy}</span>
      <span><i class="dot warn"></i>low ${h.low}</span>
      <span><i class="dot crit"></i>out ${h.out}</span>
      ${h.negative ? `<span><i class="dot fix"></i>fix ${h.negative}</span>` : ""}
    </div>`;

  // 14-day deadline timeline: "Now" bar (overdue) then one bar per day.
  const dl = orderDeadlines(state.products, { coverMonths: cover(), leadTimeDays: leadTime(), now: Date.now() });
  const cols = [{ label: "Now", items: [] }];
  for (let d = 1; d <= 13; d++) {
    const dt = new Date(Date.now() + d * DAY_MS_UI);
    cols.push({ label: `${dt.getMonth() + 1}/${dt.getDate()}`, items: [] });
  }
  let later = 0;
  for (const it of dl) {
    if (it.daysUntilOrder <= 0) cols[0].items.push(it);
    else if (it.daysUntilOrder <= 13) cols[it.daysUntilOrder].items.push(it);
    else later++;
  }
  const maxN = Math.max(1, ...cols.map((c) => c.items.length));
  const bars = cols.map((c, i) => {
    const n = c.items.length;
    const hgt = n === 0 ? 2 : Math.max(6, Math.round((n / maxN) * 56));
    const cls = i === 0 ? "crit" : i <= 3 ? "warn" : "ok";
    return `
      <button class="dl-col" data-col="${i}" aria-label="${n} bottle${n === 1 ? "" : "s"} due ${c.label === "Now" ? "now" : "on day " + c.label}">
        <span class="dl-count">${n > 0 ? n : ""}</span>
        <span class="dl-bar ${cls}" style="height:${hgt}px"></span>
        <span class="dl-day">${c.label}</span>
      </button>`;
  }).join("");

  return `
    <div class="card" id="dashboard">
      <div class="sub"><b>${pct}%</b> of ${h.tracked} tracked items at a healthy level</div>
      ${bar}
      <div class="sub" style="margin-top:12px">Bottles that must be ordered — next 2 weeks (tap a bar)</div>
      <div class="dl-chart">${bars}</div>
      ${later > 0 ? `<div class="sub">+${later} more due later than 2 weeks</div>` : ""}
      <div id="dl-detail"></div>
    </div>`;
}

function wireDashboard() {
  const dl = orderDeadlines(state.products, { coverMonths: cover(), leadTimeDays: leadTime(), now: Date.now() });
  document.querySelectorAll(".dl-col").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".dl-col").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      const i = Number(btn.dataset.col);
      const items = dl
        .filter((it) => (i === 0 ? it.daysUntilOrder <= 0 : it.daysUntilOrder === i))
        .sort((a, b) =>
          Math.max(0, a.onHandUnits) / a.effParUnits - Math.max(0, b.onHandUnits) / b.effParUnits ||
          (b.avgMonthlyUnits ?? -1) - (a.avgMonthlyUnits ?? -1));
      renderDlDetail(items, i, false);
    });
  });
}

// Deadline detail panel: a few rows first, then "See more" expands the rest.
const DL_PREVIEW_COUNT = 5;

function renderDlDetail(items, colIndex, expanded) {
  const box = document.getElementById("dl-detail");
  if (items.length === 0) {
    box.innerHTML = `<div class="sub" style="margin-top:8px">Nothing due ${colIndex === 0 ? "now" : "that day"}.</div>`;
    return;
  }
  const title = colIndex === 0
    ? "Must order now"
    : `Must order by ${new Date(items[0].deadlineDate + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  const shown = expanded ? items : items.slice(0, DL_PREVIEW_COUNT);
  const hidden = items.length - shown.length;
  box.innerHTML = `
    <div class="dl-detail-title">${esc(title)} (${items.length})</div>
    ${shown.map((p) => `
      <div class="dl-row" data-barcode="${esc(p.barcode)}">
        <span class="dl-row-name">${thumbHtml(p.barcode)}<span>${esc(p.name)} <span class="sub">${esc(p.size)}</span></span></span>
        <span class="sub">${p.suggestedCases > 0 ? `order ${qtyLabel(p.suggestedCases, p.packSize)}` : `${formatUnits(p.onHandUnits, p.packSize)} / ${formatUnits(p.effParUnits, p.packSize)}`}</span>
      </div>`).join("")}
    ${hidden > 0 ? `<button class="chip" id="dl-see-more">See ${hidden} more</button>` : ""}`;
  box.querySelectorAll(".dl-row").forEach((el) => {
    el.addEventListener("click", () => openParEditor(el.dataset.barcode));
  });
  document.getElementById("dl-see-more")?.addEventListener("click", () => {
    renderDlDetail(items, colIndex, true);
  });
  hydratePhotos(box);
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
      ${thumbHtml(p.barcode)}
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

  html += healthDashboardHtml();

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
  wireDashboard();
  hydratePhotos(view);
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
          ${thumbHtml(p.barcode)}
          <div style="flex:1">
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
  hydratePhotos(list);
}

function openParEditor(barcode) {
  const p = state.products[barcode];
  if (!p) return;
  const packed = p.packSize > 1;
  const cur = p.parUnits == null
    ? { cases: "", bottles: "" }
    : packed ? toCasesBottles(p.parUnits, p.packSize) : { cases: p.parUnits, bottles: 0 };
  const autoTarget = p.avgMonthlyUnits > 0 ? Math.ceil(p.avgMonthlyUnits * cover()) : null;

  const q = encodeURIComponent(`${p.name} ${p.size}`);
  view.innerHTML = `
    <h2>${esc(p.name)} ${esc(p.size)}</h2>
    <div class="card photo-card">
      ${thumbHtml(p.barcode, "lg")}
      <div class="photo-actions">
        <label class="action secondary" for="photo-file">📷 Take photo</label>
        <input type="file" id="photo-file" accept="image/*" capture="environment">
        <label class="action secondary" for="photo-gallery">🖼 From gallery</label>
        <input type="file" id="photo-gallery" accept="image/*">
        <button class="action secondary" id="photo-paste">📋 Paste image</button>
        <button class="action secondary" id="photo-remove" hidden>Remove photo</button>
        <span class="sub">Find it online:
          <a href="https://www.totalwine.com/search/all?text=${q}" target="_blank" rel="noopener">Total Wine ↗</a> ·
          <a href="https://www.google.com/search?tbm=isch&q=${q}%20bottle" target="_blank" rel="noopener">Images ↗</a>
        </span>
      </div>
    </div>
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

  // Photo wiring: capture → downscale → store; thumbnail refreshes in place.
  hydratePhotos(view);
  const removeBtn = document.getElementById("photo-remove");
  getPhotoURL(p.barcode).then((url) => { if (url) removeBtn.hidden = false; });
  const attach = async (file) => {
    if (!file) return;
    try {
      await savePhoto(p.barcode, file);
      await hydratePhotos(view);
      removeBtn.hidden = false;
    } catch (err) {
      alert(`Could not save photo: ${err.message}`);
    }
  };
  document.getElementById("photo-file").addEventListener("change", (e) => attach(e.target.files[0]));
  document.getElementById("photo-gallery").addEventListener("change", (e) => attach(e.target.files[0]));
  document.getElementById("photo-paste").addEventListener("click", async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) return attach(await item.getType(type));
      }
      alert("No image on the clipboard — long-press the photo on the website and copy it first.");
    } catch {
      alert("Couldn't read the clipboard — your browser may not allow it. Save the image to your gallery instead and use 'From gallery'.");
    }
  });
  removeBtn.addEventListener("click", async () => {
    await deletePhoto(p.barcode);
    openParEditor(barcode);
  });
}

// "Order By" tab: every product with a depletion clock, grouped by the date
// it must be ordered to keep the shelf at target (delivery lead time
// included). Buckets collapsed by default; soonest deadline first inside.
function deadlineItemHtml(p) {
  const overdue = p.daysUntilOrder <= 0;
  const when = overdue
    ? (p.daysUntilOrder === 0 ? "due today" : `overdue ${-p.daysUntilOrder} day${p.daysUntilOrder === -1 ? "" : "s"}`)
    : p.daysUntilOrder >= 14
      ? `in ~${Math.round(p.daysUntilOrder / 7)} wks`
      : `in ${p.daysUntilOrder} day${p.daysUntilOrder === 1 ? "" : "s"}`;
  const date = new Date(p.deadlineDate + "T00:00:00")
    .toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const sells = p.avgMonthlyUnits != null ? ` · sells ~${p.avgMonthlyUnits}/mo` : "";
  return `
    <div class="item" data-barcode="${esc(p.barcode)}">
      ${thumbHtml(p.barcode)}
      <div style="flex:1">
        <div class="name">${esc(p.name)} <span class="sub">${esc(p.size)}</span></div>
        <div class="sub">must order by <b>${esc(date)}</b> (${esc(when)})${sells}</div>
      </div>
      <div class="qty">
        ${p.suggestedCases > 0 ? `<span class="badge ${overdue ? "zero" : "low"}">order ${qtyLabel(p.suggestedCases, p.packSize)}</span>` : ""}
        <div class="sub">${formatUnits(p.onHandUnits, p.packSize)} / ${formatUnits(p.effParUnits, p.packSize)}</div>
      </div>
    </div>`;
}

function renderDeadlines() {
  const b = deadlineBuckets(state.products, { coverMonths: cover(), leadTimeDays: leadTime(), now: Date.now() });
  let html = "";

  if (b.all.length === 0) {
    html = `<div class="empty">No order deadlines yet — import a POS export with
      sales history, or set par levels, to build the schedule.</div>`;
  } else {
    html += `
      <div class="card summary-row">
        <div><b>${b.overdue.length}</b> to order now · <b>${b.week.length}</b> due this week
          <div class="sub">assumes ${leadTime()}-day delivery — change under Data</div></div>
      </div>`;
    const groups = [
      ["overdue", "🔴 Order now (overdue)"],
      ["week", "Due this week"],
      ["twoWeeks", "Due in 2 weeks"],
      ["month", "Due this month"],
    ];
    for (const [key, label] of groups) {
      const items = b[key];
      if (items.length === 0) continue;
      html += `
        <details class="card tier">
          <summary>${label} (${items.length})</summary>
          ${items.map(deadlineItemHtml).join("")}
        </details>`;
    }
    if (b.later.length > 0) {
      html += `<div class="empty">${b.later.length} more item${b.later.length === 1 ? "" : "s"} not due for 30+ days.</div>`;
    }
  }
  view.innerHTML = html;

  view.querySelectorAll(".item[data-barcode]").forEach((el) => {
    el.addEventListener("click", () => openParEditor(el.dataset.barcode));
  });
  hydratePhotos(view);
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

    <h2>Delivery lead time</h2>
    <div class="card">
      <p class="sub">How many days between placing an order and it arriving.
      The Order By tab subtracts this from each product's run-out date.</p>
      <div class="par-inputs">
        <input type="number" id="lead-days" min="0" step="1" inputmode="numeric" value="${leadTime()}">
        <span class="unit-label">days</span>
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

  document.getElementById("lead-days").addEventListener("change", (e) => {
    const v = Math.floor(Number(e.target.value));
    state.leadTimeDays = Number.isFinite(v) && v >= 0 ? v : DEFAULT_LEAD_TIME_DAYS;
    e.target.value = state.leadTimeDays;
    save();
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
