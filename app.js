/**
 * ====================================================================
 * 教材在庫管理システム - Firestore 完全統合版 (app.js)
 * ローカル判定復元・ロジック最適化済み
 * ====================================================================
 */

import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  doc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";

/**
 * =========================
 * 設定・定数
 * =========================
 */
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
const AUTO_SAVE_INTERVAL_MS = 10000;

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
  visibleCount: INITIAL_VISIBLE_COUNT,
  autoSaveTimerId: null
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
  
  if (state.roomKey) {
    await loadAppData();
    startAutoSave();
  } else {
    // 閲覧モードまたはローカル確認（roomパラメータなし）
    buildStateFromFirestore(MASTER_DATA, new Map());
    generateCategoryChips();
    applyFilterAndRender();
    if (!state.roomLabel) setStatus("閲覧モード（保存不可）");
  }
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

  // --- ローカル・閲覧モード判定の復元 ---
  if (roomLabelEl) {
    const isLocal = 
      location.protocol === "file:" || 
      location.hostname === "localhost" || 
      location.hostname === "127.0.0.1";

    if (state.roomKey && state.roomLabel) {
      roomLabelEl.textContent = state.roomLabel;
    } else if (isLocal) {
      roomLabelEl.textContent = "ローカル確認用";
      roomLabelEl.classList.add("muted");
    } else {
      roomLabelEl.textContent = "閲覧モード";
      roomLabelEl.classList.add("muted");
      if (sendBtn) sendBtn.style.display = "none";
    }
  }

  // 検索・フィルタ
  searchInput?.addEventListener("input", debounce((e) => {
    state.query = String(e.target.value || "").trim().toLowerCase();
    state.visibleCount = INITIAL_VISIBLE_COUNT;
    applyFilterAndRender();
  }, SEARCH_DEBOUNCE_MS));

  filterArea?.addEventListener("click", (e) => {
    const chip = e.target.closest(".f-chip");
    if (!chip || chip.dataset.filter === state.activeFilter) return;
    document.querySelectorAll(".f-chip").forEach(el => el.classList.remove("active"));
    chip.classList.add("active");
    state.activeFilter = chip.dataset.filter;
    state.visibleCount = INITIAL_VISIBLE_COUNT;
    applyFilterAndRender();
  });

  list?.addEventListener("click", handleListClick);
  sendBtn?.addEventListener("click", () => sendData({ silent: false }));

  // ダイアログ・メニュー
  document.getElementById("toolMenuBtn")?.addEventListener("click", () => openModal("toolMenuDialog"));
  document.getElementById("closeToolMenuBtn")?.addEventListener("click", () => closeModal("toolMenuDialog"));
  document.getElementById("toolMenuBtnAddCustom")?.addEventListener("click", () => {
    closeModal("toolMenuDialog");
    openModal("customItemDialog");
  });

  document.getElementById("customQtyMinus")?.addEventListener("click", () => changeCustomQty(-1));
  document.getElementById("customQtyPlus")?.addEventListener("click", () => changeCustomQty(1));
  document.getElementById("customItemForm")?.addEventListener("submit", handleCustomItemSubmit);
  document.getElementById("cancelCustomBtn")?.addEventListener("click", () => closeModal("customItemDialog"));

  // バックアップ
  document.getElementById("exportJsonBtn")?.addEventListener("click", () => {
    closeModal("toolMenuDialog");
    exportJsonBackup();
  });
  document.getElementById("importJsonBtn")?.addEventListener("click", () => {
    closeModal("toolMenuDialog");
    document.getElementById("importFileInput")?.click();
  });
  document.getElementById("importFileInput")?.addEventListener("change", importJsonBackup);

  attachDialogBackdropClose("toolMenuDialog");
  attachDialogBackdropClose("customItemDialog");
}

/**
 * =========================
 * データ同期 (Firestore)
 * =========================
 */
