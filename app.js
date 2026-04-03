/**
 * ====================================================================
 * 教材在庫管理システム - Firestore token URL 対応版 (app.js)
 * Googleログイン不要 / token付きURLでアクセス / 編集後5秒で1回だけ自動保存
 * 保存先: inventory/{token}/items/{itemId}
 * ====================================================================
 */

import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  getDoc,
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
const AUTO_SAVE_DELAY_MS = 5000;

const RETRY_GUIDE_MESSAGE =
  "自動保存に失敗しました。保存ボタンで再試行してください。通信状態が安定しない場合は、メニューの「ファイルに保存」をご利用ください。";
const RETRY_SHORT_MESSAGE =
  "未保存の変更があります。保存ボタンで再試行してください。";

/**
 * アプリケーション状態
 */
const state = {
  token: "",
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
  autoSaveTimerId: null,
  autoSaveSuspended: false,
  hasShownRetryNotice: false,
  lastStatusMessage: "",
  isLocalPreview: false,
  accessReady: false,
  accessGranted: false,
  tokenDocExists: false,
  tokenDocData: null
};

/**
 * =========================
 * 起動処理
 * =========================
 */
document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(location.search);
  state.token = (params.get("token") || "").trim();

  state.isLocalPreview = (
    location.protocol === "file:" ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1"
  );

  initUI();

  if (!state.token) {
    buildStateFromFirestore(MASTER_DATA, new Map());
    generateCategoryChips();
    applyFilterAndRender();
    updateStatsUI();
    setStatus(
      state.isLocalPreview
        ? "ローカル確認用です。保存は行いません。"
        : "URLが無効です。token がありません。"
    );
    setReadOnlyMode(true);
    updateAccessUI("有効なURLではありません。");
    return;
  }

  if (state.isLocalPreview) {
    state.roomLabel = "ローカル確認用";
    updateRoomLabel();
    buildStateFromFirestore(MASTER_DATA, new Map());
    generateCategoryChips();
    applyFilterAndRender();
    updateStatsUI();
    setStatus("ローカル確認用です。Firestore保存は行いません。");
    setReadOnlyMode(true);
    updateAccessUI("ローカル確認用です。");
    return;
  }

  await initAccessAndLoad();
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
    if (state.roomLabel) {
      roomLabelEl.textContent = state.roomLabel;
    } else if (state.isLocalPreview) {
      roomLabelEl.textContent = "ローカル確認用";
      roomLabelEl.classList.add("muted");
    } else {
      roomLabelEl.textContent = "確認中";
      roomLabelEl.classList.add("muted");
    }
  }

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

  sendBtn?.addEventListener("click", () => {
    if (!canEdit()) {
      setStatus("このURLでは保存できません。");
      return;
    }
    sendData({ silent: false, isManualRetry: true });
  });

  document.getElementById("toolMenuBtn")?.addEventListener("click", () => openModal("toolMenuDialog"));
  document.getElementById("closeToolMenuBtn")?.addEventListener("click", () => closeModal("toolMenuDialog"));

  document.getElementById("toolMenuBtnAddCustom")?.addEventListener("click", () => {
    if (!canEdit()) {
      setStatus("このURLでは未登録教材を追加できません。");
      return;
    }
    closeModal("toolMenuDialog");
    openModal("customItemDialog");
  });

  document.getElementById("customQtyMinus")?.addEventListener("click", () => changeCustomQty(-1));
  document.getElementById("customQtyPlus")?.addEventListener("click", () => changeCustomQty(1));
  document.getElementById("customItemForm")?.addEventListener("submit", handleCustomItemSubmit);
  document.getElementById("cancelCustomBtn")?.addEventListener("click", () => closeModal("customItemDialog"));

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
 * tokenアクセス確認
 * =========================
 */
