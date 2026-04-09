/**
 * ====================================================================
 * 教材在庫管理システム - data.js マスタ利用版 (app.js)
 *
 * 【システム概要】
 * 1. 起動時: URLパラメータのtokenを元に、Firestoreから校舎情報と在庫データを取得。
 * 2. マスタ管理: data.jsのMASTER_DATAと、Firestore側の実在庫をIDで紐付け。
 * 3. 未登録教材: マスタにない教材は "custom_" IDで個別管理。
 * 4. 保存: 編集後5秒の自動保存、または手動保存。変更があったアイテムのみ送信。
 * 5. オフライン対策: JSONファイルへの書き出し・読み込み機能を搭載。
 *
 * 【今回の調整】
 * - フィルタチップ上段を「未登録 / 入力済み / すべて」に変更
 * - 未登録教材でも qty=0 のときは通常カードと同じ見た目に統一
 * - 数量の増減に関する過度な演出をなくし、落ち着いたUIに調整
 * - カード全体タップで +1
 *   ※ 数量エリア(.qty-box)内は除外
 *   ※ スクロール時の誤反応を避けるため touchmove 量で判定
 * - 数量の直接入力に対応
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

/* カードタップ判定用 */
const CARD_TAP_MOVE_THRESHOLD_PX = 10;
const SYNTHETIC_CLICK_GUARD_MS = 500;

const INFO_MESSAGES = {
  LOCAL_PREVIEW: "ローカル確認用です。Firestore保存は行いません。",
  LOCAL_PREVIEW_NO_TOKEN: "ローカル確認用です。保存は行いません。",
  LOADING: "データ同期中...",
  LOAD_DONE: "同期完了",
  NO_CHANGES: "変更はありません。",
  MANUAL_SAVING: "保存中...",
  AUTO_SAVING: "自動保存中...",
  MANUAL_SAVED: "保存しました。",
  AUTO_SAVED: "自動保存しました。",
  EDITING: "編集中"
};

const ERROR_MESSAGES = {
  INVALID_URL: "URLが無効です。",
  TOKEN_MISSING: "URLが無効です。token がありません。",
  DISABLED_URL: "このURLは現在無効です。",
  ACCESS_CHECK_FAILED: "アクセス確認に失敗しました。通信状態をご確認ください。",
  LOAD_FAILED: "データ取得に失敗しました。",
  SAVE_FAILED: "保存に失敗しました。保存ボタンで再試行してください。通信状態が安定しない場合は、メニューの「ファイルに保存」をご利用ください。",
  AUTO_SAVE_RETRY: "未保存の変更があります。保存ボタンで再試行してください。",
  SAVE_NOT_ALLOWED: "このURLでは保存できません。",
  ADD_CUSTOM_NOT_ALLOWED: "このURLでは未登録教材を追加できません。"
};

/**
 * アプリケーション状態 (State)
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
  isLocalPreview: false,
  accessReady: false,
  accessGranted: false,
  tokenDocExists: false,
  tokenDocData: null
};

/* タッチ判定用の一時変数 */
let listTouchStartY = 0;
let listTouchMoved = false;
let ignoreClickUntil = 0;