async function loadAppData() {
  const started = performance.now();
  setStatus("データ同期中...");

  try {
    const inventoryMap = await loadInventoryFromFirestore(state.roomKey);
    buildStateFromFirestore(MASTER_DATA, inventoryMap);

    generateCategoryChips();
    updateStatsUI();
    applyFilterAndRender();

    const sec = ((performance.now() - started) / 1000).toFixed(2);
    setStatus(`同期完了: ${sec}秒`);
  } catch (err) {
    console.error(err);
    setStatus(`取得失敗: ${err.message}`);
  }
}

async function loadInventoryFromFirestore(roomKey) {
  const inventoryMap = new Map();
  if (!roomKey) return inventoryMap;

  try {
    const itemsRef = collection(db, "inventory", roomKey, "items");
    const snapshot = await getDocs(itemsRef);
    snapshot.forEach(docSnap => {
      inventoryMap.set(docSnap.id, docSnap.data());
    });
  } catch (err) {
    console.error("Firestore読込失敗:", err);
  }
  return inventoryMap;
}

function buildStateFromFirestore(masterData, inventoryMap) {
  state.items = [];
  state.itemsById = new Map();
  state.originalSnapshotMap = Object.create(null);
  state.totalQty = 0;
  state.dirtyCount = 0;

  // 1. マスタデータの統合
  masterData.forEach(m => {
    const id = String(m.id || "").trim();
    if (!id) return;

    const savedData = inventoryMap.get(id) || {};
    const item = normalizeItem({
      ...m,
      qty: Number(savedData.qty) || 0,
      isCustom: false
    });
    pushItemToState(item);
    inventoryMap.delete(id); // 処理済みとして削除
  });

  // 2. マスタ外教材（Firestoreに残っている未知のID）の統合
  inventoryMap.forEach((data, id) => {
    const item = normalizeItem({
      ...data,
      id,
      isCustom: true
    });
    pushItemToState(item);
  });
  
  recalcTotalQty();
}

function pushItemToState(item) {
  state.items.push(item);
  state.itemsById.set(item.id, item);
  state.originalSnapshotMap[item.id] = snapshotKey(item);
}

/**
 * =========================
 * 保存処理 (Firestore)
 * =========================
 */
async function sendData({ silent = false } = {}) {
  if (!state.roomKey || state.isSyncing) return;

  const dirtyItems = state.items.filter(item => 
    snapshotKey(item) !== state.originalSnapshotMap[item.id]
  );

  if (dirtyItems.length === 0) {
    if (!silent) setStatus("変更はありません。");
    return;
  }

  state.isSyncing = true;
  updateStatsUI();
  setStatus(silent ? "自動保存中..." : "保存中...");

  try {
    for (const item of dirtyItems) {
      const ref = doc(db, "inventory", state.roomKey, "items", item.id);
      await setDoc(ref, {
        name: item.name,
        category: item.category,
        subject: item.subject,
        publisher: item.publisher,
        edition: item.edition,
        qty: item.qty,
        isCustom: item.isCustom,
        updatedAt: serverTimestamp()
      }, { merge: true });

      state.originalSnapshotMap[item.id] = snapshotKey(item);
      item.__dirty = false;
    }

    state.dirtyCount = 0;
    setStatus(silent ? "自動保存完了" : "保存しました。");
  } catch (err) {
    console.error("保存失敗:", err);
    setStatus("保存失敗しました");
  } finally {
    state.isSyncing = false;
    updateStatsUI();
  }
}

/**
 * =========================
 * 描画ロジック
 * =========================
 */
