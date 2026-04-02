/**
 * ====================================================================
 * 教材在庫管理システム - Firestore + Authentication 対応版 (app.js)
 * Googleログイン対応 / 編集後5秒で1回だけ自動保存 / 失敗時は手動再試行
 * ====================================================================
 */

import {
  auth,
  db,
  googleProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  signOut
} from "./firebase.js";
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
const AUTO_SAVE_DELAY_MS = 5000;

/**
 * 必要に応じて制限してください。
 * どちらも空なら、Googleログイン済みユーザーをすべて許可します。
 */
const ALLOWED_EMAIL_DOMAINS = [
  // "example.com"
];
const ALLOWED_EMAILS = [
  // "name@example.com"
];

const RETRY_GUIDE_MESSAGE = "自動保存に失敗しました。保存ボタンで再試行してください。通信状態が安定しない場合は、メニューの「ファイルに保存」をご利用ください。";
const RETRY_SHORT_MESSAGE = "未保存の変更があります。保存ボタンで再試行してください。";

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
  autoSaveTimerId: null,
  autoSaveSuspended: false,
  hasShownRetryNotice: false,
  isAuthed: false,
  currentUser: null,
  lastStatusMessage: "",
  isLocalPreview: false,
  authReady: false
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
  state.isLocalPreview = (
    location.protocol === "file:" ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1"
  );

  initUI();

  if (!state.roomKey) {
    buildStateFromFirestore(MASTER_DATA, new Map());
    generateCategoryChips();
    applyFilterAndRender();
    updateStatsUI();
    setStatus(state.isLocalPreview ? "ローカル確認用です。保存は行いません。" : "閲覧モード（保存不可）");
    setReadOnlyMode(true);
    return;
  }

  if (state.isLocalPreview) {
    buildStateFromFirestore(MASTER_DATA, new Map());
    generateCategoryChips();
    applyFilterAndRender();
    updateStatsUI();
    setStatus("ローカル確認用です。Firestore保存は行いません。");
    setReadOnlyMode(true);
    return;
  }

  try {
    await getRedirectResult(auth);
  } catch (err) {
    console.error("リダイレクトログイン失敗:", err);
  }

  onAuthStateChanged(auth, async (user) => {
    state.authReady = true;
    state.currentUser = user || null;
    state.isAuthed = !!user;
    updateAuthUI(user);

    if (!user) {
      clearAutoSaveTimer();
      clearStateForSignedOut();
      setReadOnlyMode(true);
      setStatus("Googleでログインしてください。ログイン後に在庫データを読み込みます。");
      return;
    }

    if (!isAllowedUser(user)) {
      clearAutoSaveTimer();
      clearStateForSignedOut();
      setReadOnlyMode(true);
      setStatus("このGoogleアカウントでは利用できません。許可されたアカウントでログインしてください。");
      return;
    }

    setReadOnlyMode(false);
    await loadAppData();
  });
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
    } else if (state.isLocalPreview) {
      roomLabelEl.textContent = "ローカル確認用";
      roomLabelEl.classList.add("muted");
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
      setStatus("ログイン後に保存できます。");
      return;
    }
    sendData({ silent: false, isManualRetry: true });
  });

  document.getElementById("toolMenuBtn")?.addEventListener("click", () => openModal("toolMenuDialog"));
  document.getElementById("closeToolMenuBtn")?.addEventListener("click", () => closeModal("toolMenuDialog"));
  document.getElementById("toolMenuBtnAddCustom")?.addEventListener("click", () => {
    if (!canEdit()) {
      setStatus("ログイン後に未登録教材を追加できます。");
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

  document.getElementById("signInBtn")?.addEventListener("click", handleSignIn);
  document.getElementById("signOutBtn")?.addEventListener("click", handleSignOut);

  attachDialogBackdropClose("toolMenuDialog");
  attachDialogBackdropClose("customItemDialog");
}

/**
 * =========================
 * Authentication
 * =========================
 */
async function handleSignIn() {
  try {
    setStatus("Googleログインを開始しています...");
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    console.error("Googleログイン失敗:", err);
    if (String(err?.code || "") === "auth/popup-blocked") {
      try {
        await signInWithRedirect(auth, googleProvider);
      } catch (redirectErr) {
        console.error("Googleリダイレクトログイン失敗:", redirectErr);
        setStatus("ログインに失敗しました。ポップアップ設定や通信状態をご確認ください。");
      }
      return;
    }
    setStatus("ログインに失敗しました。ポップアップ設定や通信状態をご確認ください。");
  }
}

async function handleSignOut() {
  try {
    await signOut(auth);
    setStatus("ログアウトしました。");
  } catch (err) {
    console.error("ログアウト失敗:", err);
    setStatus("ログアウトに失敗しました。");
  }
}

function updateAuthUI(user) {
  const authStatusEl = document.getElementById("authStatus");
  const authUserEmailEl = document.getElementById("authUserEmail");
  const signInBtn = document.getElementById("signInBtn");
  const signOutBtn = document.getElementById("signOutBtn");

  if (!authStatusEl || !authUserEmailEl || !signInBtn || !signOutBtn) return;

  if (state.isLocalPreview || !state.roomKey) {
    authStatusEl.textContent = state.isLocalPreview ? "ローカル確認用です" : "閲覧モードです";
    authUserEmailEl.textContent = "";
    signInBtn.hidden = true;
    signOutBtn.hidden = true;
    return;
  }

  if (!user) {
    authStatusEl.textContent = "Googleでログインしてください";
    authUserEmailEl.textContent = "";
    signInBtn.hidden = false;
    signOutBtn.hidden = true;
    return;
  }

  authStatusEl.textContent = "ログイン中";
  authUserEmailEl.textContent = user.email || "";
  signInBtn.hidden = true;
  signOutBtn.hidden = false;
}

function isAllowedUser(user) {
  const email = String(user?.email || "").trim().toLowerCase();
  if (!email) return false;

  if (ALLOWED_EMAILS.length > 0 && ALLOWED_EMAILS.map(v => v.toLowerCase()).includes(email)) {
    return true;
  }

  if (ALLOWED_EMAIL_DOMAINS.length > 0) {
    const domain = email.split("@")[1] || "";
    return ALLOWED_EMAIL_DOMAINS.map(v => v.toLowerCase()).includes(domain);
  }

  return true;
}

function canEdit() {
  return !!(state.roomKey && state.isAuthed && state.currentUser && !state.isLocalPreview);
}

function clearStateForSignedOut() {
  state.items = [];
  state.itemsById = new Map();
  state.filteredItems = [];
  state.totalQty = 0;
  state.dirtyCount = 0;
  state.originalSnapshotMap = Object.create(null);
  state.visibleCount = INITIAL_VISIBLE_COUNT;
  state.autoSaveSuspended = false;
  state.hasShownRetryNotice = false;
  renderEmptyMessage("ログインすると在庫データを表示します。");
  updateStatsUI();
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
  if (!roomKey || !state.isAuthed) return inventoryMap;

  const itemsRef = collection(db, "inventory", roomKey, "items");
  const snapshot = await getDocs(itemsRef);
  snapshot.forEach(docSnap => {
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
  if (!state.roomKey || state.isSyncing || !canEdit()) return false;

  const dirtyItems = state.items.filter(item => snapshotKey(item) !== state.originalSnapshotMap[item.id]);
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
        <button type="button" class="qty-btn minus" ${canEdit() ? "" : "disabled"}>−</button>
        <div class="qty-num num">${item.qty}</div>
        <button type="button" class="qty-btn plus" ${canEdit() ? "" : "disabled"}>＋</button>
      </div>
    </article>`;
}

function renderEmptyMessage(message) {
  const container = document.getElementById("list");
  if (container) container.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
}

/**
 * ====================================================================
 * 教材在庫管理システム - Firestore + Authentication 対応版 (app.js)
 * Googleログイン対応 / 編集後5秒で1回だけ自動保存 / 失敗時は手動再試行
 * ====================================================================
 */

import {
  auth,
  db,
  googleProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  signOut
} from "./firebase.js";
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
const AUTO_SAVE_DELAY_MS = 5000;

/**
 * 必要に応じて制限してください。
 * どちらも空なら、Googleログイン済みユーザーをすべて許可します。
 */
const ALLOWED_EMAIL_DOMAINS = [
  // "example.com"
];
const ALLOWED_EMAILS = [
  // "name@example.com"
];

const RETRY_GUIDE_MESSAGE = "自動保存に失敗しました。保存ボタンで再試行してください。通信状態が安定しない場合は、メニューの「ファイルに保存」をご利用ください。";
const RETRY_SHORT_MESSAGE = "未保存の変更があります。保存ボタンで再試行してください。";

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
  autoSaveTimerId: null,
  autoSaveSuspended: false,
  hasShownRetryNotice: false,
  isAuthed: false,
  currentUser: null,
  lastStatusMessage: "",
  isLocalPreview: false,
  authReady: false
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
  state.isLocalPreview = (
    location.protocol === "file:" ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1"
  );

  initUI();

  if (!state.roomKey) {
    buildStateFromFirestore(MASTER_DATA, new Map());
    generateCategoryChips();
    applyFilterAndRender();
    updateStatsUI();
    setStatus(state.isLocalPreview ? "ローカル確認用です。保存は行いません。" : "閲覧モード（保存不可）");
    setReadOnlyMode(true);
    return;
  }

  if (state.isLocalPreview) {
    buildStateFromFirestore(MASTER_DATA, new Map());
    generateCategoryChips();
    applyFilterAndRender();
    updateStatsUI();
    setStatus("ローカル確認用です。Firestore保存は行いません。");
    setReadOnlyMode(true);
    return;
  }

  try {
    await getRedirectResult(auth);
  } catch (err) {
    console.error("リダイレクトログイン失敗:", err);
  }

  onAuthStateChanged(auth, async (user) => {
    state.authReady = true;
    state.currentUser = user || null;
    state.isAuthed = !!user;
    updateAuthUI(user);

    if (!user) {
      clearAutoSaveTimer();
      clearStateForSignedOut();
      setReadOnlyMode(true);
      setStatus("Googleでログインしてください。ログイン後に在庫データを読み込みます。");
      return;
    }

    if (!isAllowedUser(user)) {
      clearAutoSaveTimer();
      clearStateForSignedOut();
      setReadOnlyMode(true);
      setStatus("このGoogleアカウントでは利用できません。許可されたアカウントでログインしてください。");
      return;
    }

    setReadOnlyMode(false);
    await loadAppData();
  });
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
    } else if (state.isLocalPreview) {
      roomLabelEl.textContent = "ローカル確認用";
      roomLabelEl.classList.add("muted");
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
      setStatus("ログイン後に保存できます。");
      return;
    }
    sendData({ silent: false, isManualRetry: true });
  });

  document.getElementById("toolMenuBtn")?.addEventListener("click", () => openModal("toolMenuDialog"));
  document.getElementById("closeToolMenuBtn")?.addEventListener("click", () => closeModal("toolMenuDialog"));
  document.getElementById("toolMenuBtnAddCustom")?.addEventListener("click", () => {
    if (!canEdit()) {
      setStatus("ログイン後に未登録教材を追加できます。");
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

  document.getElementById("signInBtn")?.addEventListener("click", handleSignIn);
  document.getElementById("signOutBtn")?.addEventListener("click", handleSignOut);

  attachDialogBackdropClose("toolMenuDialog");
  attachDialogBackdropClose("customItemDialog");
}

/**
 * =========================
 * Authentication
 * =========================
 */
async function handleSignIn() {
  try {
    setStatus("Googleログインを開始しています...");
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    console.error("Googleログイン失敗:", err);
    if (String(err?.code || "") === "auth/popup-blocked") {
      try {
        await signInWithRedirect(auth, googleProvider);
      } catch (redirectErr) {
        console.error("Googleリダイレクトログイン失敗:", redirectErr);
        setStatus("ログインに失敗しました。ポップアップ設定や通信状態をご確認ください。");
      }
      return;
    }
    setStatus("ログインに失敗しました。ポップアップ設定や通信状態をご確認ください。");
  }
}

async function handleSignOut() {
  try {
    await signOut(auth);
    setStatus("ログアウトしました。");
  } catch (err) {
    console.error("ログアウト失敗:", err);
    setStatus("ログアウトに失敗しました。");
  }
}

function updateAuthUI(user) {
  const authStatusEl = document.getElementById("authStatus");
  const authUserEmailEl = document.getElementById("authUserEmail");
  const signInBtn = document.getElementById("signInBtn");
  const signOutBtn = document.getElementById("signOutBtn");

  if (!authStatusEl || !authUserEmailEl || !signInBtn || !signOutBtn) return;

  if (state.isLocalPreview || !state.roomKey) {
    authStatusEl.textContent = state.isLocalPreview ? "ローカル確認用です" : "閲覧モードです";
    authUserEmailEl.textContent = "";
    signInBtn.hidden = true;
    signOutBtn.hidden = true;
    return;
  }

  if (!user) {
    authStatusEl.textContent = "Googleでログインしてください";
    authUserEmailEl.textContent = "";
    signInBtn.hidden = false;
    signOutBtn.hidden = true;
    return;
  }

  authStatusEl.textContent = "ログイン中";
  authUserEmailEl.textContent = user.email || "";
  signInBtn.hidden = true;
  signOutBtn.hidden = false;
}

function isAllowedUser(user) {
  const email = String(user?.email || "").trim().toLowerCase();
  if (!email) return false;

  if (ALLOWED_EMAILS.length > 0 && ALLOWED_EMAILS.map(v => v.toLowerCase()).includes(email)) {
    return true;
  }

  if (ALLOWED_EMAIL_DOMAINS.length > 0) {
    const domain = email.split("@")[1] || "";
    return ALLOWED_EMAIL_DOMAINS.map(v => v.toLowerCase()).includes(domain);
  }

  return true;
}

function canEdit() {
  return !!(state.roomKey && state.isAuthed && state.currentUser && !state.isLocalPreview);
}

function clearStateForSignedOut() {
  state.items = [];
  state.itemsById = new Map();
  state.filteredItems = [];
  state.totalQty = 0;
  state.dirtyCount = 0;
  state.originalSnapshotMap = Object.create(null);
  state.visibleCount = INITIAL_VISIBLE_COUNT;
  state.autoSaveSuspended = false;
  state.hasShownRetryNotice = false;
  renderEmptyMessage("ログインすると在庫データを表示します。");
  updateStatsUI();
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
  if (!roomKey || !state.isAuthed) return inventoryMap;

  const itemsRef = collection(db, "inventory", roomKey, "items");
  const snapshot = await getDocs(itemsRef);
  snapshot.forEach(docSnap => {
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
  if (!state.roomKey || state.isSyncing || !canEdit()) return false;

  const dirtyItems = state.items.filter(item => snapshotKey(item) !== state.originalSnapshotMap[item.id]);
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
        <button type="button" class="qty-btn minus" ${canEdit() ? "" : "disabled"}>−</button>
        <div class="qty-num num">${item.qty}</div>
        <button type="button" class="qty-btn plus" ${canEdit() ? "" : "disabled"}>＋</button>
      </div>
    </article>`;
}

function renderEmptyMessage(message) {
  const container = document.getElementById("list");
  if (container) container.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
}