async function initAccessAndLoad() {
  try {
    setStatus("アクセス情報を確認しています...");
    updateAccessUI("アクセス情報を確認しています...");

    const tokenRef = doc(db, "inventory", state.token);
    const tokenSnap = await getDoc(tokenRef);

    state.accessReady = true;
    state.tokenDocExists = tokenSnap.exists();

    if (!tokenSnap.exists()) {
      setReadOnlyMode(true);
      updateAccessUI("URLが無効です。");
      setStatus("URLが無効です。");
      renderEmptyMessage("このURLは無効です。");
      updateStatsUI();
      return;
    }

    const tokenData = tokenSnap.data() || {};
    state.tokenDocData = tokenData;

    if (tokenData.enabled !== true) {
      setReadOnlyMode(true);
      state.accessGranted = false;
      state.roomKey = String(tokenData.roomKey || "").trim();
      state.roomLabel = String(tokenData.roomLabel || ROOM_LABEL_MAP[state.roomKey] || "").trim();
      updateRoomLabel();
      updateAccessUI("このURLは現在無効です。");
      setStatus("このURLは現在無効です。");
      renderEmptyMessage("このURLは現在無効です。");
      updateStatsUI();
      return;
    }

    state.accessGranted = true;
    state.roomKey = String(tokenData.roomKey || "").trim().toLowerCase();
    state.roomLabel = String(tokenData.roomLabel || ROOM_LABEL_MAP[state.roomKey] || "").trim();

    updateRoomLabel();
    updateAccessUI("アクセス可能です。");
    setReadOnlyMode(false);
    await loadAppData();
  } catch (err) {
    console.error("アクセス確認失敗:", err);
    setReadOnlyMode(true);
    updateAccessUI("アクセス確認に失敗しました。");
    setStatus(`アクセス確認失敗: ${err.message}`);
    renderEmptyMessage("アクセス確認に失敗しました。通信状態をご確認ください。");
    updateStatsUI();
  }
}

function updateRoomLabel() {
  const roomLabelEl = document.getElementById("roomLabel");
  if (!roomLabelEl) return;

  roomLabelEl.classList.remove("muted");

  if (state.roomLabel) {
    roomLabelEl.textContent = state.roomLabel;
    return;
  }

  if (state.roomKey) {
    roomLabelEl.textContent = ROOM_LABEL_MAP[state.roomKey] || state.roomKey;
    return;
  }

  roomLabelEl.textContent = "未設定";
  roomLabelEl.classList.add("muted");
}

function updateAccessUI(message) {
  const authStatusEl = document.getElementById("authStatus");
  const authUserEmailEl = document.getElementById("authUserEmail");
  const signInBtn = document.getElementById("signInBtn");
  const signOutBtn = document.getElementById("signOutBtn");

  if (authStatusEl) {
    authStatusEl.textContent = message;
  }
  if (authUserEmailEl) {
    authUserEmailEl.textContent = "";
  }
  if (signInBtn) {
    signInBtn.hidden = true;
    signInBtn.style.display = "none";
  }
  if (signOutBtn) {
    signOutBtn.hidden = true;
    signOutBtn.style.display = "none";
  }
}

function canEdit() {
  return !!(state.token && state.accessGranted && !state.isLocalPreview);
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
    const inventoryMap = await loadInventoryFromFirestore(state.token);
    buildStateFromFirestore(MASTER_DATA, inventoryMap);

    generateCategoryChips();
    updateStatsUI();
    applyFilterAndRender();

    const sec = ((performance.now() - started) / 1000).toFixed(2);
    setStatus(`同期完了: ${sec}秒`);
  } catch (err) {
    console.error(err);
    setStatus(`取得失敗: ${err.message}`);
    renderEmptyMessage("データ取得に失敗しました。");
  }
}

async function loadInventoryFromFirestore(token) {
  const inventoryMap = new Map();
  if (!token || !state.accessGranted) return inventoryMap;

  const itemsRef = collection(db, "inventory", token, "items");
  const snapshot = await getDocs(itemsRef);

  snapshot.forEach((docSnap) => {
    inventoryMap.set(docSnap.id, docSnap.data());
  });

  return inventoryMap;
}