function generateCategoryChips() {
  const container = document.getElementById("filterArea");
  if (!container) return;

  const categories = Array.from(new Set(state.items.map(item => item.category).filter(Boolean)));
  
  const isActive = (key) => state.activeFilter === key ? " active" : "";
  let html = `<button type="button" class="f-chip${isActive("all")}" data-filter="all">すべて</button>`;
  html += `<button type="button" class="f-chip${isActive("input")}" data-filter="input">入力済み</button>`;
  html += `<button type="button" class="f-chip${isActive("custom")}" data-filter="custom">未登録教材</button>`;

  categories
    .filter(c => c && c !== "未登録教材")
    .forEach(c => {
      html += `<button type="button" class="f-chip${isActive(c)}" data-filter="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
    });

  container.innerHTML = html;
}

function applyFilterAndRender() {
  const q = state.query;
  const filter = state.activeFilter;

  state.filteredItems = state.items.filter(item => {
    const matchesQuery = !q || item.searchTag.includes(q);
    if (!matchesQuery) return false;

    if (filter === "custom") return item.isCustom;
    if (item.isCustom) return false;

    if (filter === "input") return item.qty > 0;
    if (filter === "all") return true;
    return item.category === filter;
  });

  renderFilteredItems();
}

function renderFilteredItems() {
  const container = document.getElementById("list");
  if (!container) return;

  if (state.filteredItems.length === 0) {
    container.innerHTML = `<div class="empty">該当する教材がありません。</div>`;
    return;
  }

  const visibleItems = state.filteredItems.slice(0, state.visibleCount);
  let html = visibleItems.map(item => renderItemHTML(item)).join("");

  if (state.filteredItems.length > state.visibleCount) {
    const remain = state.filteredItems.length - state.visibleCount;
    html += `
      <div class="empty" style="padding:24px 16px;">
        <button id="loadMoreBtn" type="button" class="btn-subtle">さらに表示（あと${remain}件）</button>
      </div>`;
  }

  container.innerHTML = html;
}

function renderItemHTML(item) {
  const topMeta = [item.publisher, item.edition].filter(Boolean).join(" / ");
  return `
    <article class="item ${item.qty > 0 ? "has-qty" : ""} ${item.isCustom ? "custom-item" : ""}" data-id="${escapeHtml(item.id)}">
      <div class="item-main">
        <div class="item-topline">
          <div class="item-badges">
            <span class="badge badge-cat">${escapeHtml(item.category)}</span>
            ${item.subject ? `<span class="badge badge-sub">${escapeHtml(item.subject)}</span>` : ""}
            ${item.isCustom ? `<span class="badge badge-custom">未登録教材</span>` : ""}
          </div>
          ${topMeta ? `<div class="item-publisher-top">${escapeHtml(topMeta)}</div>` : ""}
        </div>
        <div class="item-name">${escapeHtml(item.name)}</div>
      </div>
      <div class="qty-box">
        <button type="button" class="qty-btn minus">−</button>
        <div class="qty-num num">${item.qty}</div>
        <button type="button" class="qty-btn plus">＋</button>
      </div>
    </article>`;
}

/**
 * =========================
 * 各種操作・計算
 * =========================
 */
function handleListClick(e) {
  const loadMoreBtn = e.target.closest("#loadMoreBtn");
  if (loadMoreBtn) {
    state.visibleCount += LOAD_MORE_COUNT;
    renderFilteredItems();
    return;
  }

  const btn = e.target.closest(".qty-btn");
  if (!btn) return;

  const card = btn.closest(".item");
  const item = state.itemsById.get(card?.dataset.id);
  if (!item) return;

  const diff = btn.classList.contains("plus") ? 1 : -1;
  const newQty = Math.max(0, item.qty + diff);

  if (newQty !== item.qty) {
    item.qty = newQty;
    card.querySelector(".qty-num").textContent = String(newQty);
    card.classList.toggle("has-qty", newQty > 0);
    applyDirtyRecalcForItem(item);
    updateStatsUI();
  }
}

function handleCustomItemSubmit(e) {
  e.preventDefault();
  const name = document.getElementById("customName")?.value.trim();
  if (!name) return;

  const publisher = document.getElementById("customPublisher")?.value.trim() || "";
  const edition = document.getElementById("customEdition")?.value.trim() || "";
  const qty = Number(document.getElementById("customQtyValue")?.textContent) || 0;
  const item = normalizeItem({
    id: `CUSTOM-${Date.now()}`,
    name,
    publisher,
    edition,
    category: "未登録教材",
    qty,
    isCustom: true
  });

  state.items.unshift(item);
  state.itemsById.set(item.id, item);
  item.__dirty = true;
  state.dirtyCount++;

  recalcTotalQty();
  generateCategoryChips();
  state.activeFilter = "custom";
  applyFilterAndRender();
  updateActiveFilterChip();
  updateStatsUI();
  closeModal("customItemDialog");
  resetCustomItemForm();
  setStatus("未登録教材を追加しました（未保存）");
}

function applyDirtyRecalcForItem(item) {
  const isDirty = snapshotKey(item) !== (state.originalSnapshotMap[item.id] || "");
  const wasDirty = !!item.__dirty;
  item.__dirty = isDirty;
  if (!wasDirty && isDirty) state.dirtyCount++;
  if (wasDirty && !isDirty) state.dirtyCount--;
  recalcTotalQty();
}

function recalcTotalQty() {
  state.totalQty = state.items.reduce((sum, item) => sum + item.qty, 0);
}

function updateStatsUI() {
  const totalQtyEl = document.getElementById("totalQty");
  if (totalQtyEl) totalQtyEl.textContent = String(state.totalQty);
  const sendBtn = document.getElementById("sendBtn");
  if (sendBtn) {
    sendBtn.disabled = state.isSyncing || state.dirtyCount === 0;
    sendBtn.classList.toggle("dirty", state.dirtyCount > 0);
  }
}

/**
 * =========================
 * バックアップ
 * =========================
 */
function exportJsonBackup() {
  const data = {
    exportedAt: new Date().toISOString(),
    roomKey: state.roomKey,
    items: state.items.map(i => ({ ...i }))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `inventory_${state.roomKey || 'viewer'}_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importJsonBackup(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const data = JSON.parse(event.target.result);
      if (!Array.isArray(data.items)) throw new Error("無効な形式");
      
      const invMap = new Map();
      data.items.forEach(i => invMap.set(i.id, i));
      buildStateFromFirestore(MASTER_DATA, invMap);
      
      // 全て「変更あり」にする
      state.items.forEach(item => { item.__dirty = true; });
      state.dirtyCount = state.items.length;
      
      applyFilterAndRender();
      updateStatsUI();
      setStatus("JSONを読み込みました（保存ボタンで反映）");
    } catch (err) {
      alert("JSONの読み込みに失敗しました");
    }
  };
  reader.readAsText(file);
}

/**
 * =========================
 * 共通ツール
 * =========================
 */
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
  item.searchTag = `${item.name} ${item.category} ${item.subject} ${item.publisher} ${item.edition} ${item.isCustom ? "未登録教材" : ""}`.toLowerCase();
  return item;
}

