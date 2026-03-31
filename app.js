/**
 * ====================================================================
 * 教材在庫管理システム - フロントエンド・スクリプト
 * HTML変更版対応 / 初期表示30件 / 自動保存対応版
 * ====================================================================
 */

/**
 * =========================
 * 設定・定数
 * =========================
 */
const GAS_URL = "https://script.google.com/macros/s/AKfycbz0HdzSg-7ABwypga37Fb0sn7EYDb0CtJ7o83wXEEHjRAVKspAtqT1FNgHiGq89Sj5DrA/exec";

const ROOM_LABEL_MAP = {
  takadanobaba: "高田馬場",
  sugamo: "巣鴨",
  nishinippori: "西日暮里",
  ohji: "王子",
  itabashi: "板橋",
  minamisenju: "南千住",
  kiba: "木場",
  gakuin: "学院"
};

const SEARCH_DEBOUNCE_MS = 120;
const INITIAL_VISIBLE_COUNT = 30;
const LOAD_MORE_COUNT = 30;

/* 自動保存間隔（ミリ秒） */
const AUTO_SAVE_INTERVAL_MS = 30000;

/**
 * アプリケーション状態
 */
const state = {
  roomKey: "",
  roomLabel: "",
  items: [],
  itemsById: new Map(),
  filteredItems: [],
  activeFilter: "all",
  query: "",
  isSyncing: false,
  totalQty: 0,
  dirtyCount: 0,
  originalSnapshotMap: Object.create(null),
  lastUpdatedAt: "",
  visibleCount: INITIAL_VISIBLE_COUNT,
  autoSaveTimerId: null,
  lastStatusMessage: ""
};

/**
 * =========================
 * 起動処理
 * =========================
 */
document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(location.search);
  state.roomKey = (params.get("room") || "").trim().toLowerCase();
  state.roomLabel = ROOM_LABEL_MAP[state.roomKey] || "";

  initUI();
  await loadAppData();
  startAutoSave();
});

/**
 * =========================
 * UI初期化
 * =========================
 */
function initUI() {
  const roomLabelEl = document.getElementById("roomLabel");
  const sendBtn = document.getElementById("sendBtn");
  const searchInput = document.getElementById("searchInput");
  const filterArea = document.getElementById("filterArea");
  const list = document.getElementById("list");

  if (roomLabelEl) {
    if (state.roomKey && state.roomLabel) {
      roomLabelEl.textContent = state.roomLabel;
    } else {
      roomLabelEl.textContent = "閲覧モード";
      roomLabelEl.classList.add("muted");
      if (sendBtn) sendBtn.style.display = "none";
    }
  }

  searchInput?.addEventListener("input", debounce((e) => {
    state.query = String(e.target.value || "").trim().toLowerCase();
    state.visibleCount = INITIAL_VISIBLE_COUNT;
    applyFilterAndRender();
  }, SEARCH_DEBOUNCE_MS));

  filterArea?.addEventListener("click", (e) => {
    const chip = e.target.closest(".f-chip");
    if (!chip) return;

    const next = chip.dataset.filter;
    if (!next || next === state.activeFilter) return;

    document.querySelectorAll(".f-chip").forEach(el => el.classList.remove("active"));
    chip.classList.add("active");

    state.activeFilter = next;
    state.visibleCount = INITIAL_VISIBLE_COUNT;
    applyFilterAndRender();
  });

  list?.addEventListener("click", handleListClick);
  sendBtn?.addEventListener("click", () => sendData({ silent: false, trigger: "manual" }));

  document.getElementById("toolMenuBtn")?.addEventListener("click", openToolMenu);
  document.getElementById("closeToolMenuBtn")?.addEventListener("click", closeToolMenu);

  document.getElementById("menuAddCustomBtn")?.addEventListener("click", () => {
    closeToolMenu();
    openCustomDialog();
  });

  document.getElementById("exportJsonBtn")?.addEventListener("click", () => {
    closeToolMenu();
    exportJsonBackup();
  });

  document.getElementById("exportCsvBtn")?.addEventListener("click", () => {
    closeToolMenu();
    exportCsvBackup();
  });

  document.getElementById("importJsonBtn")?.addEventListener("click", () => {
    closeToolMenu();
    document.getElementById("importFileInput")?.click();
  });

  document.getElementById("importFileInput")?.addEventListener("change", importJsonBackup);

  document.getElementById("cancelCustomBtn")?.addEventListener("click", closeCustomDialog);
  document.getElementById("customItemForm")?.addEventListener("submit", handleCustomItemSubmit);

  attachDialogBackdropClose("toolMenuDialog");
  attachDialogBackdropClose("customItemDialog");

  updateStatsUI();
  updateMetaInfo();
}