/**
 * =========================
 * 起動処理 (EntryPoint)
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
    const fallbackMasterData = getFallbackMasterData();
    buildStateFromSources(fallbackMasterData, new Map());
    generateCategoryChips();
    applyFilterAndRender();
    updateStatsUI();

    setInfoMessage(
      state.isLocalPreview
        ? INFO_MESSAGES.LOCAL_PREVIEW_NO_TOKEN
        : ERROR_MESSAGES.TOKEN_MISSING
    );

    if (!state.isLocalPreview) {
      setErrorMessage(ERROR_MESSAGES.INVALID_URL);
    }

    setReadOnlyMode(true);
    return;
  }

  if (state.isLocalPreview) {
    state.roomLabel = "ローカル確認用";
    updateRoomLabel();

    const fallbackMasterData = getFallbackMasterData();
    buildStateFromSources(fallbackMasterData, new Map());
    generateCategoryChips();
    applyFilterAndRender();
    updateStatsUI();

    setInfoMessage(INFO_MESSAGES.LOCAL_PREVIEW);
    clearErrorMessage();
    setReadOnlyMode(true);
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

    document.querySelectorAll(".f-chip").forEach((el) => el.classList.remove("active"));
    chip.classList.add("active");
    state.activeFilter = chip.dataset.filter;
    state.visibleCount = INITIAL_VISIBLE_COUNT;
    applyFilterAndRender();
  });

  /* リスト内クリック（＋−、さらに表示、カードクリック） */
  list?.addEventListener("click", handleListClick);

  /* 数量の直接入力 */
  list?.addEventListener("change", handleQtyInputCommit);
  list?.addEventListener("focusin", handleQtyInputFocusIn);
  list?.addEventListener("keydown", handleQtyInputKeydown);

  /* カードタップ + スクロール誤反応防止 */
  list?.addEventListener("touchstart", handleListTouchStart, { passive: true });
  list?.addEventListener("touchmove", handleListTouchMove, { passive: true });
  list?.addEventListener("touchend", handleListTouchEnd);

  sendBtn?.addEventListener("click", () => {
    if (!canEdit()) {
      setErrorMessage(ERROR_MESSAGES.SAVE_NOT_ALLOWED);
      return;
    }
    void sendData({ silent: false, isManualRetry: true });
  });

  document.getElementById("toolMenuBtn")?.addEventListener("click", () => openModal("toolMenuDialog"));
  document.getElementById("closeToolMenuBtn")?.addEventListener("click", () => closeModal("toolMenuDialog"));

  document.getElementById("toolMenuBtnAddCustom")?.addEventListener("click", () => {
    if (!canEdit()) {
      setErrorMessage(ERROR_MESSAGES.ADD_CUSTOM_NOT_ALLOWED);
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
 * メッセージ表示関連
 * =========================
 */
function formatNow() {
  return new Date().toLocaleString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatTimestamp(ts) {
  if (!ts || typeof ts.toDate !== "function") return "";
  return ts.toDate().toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function setInfoMessage(message, withTimestamp = true) {
  const el = document.getElementById("infoMessage");
  if (!el) return;
  el.textContent = withTimestamp ? `${message} (${formatNow()})` : message;
}

function setErrorMessage(message = "") {
  const el = document.getElementById("errorMessage");
  if (!el) return;

  if (!message) {
    el.textContent = "";
    el.hidden = true;
    return;
  }

  el.textContent = message;
  el.hidden = false;
}

function clearErrorMessage() {
  setErrorMessage("");
}

/**
 * =========================
 * tokenアクセス確認
 * =========================
 */
async function initAccessAndLoad() {
  try {
    clearErrorMessage();

    const tokenRef = doc(db, "inventory", state.token);
    const tokenSnap = await getDoc(tokenRef);

    state.accessReady = true;
    state.tokenDocExists = tokenSnap.exists();

    if (!tokenSnap.exists()) {
      setReadOnlyMode(true);
      setErrorMessage(ERROR_MESSAGES.INVALID_URL);
      renderEmptyMessage(ERROR_MESSAGES.INVALID_URL);
      updateStatsUI();
      return;
    }

    const tokenData = tokenSnap.data() || {};
    state.tokenDocData = tokenData;

    state.roomKey = String(tokenData.roomKey || "").trim().toLowerCase();
    state.roomLabel = String(tokenData.roomLabel || ROOM_LABEL_MAP[state.roomKey] || "").trim();
    updateRoomLabel();

    if (tokenData.enabled !== true) {
      setReadOnlyMode(true);
      state.accessGranted = false;
      setErrorMessage(ERROR_MESSAGES.DISABLED_URL);
      renderEmptyMessage(ERROR_MESSAGES.DISABLED_URL);
      updateStatsUI();
      return;
    }

    state.accessGranted = true;
    setReadOnlyMode(false);
    clearErrorMessage();

    await loadAppData();
  } catch (err) {
    console.error("アクセス確認失敗:", err);
    setReadOnlyMode(true);
    setErrorMessage(ERROR_MESSAGES.ACCESS_CHECK_FAILED);
    renderEmptyMessage(ERROR_MESSAGES.ACCESS_CHECK_FAILED);
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

function canEdit() {
  return !!(state.token && state.accessGranted && !state.isLocalPreview);
}

/**
 * =========================
 * データ同期 (Firestore)
 * =========================
 */
async function loadAppData() {
  clearErrorMessage();
  setInfoMessage(INFO_MESSAGES.LOADING);

  try {
    const [masterData, inventoryMap] = await Promise.all([
      Promise.resolve(getFallbackMasterData()),
      loadInventoryFromFirestore(state.token)
    ]);

    const latestUpdatedAt = getLatestUpdatedAt(inventoryMap);

    buildStateFromSources(masterData, inventoryMap);
    generateCategoryChips();
    updateStatsUI();
    applyFilterAndRender();

    if (latestUpdatedAt) {
      setInfoMessage(`最終更新: ${formatTimestamp(latestUpdatedAt)}`, false);
    } else {
      setInfoMessage(INFO_MESSAGES.LOAD_DONE);
    }
  } catch (err) {
    console.error(err);
    setErrorMessage(ERROR_MESSAGES.LOAD_FAILED);
    renderEmptyMessage(ERROR_MESSAGES.LOAD_FAILED);
  }
}

function getLatestUpdatedAt(inventoryMap) {
  let latest = null;

  inventoryMap.forEach((data) => {
    if (!data?.updatedAt) return;
    const ts = data.updatedAt;
    if (
      !latest ||
      ts.seconds > latest.seconds ||
      (ts.seconds === latest.seconds && ts.nanoseconds > latest.nanoseconds)
    ) {
      latest = ts;
    }
  });

  return latest;
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

function getFallbackMasterData() {
  if (typeof MASTER_DATA !== "undefined" && Array.isArray(MASTER_DATA)) {
    return MASTER_DATA;
  }
  return [];
}

function buildStateFromSources(masterData, inventoryMap) {
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
      id,
      name: m.name || "",
      category: m.category || "",
      subject: m.subject || "",
      publisher: m.publisher || "",
      edition: m.edition || "",
      qty: Number(savedData.qty) || 0,
      isCustom: false
    });

    pushItemToState(item);
    inventoryMap.delete(id);
  });

  inventoryMap.forEach((data, id) => {
    const item = normalizeItem({
      id,
      name: data.name || "名称未設定",
      category: data.category || "未登録教材",
      subject: data.subject || "",
      publisher: data.publisher || "",
      edition: data.edition || "",
      qty: Number(data.qty) || 0,
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

function pushNewDirtyItemToState(item) {
  state.items.push(item);
  state.itemsById.set(item.id, item);
  state.originalSnapshotMap[item.id] = "__NEW_ITEM__";
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
    if (!silent) {
      clearErrorMessage();
      setInfoMessage(INFO_MESSAGES.NO_CHANGES);
    }
    return true;
  }

  if (!isManualRetry && state.autoSaveSuspended) {
    return false;
  }

  state.isSyncing = true;
  updateStatsUI();
  clearErrorMessage();
  setInfoMessage(silent ? INFO_MESSAGES.AUTO_SAVING : INFO_MESSAGES.MANUAL_SAVING);

  try {
    for (const item of dirtyItems) {
      const ref = doc(db, "inventory", state.token, "items", item.id);

      const payload = item.isCustom
        ? {
            name: item.name,
            category: item.category,
            subject: item.subject,
            publisher: item.publisher,
            edition: item.edition,
            qty: item.qty,
            isCustom: true,
            updatedAt: serverTimestamp()
          }
        : {
            qty: item.qty,
            isCustom: false,
            updatedAt: serverTimestamp()
          };

      await setDoc(ref, payload, { merge: true });

      state.originalSnapshotMap[item.id] = snapshotKey(item);
      item.__dirty = false;
    }

    state.dirtyCount = 0;
    state.autoSaveSuspended = false;
    state.hasShownRetryNotice = false;
    clearAutoSaveTimer();
    clearErrorMessage();
    setInfoMessage(silent ? INFO_MESSAGES.AUTO_SAVED : INFO_MESSAGES.MANUAL_SAVED);
    return true;
  } catch (err) {
    console.error("保存失敗:", err);
    clearAutoSaveTimer();
    state.autoSaveSuspended = true;

    if (isManualRetry) {
      state.hasShownRetryNotice = false;
      setErrorMessage(ERROR_MESSAGES.SAVE_FAILED);
    } else if (!state.hasShownRetryNotice) {
      state.hasShownRetryNotice = true;
      setErrorMessage(ERROR_MESSAGES.AUTO_SAVE_RETRY);
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
    setErrorMessage(ERROR_MESSAGES.AUTO_SAVE_RETRY);
    return;
  }

  clearErrorMessage();
  setInfoMessage(INFO_MESSAGES.EDITING);

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

  let mainHtml = "";
  mainHtml += `<button type="button" class="f-chip chip-custom${isActive("custom")}" data-filter="custom">未登録</button>`;
  mainHtml += `<button type="button" class="f-chip chip-input${isActive("input")}" data-filter="input">入力済み</button>`;
  mainHtml += `<button type="button" class="f-chip chip-all${isActive("all")}" data-filter="all">すべて</button>`;

  let subHtml = "";
  categories
    .filter((c) => c && c !== "未登録教材")
    .forEach((c) => {
      subHtml += `<button type="button" class="f-chip${isActive(c)}" data-filter="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
    });

  container.innerHTML = `
    <div class="filter-main">${mainHtml}</div>
    <div class="filter-sub">${subHtml}</div>
  `;
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
  const hasQty = item.qty > 0;

  return `
    <article class="item ${hasQty ? "has-qty" : ""} ${item.isCustom ? "custom-item" : ""}" data-id="${escapeHtml(item.id)}">
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
        <button
          type="button"
          class="qty-btn minus"
          aria-label="減らす"
          ${canEdit() ? "" : "disabled"}
        >−</button>

        <input
          type="number"
          inputmode="numeric"
          pattern="[0-9]*"
          min="0"
          step="1"
          class="qty-input num"
          value="${item.qty}"
          aria-label="${escapeHtml(item.name)} の数量"
          ${canEdit() ? "" : "disabled"}
        />

        <button
          type="button"
          class="qty-btn plus"
          aria-label="増やす"
          ${canEdit() ? "" : "disabled"}
        >＋</button>
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

function normalizeItem(raw) {
  const id = String(raw.id || "").trim();
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

function snapshotKey(item) {
  if (item.isCustom) {
    return `${item.id}_${item.qty}_${item.name}_${item.publisher}_${item.edition}_${item.category}_${item.subject}_1`;
  }
  return `${item.id}_${item.qty}_0`;
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
 * =========================
 * リスト操作
 * =========================
 */
function handleListClick(e) {
  const target = e.target;

  if (target.id === "loadMoreBtn") {
    state.visibleCount += LOAD_MORE_COUNT;
    renderFilteredItems();
    return;
  }

  /* touchend 後に発生する疑似 click を無視 */
  if (Date.now() < ignoreClickUntil) {
    return;
  }

  const itemEl = target.closest(".item");
  if (!itemEl) return;

  const id = itemEl.dataset.id;
  if (!id) return;

  if (target.closest(".qty-btn")) {
    if (target.classList.contains("plus")) {
      changeQty(id, 1);
    } else if (target.classList.contains("minus")) {
      changeQty(id, -1);
    }
    return;
  }

  if (target.closest(".qty-input")) {
    return;
  }

  /* PC等ではクリックでカード加算 */
  changeQty(id, 1);
}

function handleListTouchStart(e) {
  if (!e.touches || e.touches.length === 0) return;
  listTouchStartY = e.touches[0].clientY;
  listTouchMoved = false;
}

function handleListTouchMove(e) {
  if (!e.touches || e.touches.length === 0) return;
  const currentY = e.touches[0].clientY;
  if (Math.abs(currentY - listTouchStartY) > CARD_TAP_MOVE_THRESHOLD_PX) {
    listTouchMoved = true;
  }
}

function handleListTouchEnd(e) {
  if (listTouchMoved) return;
  if (!canEdit()) return;

  const target = e.target;

  // .item-main 内の要素であるかチェック
  if (!target.closest(".item-main")) return;

  // 念のため他の要素でないこともチェック
  if (target.id === "loadMoreBtn") return;
  if (target.closest(".qty-box")) return;
  if (target.closest(".qty-input")) return;
  if (target.closest(".qty-btn")) return;

  const itemEl = target.closest(".item");
  if (!itemEl) return;

  const id = itemEl.dataset.id;
  if (!id) return;

  changeQty(id, 1);
  ignoreClickUntil = Date.now() + SYNTHETIC_CLICK_GUARD_MS;
}

function handleQtyInputFocusIn(e) {
  const input = e.target.closest(".qty-input");
  if (!input) return;

  setTimeout(() => {
    try {
      input.select();
    } catch (err) {
      console.warn(err);
    }
  }, 0);
}

function handleQtyInputKeydown(e) {
  const input = e.target.closest(".qty-input");
  if (!input) return;

  if (e.key === "Enter") {
    input.blur();
  }
}

function handleQtyInputCommit(e) {
  const input = e.target.closest(".qty-input");
  if (!input) return;

  const itemEl = input.closest(".item");
  if (!itemEl) return;

  const id = itemEl.dataset.id;
  const item = state.itemsById.get(id);
  if (!item || !canEdit()) return;

  let value = parseInt(input.value, 10);
  if (!Number.isFinite(value) || value < 0) value = 0;

  if (value === item.qty) {
    input.value = String(item.qty);
    return;
  }

  item.qty = value;
  input.value = String(item.qty);

  syncItemRowUI(itemEl, item);
  updateStatsUI();
  scheduleAutoSave();
}

function changeQty(id, diff) {
  const item = state.itemsById.get(id);
  if (!item || !canEdit()) return;

  const newQty = Math.max(0, item.qty + diff);
  if (newQty === item.qty) return;

  item.qty = newQty;

  const itemEl = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
  if (itemEl) {
    syncItemRowUI(itemEl, item);
  }

  updateStatsUI();
  scheduleAutoSave();
}

function syncItemRowUI(itemEl, item) {
  const inputEl = itemEl.querySelector(".qty-input");
  if (inputEl) {
    inputEl.value = String(item.qty);
  }

  itemEl.classList.toggle("has-qty", item.qty > 0);
  itemEl.classList.toggle("custom-item", !!item.isCustom);
}

/**
 * =========================
 * ダイアログ制御
 * =========================
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
 * =========================
 * JSONバックアップ
 * =========================
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
        const importedId = String(importedItem.id || "").trim();
        if (!importedId) return;

        const target = state.itemsById.get(importedId);

        if (target) {
          target.qty = Number(importedItem.qty) || 0;

          if (target.isCustom) {
            target.name = importedItem.name || target.name;
            target.category = importedItem.category || target.category;
            target.subject = importedItem.subject || target.subject;
            target.publisher = importedItem.publisher || target.publisher;
            target.edition = importedItem.edition || target.edition;
          }

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
          pushNewDirtyItemToState(normalizeItem({
            id: importedId,
            name: importedItem.name || "名称未設定",
            category: importedItem.category || "未登録教材",
            subject: importedItem.subject || "",
            publisher: importedItem.publisher || "",
            edition: importedItem.edition || "",
            qty: Number(importedItem.qty) || 0,
            isCustom: true
          }));
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
 * =========================
 * 未登録教材
 * =========================
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

  pushNewDirtyItemToState(newItem);

  e.target.reset();

  const qtyInput = document.getElementById("customQtyInput");
  if (qtyInput) qtyInput.value = "0";

  const qtyValue = document.getElementById("customQtyValue");
  if (qtyValue) qtyValue.textContent = "0";

  closeModal("customItemDialog");

  generateCategoryChips();
  applyFilterAndRender();
  updateStatsUI();
  scheduleAutoSave();
}