function snapshotKey(item) {
  return JSON.stringify({
    id: item.id,
    name: item.name,
    category: item.category,
    subject: item.subject,
    publisher: item.publisher,
    edition: item.edition,
    qty: item.qty,
    isCustom: item.isCustom
  });
}

function updateActiveFilterChip() {
  document.querySelectorAll(".f-chip").forEach(el => {
    el.classList.toggle("active", el.dataset.filter === state.activeFilter);
  });
}

function resetCustomItemForm() {
  document.getElementById("customItemForm")?.reset();
  const qtyEl = document.getElementById("customQtyValue");
  if (qtyEl) qtyEl.textContent = "1";
}

function setStatus(msg) {
  const el = document.getElementById("statusLine");
  if (el) el.textContent = `[${new Date().toLocaleTimeString("ja-JP")}] ${msg}`;
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function openModal(id) {
  const d = document.getElementById(id);
  if (d && !d.open) d.showModal();
}

function closeModal(id) {
  const d = document.getElementById(id);
  if (d && d.open) d.close();
}

function changeCustomQty(diff) {
  const el = document.getElementById("customQtyValue");
  if (el) el.textContent = Math.max(0, (Number(el.textContent) || 0) + diff);
}

function startAutoSave() {
  if (state.autoSaveTimerId) clearInterval(state.autoSaveTimerId);
  state.autoSaveTimerId = setInterval(() => sendData({ silent: true }), AUTO_SAVE_INTERVAL_MS);
}

function escapeHtml(v) {
  return String(v || "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
}

function attachDialogBackdropClose(id) {
  const d = document.getElementById(id);
  d?.addEventListener("click", e => { if (e.target === d) d.close(); });
}