/**
 * =========================
 * 自動保存
 * =========================
 */
function startAutoSave() {
  stopAutoSave();

  if (!state.roomKey) return;

  state.autoSaveTimerId = window.setInterval(() => {
    sendData({ silent: true, trigger: "auto" });
  }, AUTO_SAVE_INTERVAL_MS);
}

function stopAutoSave() {
  if (state.autoSaveTimerId) {
    clearInterval(state.autoSaveTimerId);
    state.autoSaveTimerId = null;
  }
}

/**
 * =========================
 * ツールメニュー
 * =========================
 */
function openToolMenu() {
  const dialog = document.getElementById("toolMenuDialog");
  if (dialog && !dialog.open) dialog.showModal();
}

function closeToolMenu() {
  const dialog = document.getElementById("toolMenuDialog");
  if (dialog && dialog.open) dialog.close();
}

/**
 * =========================
 * ダイアログ
 * =========================
 */
function openCustomDialog() {
  const dialog = document.getElementById("customItemDialog");
  if (dialog && !dialog.open) dialog.showModal();
}

function closeCustomDialog() {
  const dialog = document.getElementById("customItemDialog");
  if (dialog && dialog.open) dialog.close();
}

/**
 * =========================
 * データ取得・同期
 * =========================
 */
async function loadAppData() {
  const started = performance.now();
  setStatus("データ同期中...");

  try {
    if (typeof MASTER_DATA === "undefined" || !Array.isArray(MASTER_DATA) || MASTER_DATA.length === 0) {
      throw new Error("data.js の読み込みに失敗したか、データが空です。");
    }

    const masterData = MASTER_DATA;
    let invData = { success: true, inventory: {}, extraItems: [], updatedAt: "" };

    if (state.roomKey) {
      const invRes = await fetch(`${GAS_URL}?room=${encodeURIComponent(state.roomKey)}`, {
        cache: "no-store"
      });
      if (!invRes.ok) throw new Error("在庫データの取得に失敗しました。");
      invData = await invRes.json();
    }

    if (!invData.success) {
      throw new Error(invData.message || "在庫データ取得に失敗しました。");
    }

    buildStateFromServer(masterData, invData);

    generateCategoryChips();
    updateStatsUI();
    applyFilterAndRender();

    const sec = ((performance.now() - started) / 1000).toFixed(2);
    setStatus(`同期完了: ${sec}秒`);
  } catch (err) {
    console.error(err);
    setStatus(`取得失敗: ${err.message}`);

    const listEl = document.getElementById("list");
    if (listEl) {
      listEl.innerHTML = `
        <div class="empty">
          データ取得に失敗しました。<br>
          ${escapeHtml(err.message)}
        </div>
      `;
    }

    updateMetaInfo();
  }
}

function buildStateFromServer(masterData, invData) {
  const inventory = invData.inventory || {};
  const extraItems = Array.isArray(invData.extraItems) ? invData.extraItems : [];

  state.lastUpdatedAt = invData.updatedAt || "";
  state.items = [];
  state.itemsById = new Map();
  state.filteredItems = [];
  state.totalQty = 0;
  state.dirtyCount = 0;
  state.originalSnapshotMap = Object.create(null);
  state.visibleCount = INITIAL_VISIBLE_COUNT;

  for (let i = 0; i < masterData.length; i++) {
    const m = masterData[i] || {};
    const id = String(m.id || "").trim();
    if (!id) continue;

    const item = normalizeItem({
      id,
      name: m.name || "名称不明",
      category: m.category || "未分類",
      subject: m.subject || "",
      publisher: m.publisher || "",
      edition: m.edition || "",
      qty: Number(inventory[id]) || 0,
      isCustom: false
    });

    pushItemToState(item);
  }

  for (let i = 0; i < extraItems.length; i++) {
    const src = extraItems[i] || {};
    const item = normalizeItem({
      id: exOrDefault(src.id, createCustomId_()),
      name: exOrDefault(src.name, "名称未設定"),
      category: exOrDefault(src.category, "未分類"),
      subject: exOrDefault(src.subject, ""),
      publisher: exOrDefault(src.publisher, ""),
      edition: exOrDefault(src.edition, ""),
      qty: Math.max(0, Number(src.qty) || 0),
      isCustom: true
    });

    pushItemToState(item);
  }
}