function buildStateFromFirestore(masterData, inventoryMap) {
  state.items = [];
  state.itemsById = new Map();
  state.originalSnapshotMap = Object.create(null);
  state.totalQty = 0;
  state.dirtyCount = 0;
  state.autoSaveSuspended = false;
  state.hasShownRetryNotice = false;
  state.visibleCount = INITIAL_VISIBLE_COUNT;

  masterData.forEach((m) => {
    const id = String(m.id || "").trim();
    if (!id) return;

    const savedData = inventoryMap.get(id) || {};
    const item = normalizeItem({
      ...m,
      qty: Number(savedData.qty) || 0,
      isCustom: false
    });

    pushItemToState(item);
    inventoryMap.delete(id);
  });

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
async function sendData({ silent = false, isManualRetry = false } = {}) {
  if (!state.token || state.isSyncing || !canEdit()) return false;

  const dirtyItems = state.items.filter(
    (item) => snapshotKey(item) !== state.originalSnapshotMap[item.id]
  );

  if (dirtyItems.length === 0) {
    if (!silent) setStatus("変更はありません。");
    return true;
  }

  if (!isManualRetry && state.autoSaveSuspended) {
    return false;
  }

  state.isSyncing = true;
  updateStatsUI();
  setStatus(silent ? "自動保存中..." : "保存中...");

  try {
    for (const item of dirtyItems) {
      const ref = doc(db, "inventory", state.token, "items", item.id);
      await setDoc(
        ref,
        {
          name: item.name,
          category: item.category,
          subject: item.subject,
          publisher: item.publisher,
          edition: item.edition,
          qty: item.qty,
          isCustom: item.isCustom,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );

      state.originalSnapshotMap[item.id] = snapshotKey(item);
      item.__dirty = false;
    }

    state.dirtyCount = 0;
    state.autoSaveSuspended = false;
    state.hasShownRetryNotice = false;
    clearAutoSaveTimer();
    setStatus(silent ? "自動保存しました。" : "保存しました。");
    return true;
  } catch (err) {
    console.error("保存失敗:", err);
    clearAutoSaveTimer();
    state.autoSaveSuspended = true;

    if (isManualRetry) {
      state.hasShownRetryNotice = false;
      setStatus("保存に失敗しました。通信状態が安定しない場合は、メニューの「ファイルに保存」をご利用ください。");
    } else if (!state.hasShownRetryNotice) {
      state.hasShownRetryNotice = true;
      setStatus(RETRY_GUIDE_MESSAGE);
    }

    return false;
  } finally {
    state.isSyncing = false;
    updateStatsUI();
  }
}

function scheduleAutoSave() {
  if (!canEdit()) return;
  clearAutoSaveTimer();

  if (state.dirtyCount === 0) return;

  if (state.autoSaveSuspended) {
    setStatusOnce(RETRY_SHORT_MESSAGE);
    return;
  }

  setStatus("編集中です。最後の操作から5秒後に自動保存します。");
  state.autoSaveTimerId = setTimeout(() => {
    state.autoSaveTimerId = null;
    void sendData({ silent: true, isManualRetry: false });
  }, AUTO_SAVE_DELAY_MS);
}

function clearAutoSaveTimer() {
  if (state.autoSaveTimerId) {
    clearTimeout(state.autoSaveTimerId);
    state.autoSaveTimerId = null;
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

  const categories = Array.from(
    new Set(state.items.map((item) => item.category).filter(Boolean))
  );

  const isActive = (key) => (state.activeFilter === key ? " active" : "");
  let html = `<button type="button" class="f-chip${isActive("all")}" data-filter="all">すべて</button>`;
  html += `<button type="button" class="f-chip${isActive("input")}" data-filter="input">入力済み</button>`;
  html += `<button type="button" class="f-chip${isActive("custom")}" data-filter="custom">未登録教材</button>`;

  categories
    .filter((c) => c && c !== "未登録教材")
    .forEach((c) => {
      html += `<button type="button" class="f-chip${isActive(c)}" data-filter="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
    });

  container.innerHTML = html;
}

function applyFilterAndRender() {
  const q = state.query;
  const filter = state.activeFilter;

  state.filteredItems = state.items.filter((item) => {
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
  let html = visibleItems.map((item) => renderItemHTML(item)).join("");

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
        <button type="button" class="qty-btn minus" ${canEdit() ? "" : "disabled"}>−</button>
        <div class="qty-num num">${item.qty}</div>
        <button type="button" class="qty-btn plus" ${canEdit() ? "" : "disabled"}>＋</button>
      </div>
    </article>`;
}

function renderEmptyMessage(message) {
  const container = document.getElementById("list");
  if (container) {
    container.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
  }
}

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

/**
 * アイテムの初期化（正規化）
 */
function normalizeItem(raw, idFromFirestore = null) {
  const id = idFromFirestore || String(raw.id || "").trim();
  const item = {
    id,
    name: raw.name || "名称未設定",
    category: raw.category || "その他",
    subject: raw.subject || "",
    publisher: raw.publisher || "",
    edition: raw.edition || "",
    qty: Number(raw.qty) || 0,
    isCustom: !!raw.isCustom
  };

  item.searchTag = [
    item.name,
    item.category,
    item.subject,
    item.publisher,
    item.edition
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return item;
}

/**
 * 変更検知用のスナップショット作成
 */
function snapshotKey(item) {
  return `${item.id}_${item.qty}_${item.name}_${item.publisher}_${item.edition}_${item.category}_${item.subject}_${item.isCustom ? 1 : 0}`;
}

/**
 * HTMLエスケープ（XSS対策）
 */
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setStatus(msg) {
  state.lastStatusMessage = msg;

  const line = document.getElementById("statusLine");
  if (line) line.textContent = msg;
}

function setStatusOnce(msg) {
  setStatus(msg);
}

/**
 * 読み取り専用モードの切り替え
 */
function setReadOnlyMode(isReadOnly) {
  const sendBtn = document.getElementById("sendBtn");
  if (sendBtn) sendBtn.disabled = isReadOnly;

  const list = document.getElementById("list");
  if (isReadOnly) {
    list?.classList.add("readonly-mode");
  } else {
    list?.classList.remove("readonly-mode");
  }
}

/**
 * 合計在庫数と未保存件数の再計算・UI反映
 */
function recalcTotalQty() {
  state.totalQty = state.items.reduce((sum, item) => sum + item.qty, 0);
  state.dirtyCount = state.items.filter(
    (item) => snapshotKey(item) !== state.originalSnapshotMap[item.id]
  ).length;
}

function updateStatsUI() {
  recalcTotalQty();

  const totalQtyEl = document.getElementById("totalQty");
  const dirtyCountEl = document.getElementById("dirtyCount");
  const sendBtn = document.getElementById("sendBtn");

  if (totalQtyEl) totalQtyEl.textContent = state.totalQty;

  if (dirtyCountEl) {
    dirtyCountEl.textContent = state.dirtyCount > 0 ? `(未保存: ${state.dirtyCount})` : "";
  }

  if (sendBtn) {
    sendBtn.classList.toggle("dirty", state.dirtyCount > 0);
  }
}

/**
 * リストクリックの委譲
 */
function handleListClick(e) {
  const target = e.target;

  if (target.id === "loadMoreBtn") {
    state.visibleCount += LOAD_MORE_COUNT;
    renderFilteredItems();
    return;
  }

  const itemEl = target.closest(".item");
  if (!itemEl) return;
  const id = itemEl.dataset.id;

  if (target.classList.contains("plus")) {
    changeQty(id, 1);
  } else if (target.classList.contains("minus")) {
    changeQty(id, -1);
  }
}

/**
 * 数量変更処理
 */
function changeQty(id, diff) {
  const item = state.itemsById.get(id);
  if (!item || !canEdit()) return;

  const newQty = Math.max(0, item.qty + diff);
  if (newQty === item.qty) return;

  item.qty = newQty;

  const itemEl = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
  if (itemEl) {
    const numEl = itemEl.querySelector(".qty-num");
    if (numEl) numEl.textContent = item.qty;
    itemEl.classList.toggle("has-qty", item.qty > 0);
  }

  updateStatsUI();
  scheduleAutoSave();
}

/**
 * ダイアログ制御
 */
function openModal(id) {
  const dialog = document.getElementById(id);
  if (dialog) dialog.showModal();
}

function closeModal(id) {
  const dialog = document.getElementById(id);
  if (dialog) dialog.close();
}

function attachDialogBackdropClose(id) {
  const dialog = document.getElementById(id);
  if (!dialog) return;
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}

/**
 * JSONバックアップ（ファイルに保存）
 */
function exportJsonBackup() {
  const data = {
    token: state.token,
    room: state.roomKey,
    roomLabel: state.roomLabel,
    exportedAt: new Date().toISOString(),
    items: state.items.filter((it) => it.qty > 0 || it.isCustom)
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json"
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `inventory_${state.roomKey || "unknown"}_${new Date().getTime()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * JSONバックアップからの復元
 */
async function importJsonBackup(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const json = JSON.parse(event.target.result);
      if (!json.items || !Array.isArray(json.items)) {
        throw new Error("不正な形式です");
      }

      json.items.forEach((importedItem) => {
        const target = state.itemsById.get(importedItem.id);
        if (target) {
          target.qty = Number(importedItem.qty) || 0;
          target.name = importedItem.name || target.name;
          target.category = importedItem.category || target.category;
          target.subject = importedItem.subject || target.subject;
          target.publisher = importedItem.publisher || target.publisher;
          target.edition = importedItem.edition || target.edition;
          target.isCustom = !!importedItem.isCustom;
          target.searchTag = [
            target.name,
            target.category,
            target.subject,
            target.publisher,
            target.edition
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
        } else if (importedItem.isCustom) {
          pushItemToState(normalizeItem(importedItem));
        }
      });

      generateCategoryChips();
      applyFilterAndRender();
      updateStatsUI();
      scheduleAutoSave();
      alert("読み込みが完了しました。未保存の変更がある場合は保存してください。");
    } catch (err) {
      alert("ファイルの読み込みに失敗しました: " + err.message);
    }
  };

  reader.readAsText(file);
  e.target.value = "";
}

/**
 * 未登録教材ダイアログ内の数量を変更する
 */
function changeCustomQty(diff) {
  const qtyEl =
    document.getElementById("customQtyInput") ||
    document.getElementById("customQtyValue");

  if (!qtyEl) return;

  let currentVal = 0;

  if (qtyEl.tagName === "INPUT") {
    currentVal = parseInt(qtyEl.value, 10) || 0;
    const newVal = Math.max(0, currentVal + diff);
    qtyEl.value = String(newVal);
  } else {
    currentVal = parseInt(qtyEl.textContent, 10) || 0;
    const newVal = Math.max(0, currentVal + diff);
    qtyEl.textContent = String(newVal);
  }
}

/**
 * 未登録教材フォームの送信処理
 */
function handleCustomItemSubmit(e) {
  e.preventDefault();
  if (!canEdit()) return;

  const name = document.getElementById("customName")?.value.trim() || "";
  const category = "未登録教材";
  const publisher = document.getElementById("customPublisher")?.value.trim() || "";
  const edition = document.getElementById("customEdition")?.value.trim() || "";

  const qtyEl =
    document.getElementById("customQtyInput") ||
    document.getElementById("customQtyValue");
  const qty = parseInt(qtyEl?.value || qtyEl?.textContent || "0", 10) || 0;

  if (!name) {
    alert("教材名を入力してください。");
    return;
  }

  const id = "custom_" + Date.now();

  const newItem = normalizeItem({
    id,
    name,
    category,
    subject: "",
    publisher,
    edition,
    qty,
    isCustom: true
  });

  pushItemToState(newItem);

  e.target.reset();

  const qtyInput = document.getElementById("customQtyInput");
  if (qtyInput) qtyInput.value = "1";

  const qtyValue = document.getElementById("customQtyValue");
  if (qtyValue) qtyValue.textContent = "1";

  closeModal("customItemDialog");

  generateCategoryChips();
  applyFilterAndRender();
  updateStatsUI();
  scheduleAutoSave();
}