function pushItemToState(item) {
  if (!item || !item.id) return;

  state.items.push(item);
  state.itemsById.set(item.id, item);
  state.originalSnapshotMap[item.id] = snapshotKey(item);
  state.totalQty += item.qty;
}

function exOrDefault(value, fallback) {
  const s = String(value == null ? "" : value).trim();
  return s || fallback;
}

function normalizeItem(src) {
  const item = {
    id: String(src.id || "").trim(),
    name: String(src.name || "名称不明").trim(),
    category: String(src.category || "未分類").trim(),
    subject: String(src.subject || "").trim(),
    publisher: String(src.publisher || "").trim(),
    edition: String(src.edition || "").trim(),
    qty: Math.max(0, Number(src.qty) || 0),
    isCustom: !!src.isCustom,
    __dirty: false
  };

  item.searchTag = [
    item.name,
    item.category,
    item.subject,
    item.publisher,
    item.edition,
    item.isCustom ? "マスタ外" : ""
  ].join(" ").toLowerCase();

  return item;
}

function snapshotKey(item) {
  return JSON.stringify({
    name: item.name,
    category: item.category,
    subject: item.subject,
    publisher: item.publisher,
    edition: item.edition,
    qty: item.qty,
    isCustom: !!item.isCustom
  });
}

/**
 * =========================
 * フィルタ・描画
 * =========================
 */
function generateCategoryChips() {
  const container = document.getElementById("filterArea");
  if (!container) return;

  const categories = Array.from(
    new Set(state.items.map(item => item.category).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b, "ja"));

  let html = "";
  html += `<button type="button" class="f-chip active" data-filter="all">すべて</button>`;
  html += `<button type="button" class="f-chip" data-filter="input">入力済み</button>`;
  html += `<button type="button" class="f-chip" data-filter="custom">マスタ外</button>`;

  for (let i = 0; i < categories.length; i++) {
    const c = categories[i];
    html += `<button type="button" class="f-chip" data-filter="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
  }

  container.innerHTML = html;
}

function applyFilterAndRender() {
  const q = state.query;
  const filter = state.activeFilter;
  const result = [];

  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];

    if (filter === "input") {
      if (item.qty <= 0) continue;
    } else if (filter === "custom") {
      if (!item.isCustom) continue;
    } else if (filter !== "all") {
      if (item.category !== filter) continue;
    }

    if (q && !item.searchTag.includes(q)) continue;
    result.push(item);
  }

  result.sort(compareItems_);
  state.filteredItems = result;

  renderFilteredItems();
  updateMetaInfo();
}

function compareItems_(a, b) {
  if (a.isCustom !== b.isCustom) return a.isCustom ? -1 : 1;
  if (a.category !== b.category) return a.category.localeCompare(b.category, "ja");
  return a.name.localeCompare(b.name, "ja");
}

function renderFilteredItems() {
  const container = document.getElementById("list");
  if (!container) return;

  container.innerHTML = "";

  if (state.filteredItems.length === 0) {
    container.innerHTML = `<div class="empty">該当する教材がありません。</div>`;
    updateMetaInfo();
    return;
  }

  const visibleItems = state.filteredItems.slice(0, state.visibleCount);
  let html = "";

  for (let i = 0; i < visibleItems.length; i++) {
    html += renderItemHTML(visibleItems[i]);
  }

  if (state.filteredItems.length > state.visibleCount) {
    html += renderLoadMoreHTML();
  }

  container.innerHTML = html;
  updateMetaInfo();
}

function renderItemHTML(item) {
  const metaTexts = [];
  if (item.edition) metaTexts.push(`版/準拠: ${item.edition}`);

  return `
    <article class="item ${item.qty > 0 ? "has-qty" : ""} ${item.isCustom ? "custom-item" : ""}" data-id="${escapeHtml(item.id)}">
      <div class="item-main">
        <div class="item-badges">
          <span class="badge badge-cat">${escapeHtml(item.category || "未分類")}</span>
          ${item.subject ? `<span class="badge badge-sub">${escapeHtml(item.subject)}</span>` : ""}
          ${item.isCustom ? `<span class="badge badge-custom">マスタ外</span>` : ""}
        </div>

        ${item.publisher ? `<div class="item-publisher-top">${escapeHtml(item.publisher)}</div>` : ""}

        <div class="item-name">${escapeHtml(item.name)}</div>

        <div class="item-meta-text">
          ${metaTexts.length ? escapeHtml(metaTexts.join(" / ")) : " "}
        </div>
      </div>

      <div class="qty-box">
        <button type="button" class="qty-btn minus" aria-label="減らす">−</button>
        <div class="qty-num num">${item.qty}</div>
        <button type="button" class="qty-btn plus" aria-label="増やす">＋</button>
      </div>
    </article>
  `;
}

function renderLoadMoreHTML() {
  const remain = Math.max(0, state.filteredItems.length - state.visibleCount);
  const next = Math.min(LOAD_MORE_COUNT, remain);

  return `
    <div class="empty" style="padding:24px 16px;">
      <button id="loadMoreBtn" type="button" class="btn-subtle">
        さらに表示（あと${remain}件 / 次に${next}件）
      </button>
    </div>
  `;
}

/**
 * =========================
 * 数量操作
 * =========================
 */
function handleListClick(e) {
  const loadMoreBtn = e.target.closest("#loadMoreBtn");
  if (loadMoreBtn) {
    state.visibleCount += LOAD_MORE_COUNT;
    renderFilteredItems();
    return;
  }

  handleCounterClick(e);
}

function handleCounterClick(e) {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (!btn.classList.contains("plus") && !btn.classList.contains("minus")) return;

  const card = e.target.closest(".item");
  if (!card) return;

  const id = card.dataset.id;
  const item = state.itemsById.get(id);
  if (!item) return;

  const oldQty = item.qty;
  let newQty = oldQty;

  if (btn.classList.contains("plus")) {
    newQty = oldQty + 1;
  } else if (btn.classList.contains("minus")) {
    newQty = Math.max(0, oldQty - 1);
  }

  if (newQty === oldQty) return;

  item.qty = newQty;

  const qtyEl = card.querySelector(".qty-num");
  if (qtyEl) qtyEl.textContent = String(newQty);

  card.classList.toggle("has-qty", newQty > 0);

  applyDirtyRecalcForItem(item);
  updateStatsUI();

  if (state.activeFilter === "input" && newQty === 0) {
    applyFilterAndRender();
    return;
  }

  updateMetaInfo();
  setStatus("未保存の変更があります");
}

function applyDirtyRecalcForItem(item) {
  const original = state.originalSnapshotMap[item.id] || "";
  const current = snapshotKey(item);

  const wasDirty = item.__dirty === true;
  const isDirty = current !== original;

  item.__dirty = isDirty;

  if (!wasDirty && isDirty) state.dirtyCount++;
  if (wasDirty && !isDirty) state.dirtyCount--;

  if (state.dirtyCount < 0) state.dirtyCount = 0;

  recalcTotalQty();
}

function recalcAllDirtyFlags() {
  let dirtyCount = 0;

  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    const isDirty = snapshotKey(item) !== (state.originalSnapshotMap[item.id] || "");
    item.__dirty = isDirty;
    if (isDirty) dirtyCount++;
  }

  state.dirtyCount = dirtyCount;
}

function recalcTotalQty() {
  let total = 0;

  for (let i = 0; i < state.items.length; i++) {
    total += Number(state.items[i].qty) || 0;
  }

  state.totalQty = total;
}

function updateStatsUI() {
  const totalQtyEl = document.getElementById("totalQty");
  if (totalQtyEl) {
    totalQtyEl.textContent = String(state.totalQty);
  }

  const sendBtn = document.getElementById("sendBtn");
  if (sendBtn) {
    sendBtn.disabled = state.isSyncing || state.dirtyCount === 0;
    sendBtn.classList.toggle("dirty", !state.isSyncing && state.dirtyCount > 0);
  }
}

function updateMetaInfo() {
  const updatedEl = document.getElementById("updatedAt");
  if (updatedEl) {
    updatedEl.textContent = formatDateForDisplay(state.lastUpdatedAt);
  }
}

/**
 * =========================
 * 保存
 * =========================
 */
async function sendData(options = {}) {
  const { silent = false, trigger = "manual" } = options;

  if (!state.roomKey || state.isSyncing) return false;
  if (state.dirtyCount === 0) return false;

  const btn = document.getElementById("sendBtn");

  try {
    state.isSyncing = true;
    updateStatsUI();

    if (btn && !silent) btn.textContent = "保存中...";
    setStatus(trigger === "auto" ? "自動保存中..." : "保存中...");

    const payload = state.items.map(item => ({
      id: item.id,
      name: item.name,
      category: item.category,
      subject: item.subject,
      publisher: item.publisher,
      edition: item.edition,
      qty: item.qty,
      isCustom: !!item.isCustom
    }));

    const params = new URLSearchParams();
    params.append("room", state.roomKey);
    params.append("payload", JSON.stringify(payload));

    await fetch(GAS_URL, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });

    refreshOriginalSnapshotsAfterSave();
    state.lastUpdatedAt = new Date().toISOString();

    updateStatsUI();
    updateMetaInfo();

    if (trigger === "auto") {
      setStatus("自動保存しました");
    } else {
      setStatus("保存しました");
      alert("保存リクエストを送信しました。\n（反映には数秒かかる場合があります）");
    }

    return true;
  } catch (err) {
    console.error(err);
    setStatus(`保存失敗: ${err.message}`);

    if (!silent) {
      alert(`保存失敗: ${err.message}`);
    }

    return false;
  } finally {
    state.isSyncing = false;
    if (btn) btn.textContent = "保存する";
    updateStatsUI();
  }
}

function refreshOriginalSnapshotsAfterSave() {
  state.originalSnapshotMap = Object.create(null);

  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    state.originalSnapshotMap[item.id] = snapshotKey(item);
    item.__dirty = false;
  }

  state.dirtyCount = 0;
}

/**
 * =========================
 * マスタ外教材
 * =========================
 */
function handleCustomItemSubmit(e) {
  e.preventDefault();

  const name = document.getElementById("customName")?.value.trim() || "";
  const publisher = document.getElementById("customPublisher")?.value.trim() || "";
  const edition = document.getElementById("customEdition")?.value.trim() || "";
  const qty = Math.max(0, Number(document.getElementById("customQty")?.value) || 0);

  if (!name) {
    alert("教材名を入力してください。");
    return;
  }

  const item = normalizeItem({
    id: createCustomId_(),
    name,
    category: "未分類",
    subject: "",
    publisher,
    edition,
    qty,
    isCustom: true
  });

  state.items.unshift(item);
  state.itemsById.set(item.id, item);
  state.originalSnapshotMap[item.id] = "";
  item.__dirty = true;
  state.dirtyCount++;

  recalcTotalQty();
  generateCategoryChips();
  updateStatsUI();

  state.visibleCount = INITIAL_VISIBLE_COUNT;
  applyFilterAndRender();

  const form = document.getElementById("customItemForm");
  if (form) form.reset();

  const qtyInput = document.getElementById("customQty");
  if (qtyInput) qtyInput.value = "1";

  closeCustomDialog();
  setStatus("マスタ外教材を追加しました。未保存の状態です。");
}

function createCustomId_() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `CUSTOM-${Date.now()}-${rand}`;
}

/**
 * =========================
 * バックアップ
 * =========================
 */
function exportJsonBackup() {
  const data = {
    exportedAt: formatNowJa(),
    roomKey: state.roomKey,
    roomLabel: state.roomLabel,
    lastUpdatedAt: state.lastUpdatedAt,
    items: state.items.map(item => ({
      id: item.id,
      name: item.name,
      category: item.category,
      subject: item.subject,
      publisher: item.publisher,
      edition: item.edition,
      qty: item.qty,
      isCustom: !!item.isCustom
    }))
  };

  downloadTextFile_(
    `${buildFileBaseName_()}_${formatNowFile_()}.json`,
    JSON.stringify(data, null, 2),
    "application/json"
  );
  setStatus("JSONバックアップを出力しました。");
}

function exportCsvBackup() {
  const rows = [
    ["校舎", "出力日時", "ID", "教材名", "カテゴリ", "教科", "出版社", "版/準拠", "数量", "マスタ外"]
  ];
  const exportedAt = formatNowJa();

  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    rows.push([
      state.roomLabel,
      exportedAt,
      item.id,
      item.name,
      item.category,
      item.subject,
      item.publisher,
      item.edition,
      item.qty,
      item.isCustom ? "1" : "0"
    ]);
  }

  const csv = rows.map(row => row.map(csvEscape_).join(",")).join("\r\n");

  downloadTextFile_(
    `${buildFileBaseName_()}_${formatNowFile_()}.csv`,
    "\uFEFF" + csv,
    "text/csv;charset=utf-8"
  );
  setStatus("CSVバックアップを出力しました。");
}

function importJsonBackup(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const reader = new FileReader();

  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result || "{}"));
      if (!Array.isArray(data.items)) {
        throw new Error("items 配列が見つかりません。");
      }

      const nextItems = data.items.map(item => normalizeItem(item));
      state.items = nextItems;
      state.itemsById = new Map();

      for (let i = 0; i < nextItems.length; i++) {
        state.itemsById.set(nextItems[i].id, nextItems[i]);
      }

      state.originalSnapshotMap = Object.create(null);
      for (let i = 0; i < nextItems.length; i++) {
        state.originalSnapshotMap[nextItems[i].id] = "";
      }

      state.lastUpdatedAt = data.lastUpdatedAt || state.lastUpdatedAt;
      state.visibleCount = INITIAL_VISIBLE_COUNT;

      recalcAllDirtyFlags();
      recalcTotalQty();
      generateCategoryChips();
      applyFilterAndRender();
      updateStatsUI();
      updateMetaInfo();

      setStatus("JSONバックアップを読み込みました。保存前のため未反映です。");
      alert("JSONを取り込みました。\nこの時点ではまだサーバー保存されていません。");
    } catch (err) {
      console.error(err);
      alert(`JSON取込に失敗しました: ${err.message}`);
      setStatus(`JSON取込失敗: ${err.message}`);
    } finally {
      e.target.value = "";
    }
  };

  reader.onerror = () => {
    alert("ファイルの読み込みに失敗しました。");
    e.target.value = "";
  };

  reader.readAsText(file, "utf-8");
}

function downloadTextFile_(filename, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildFileBaseName_() {
  return `inventory_${state.roomKey || "viewer"}`;
}

function formatNowFile_() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

function csvEscape_(value) {
  const s = String(value == null ? "" : value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * =========================
 * ユーティリティ
 * =========================
 */
function setStatus(msg) {
  state.lastStatusMessage = msg;

  const now = new Date().toLocaleTimeString("ja-JP");
  const el = document.getElementById("statusLine");
  if (el) {
    const total = state.filteredItems.length;
    const visible = Math.min(state.visibleCount, total);
    const suffix = total > 0 ? `（${total}件中 ${visible}件表示）` : "";
    el.textContent = `[${now}] ${msg}${suffix}`;
  }
}

function debounce(fn, wait) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

function formatNowJa() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}

function formatDateForDisplay(value) {
  if (!value) return "-";

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);

  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    }[ch];
  });
}

function attachDialogBackdropClose(dialogId) {
  const dialog = document.getElementById(dialogId);
  if (!dialog) return;

  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) {
      dialog.close();
    }
  });
}
