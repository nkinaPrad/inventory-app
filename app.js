/**
 * ====================================================================
 * 教材在庫管理システム - data.js マスタ利用版 (app.js)
 * ====================================================================
 */

import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  setDoc,
  deleteDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";

const ROOM_LABEL_MAP = {
  takadanobaba: "高田馬場",
  sugamo: "巣鴨",
  nishinippori: "西日暮里",
  ohji: "王子",
  itabashi: "板橋",
  minamisenju: "南千住",
  kiba: "木場",
  gakuin: "学院",
};

const SEARCH_DEBOUNCE_MS = 120;
const INITIAL_VISIBLE_COUNT = 30;
const LOAD_MORE_COUNT = 30;
const AUTO_SAVE_DELAY_MS = 5000;
const AUTO_SAVE_MAX_INTERVAL_MS = 30000;
const INVENTORY_CACHE_TTL_MS = 1 * 60 * 60 * 1000;
const LOCAL_LOG_LIMIT = 80;
const LOCAL_LOG_STORAGE_KEY = "inventoryLocalLogs";

const CARD_TAP_MOVE_THRESHOLD_PX = 10;
const CARD_QUICK_TAP_MAX_MS = 280;
const CARD_LONG_PRESS_MS = 450;
const SYNTHETIC_CLICK_GUARD_MS = 500;

const INFO_MESSAGES = {
  LOADING: "データ同期中...",
  LOAD_DONE: "同期完了",
  NO_CHANGES: "変更はありません。",
  MANUAL_SAVING: "保存中...",
  AUTO_SAVING: "自動保存中...",
  MANUAL_SAVED: "保存しました。",
  AUTO_SAVED: "自動保存しました。",
  EDITING: "編集中",
};

const ERROR_MESSAGES = {
  INVALID_URL: "URLが無効です。",
  DISABLED_URL: "このURLは現在無効です。",
  ACCESS_CHECK_FAILED: "アクセス確認に失敗しました。通信状態をご確認ください。",
  LOAD_FAILED: "データ取得に失敗しました。",
  SAVE_FAILED:
    "保存に失敗しました。通信状態が安定しない場合は、ページのリロードはせず、メニューのバックアップ機能をご利用ください。",
  AUTO_SAVE_RETRY: "未保存の変更があります。保存ボタンで再試行してください。",
  SAVE_NOT_ALLOWED: "このURLでは保存できません。",
  ADD_CUSTOM_NOT_ALLOWED: "このURLでは未登録教材を追加できません。",
};

const state = {
  token: "",
  roomKey: "",
  roomLabel: "",
  latestUpdatedAt: null,
  completedAt: null,
  items: [],
  itemsById: new Map(),
  filteredItems: [],
  activeCategoryFilter: "all",
  showOnlyInputted: false,
  query: "",
  isSyncing: false,
  isCompleting: false,
  totalQty: 0,
  dirtyCount: 0,
  originalSnapshotMap: Object.create(null),
  originalUpdatedAtMap: Object.create(null),
  visibleCount: INITIAL_VISIBLE_COUNT,
  autoSaveTimerId: null,
  autoSaveMaxTimerId: null,
  autoSaveSuspended: false,
  hasShownRetryNotice: false,
  accessReady: false,
  accessGranted: false,
  tokenDocExists: false,
  tokenDocData: null,
  customDialogMode: "create",
  editingCustomItemId: "",
  copySourceItemId: "",
  activeCopyPopoverItemId: "",
  deletedItemIds: new Set(),
  deletedItemMetaMap: Object.create(null),
};

let listTouchStartY = 0;
let listTouchMoved = false;
let touchPressStartedAt = 0;
let longPressTimerId = 0;
let longPressTriggered = false;
let mousePressActive = false;
let mousePressStartX = 0;
let mousePressStartY = 0;
let mousePressStartedAt = 0;
let lastMousePressItemId = "";
let lastMousePressDurationMs = Number.POSITIVE_INFINITY;
let ignoreClickUntil = 0;
let lockedBodyScrollY = 0;
let activeSavePromise = null;

function redirectToInvalidUrl() {
  location.replace("./invalid-url.html");
}

document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(location.search);
  state.token = (params.get("token") || "").trim();

  if (!state.token) {
    redirectToInvalidUrl();
    return;
  }

  initUI();
  await initAccessAndLoad();
});

function initUI() {
  const roomLabelEl = document.getElementById("roomLabel");
  const sendBtn = document.getElementById("sendBtn");
  const searchInput = document.getElementById("searchInput");
  const searchClearBtn = document.getElementById("searchClearBtn");
  const filterArea = document.getElementById("filterArea");
  const inputOnlyToggle = document.getElementById("inputOnlyToggle");
  const list = document.getElementById("list");

  if (roomLabelEl) {
    if (state.roomLabel) {
      roomLabelEl.textContent = state.roomLabel;
    } else {
      roomLabelEl.textContent = "確認中";
      roomLabelEl.classList.add("muted");
    }
  }
  updatePageTitle();

  searchInput?.addEventListener(
    "input",
    debounce((e) => {
      state.query = String(e.target.value || "")
        .trim()
        .toLowerCase();
      state.visibleCount = INITIAL_VISIBLE_COUNT;
      applyFilterAndRender();
    }, SEARCH_DEBOUNCE_MS),
  );

  searchInput?.addEventListener("input", () => {
    syncSearchClearButton();
  });

  searchClearBtn?.addEventListener("click", () => {
    if (!searchInput) return;
    searchInput.value = "";
    state.query = "";
    state.visibleCount = INITIAL_VISIBLE_COUNT;
    syncSearchClearButton();
    applyFilterAndRender();
    searchInput.focus();
  });

  filterArea?.addEventListener("click", (e) => {
    const chip = e.target.closest(".f-chip[data-filter]");
    if (!chip) return;

    const nextFilter = chip.dataset.filter;
    if (!nextFilter) return;

    if (nextFilter === state.activeCategoryFilter) return;
    state.activeCategoryFilter = nextFilter;

    state.visibleCount = INITIAL_VISIBLE_COUNT;

    generateCategoryChips();
    applyFilterAndRender();
  });

  inputOnlyToggle?.addEventListener("click", () => {
    state.showOnlyInputted = !state.showOnlyInputted;
    state.visibleCount = INITIAL_VISIBLE_COUNT;
    syncInputOnlyToggleUI();
    applyFilterAndRender();
  });

  syncInputOnlyToggleUI();
  syncSearchClearButton();

  list?.addEventListener("click", handleListClick);
  list?.addEventListener("change", handleQtyInputCommit);
  list?.addEventListener("focusin", handleQtyInputFocusIn);
  list?.addEventListener("keydown", handleQtyInputKeydown);

  list?.addEventListener("touchstart", handleListTouchStart, { passive: true });
  list?.addEventListener("touchmove", handleListTouchMove, { passive: true });
  list?.addEventListener("touchend", handleListTouchEnd);
  list?.addEventListener("touchcancel", handleListTouchCancel);
  list?.addEventListener("mousedown", handleListMouseDown);
  list?.addEventListener("mousemove", handleListMouseMove);
  list?.addEventListener("mouseup", handleListMouseUp);
  list?.addEventListener("mouseleave", handleListMouseLeave);

  sendBtn?.addEventListener("click", () => {
    if (!canEdit()) {
      setErrorMessage(ERROR_MESSAGES.SAVE_NOT_ALLOWED);
      return;
    }
    void sendData({ silent: false, isManualRetry: true });
  });

  document
    .getElementById("toolMenuBtn")
    ?.addEventListener("click", () => openModal("toolMenuDialog"));
  document
    .getElementById("completeInventoryBtn")
    ?.addEventListener("click", () => void handleCompleteInventory());
  document
    .getElementById("closeToolMenuBtn")
    ?.addEventListener("click", () => closeModal("toolMenuDialog"));
  document
    .getElementById("viewInputtedListBtn")
    ?.addEventListener("click", () => {
      closeModal("toolMenuDialog");
      openInputtedItemsDialog();
    });
  document.getElementById("viewLocalLogsBtn")?.addEventListener("click", () => {
    closeModal("toolMenuDialog");
    openLocalLogsDialog();
  });
  document
    .getElementById("closeInputtedItemsBtn")
    ?.addEventListener("click", () => closeModal("inputtedItemsDialog"));
  document
    .getElementById("closeLocalLogsBtn")
    ?.addEventListener("click", () => closeModal("localLogsDialog"));
  document
    .getElementById("clearLocalLogsBtn")
    ?.addEventListener("click", clearLocalLogs);

  document
    .getElementById("toolMenuBtnAddCustom")
    ?.addEventListener("click", () => {
      if (!canEdit()) {
        setErrorMessage(ERROR_MESSAGES.ADD_CUSTOM_NOT_ALLOWED);
        return;
      }
      closeModal("toolMenuDialog");
      openCustomItemDialogForCreate();
    });

  document
    .getElementById("customQtyMinus")
    ?.addEventListener("click", () => changeCustomQty(-1));
  document
    .getElementById("customQtyPlus")
    ?.addEventListener("click", () => changeCustomQty(1));
  document
    .getElementById("customQtyInput")
    ?.addEventListener("focus", selectInputValueOnFocus);
  document
    .getElementById("customItemForm")
    ?.addEventListener("submit", handleCustomItemSubmit);
  document
    .getElementById("cancelCustomBtn")
    ?.addEventListener("click", () => closeModal("customItemDialog"));
  document
    .getElementById("closeCustomDialogBtn")
    ?.addEventListener("click", () => closeModal("customItemDialog"));
  document
    .getElementById("deleteCustomBtn")
    ?.addEventListener("click", handleDeleteCustomItem);
  document
    .getElementById("copyFromItemBtn")
    ?.addEventListener("click", handleCopyFromItem);
  document
    .getElementById("editCustomItemBtn")
    ?.addEventListener("click", handleEditCustomItemFromPopover);
  document
    .getElementById("backupInfoBtn")
    ?.addEventListener("click", handleBackupInfoClick);

  document.getElementById("exportJsonBtn")?.addEventListener("click", () => {
    closeModal("toolMenuDialog");
    exportJsonBackup();
  });

  document.getElementById("importJsonBtn")?.addEventListener("click", () => {
    closeModal("toolMenuDialog");
    document.getElementById("importFileInput")?.click();
  });

  document.getElementById("exportCsvBtn")?.addEventListener("click", () => {
    closeModal("toolMenuDialog");
    exportCsv();
  });

  initCustomItemHints();

  document
    .getElementById("importFileInput")
    ?.addEventListener("change", importJsonBackup);

  attachDialogBackdropClose("toolMenuDialog");
  attachDialogBackdropClose("inputtedItemsDialog");
  attachDialogBackdropClose("localLogsDialog");
  attachDialogBackdropClose("customItemDialog");

  document.addEventListener("click", handleDocumentClickForCopyPopover);
  window.addEventListener("resize", closeCopyPopover);
  window.addEventListener("scroll", closeCopyPopover, true);
}

function initCustomItemHints() {
  const hintConfigs = [
    {
      fieldId: "customName",
      ariaLabel: "教材名の入力ヒント",
      message: "学年・編・巻番号まで含めた教材名を入力してください。",
    },
    {
      fieldId: "customEdition",
      ariaLabel: "版・準拠の入力ヒント",
      message:
        "表紙（または背表紙）に版や準拠の記載があれば入力してください。<br>教材名に版・準拠まで入力した場合、こちらは入力不要です。",
    },
    {
      fieldId: "customPublisher",
      ariaLabel: "出版社の入力ヒント",
      message:
        "出版社名の入力は原則不要です。ただし、教材名が汎用的な場合、同名教材との混同を避けるために入力をお願いします。<br>例えば、教材名が『夏期テキスト』『計算ドリル』などの場合は出版社を入力してください。",
    },
  ];

  hintConfigs.forEach(({ fieldId, ariaLabel, message }) => {
    const label = document.querySelector(
      `#customItemDialog label[for="${fieldId}"]`,
    );
    const row = label?.closest(".form-row");
    if (!label || !row || row.querySelector(".hint-trigger")) return;

    const labelWrap = document.createElement("div");
    labelWrap.className = "label-with-hint";
    label.before(labelWrap);
    labelWrap.appendChild(label);

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "hint-trigger";
    trigger.setAttribute("aria-label", ariaLabel);
    trigger.tabIndex = -1;

    const icon = document.createElement("img");
    icon.className = "hint-icon";
    icon.src = "images/info.svg";
    icon.alt = "";
    icon.setAttribute("aria-hidden", "true");
    trigger.appendChild(icon);

    const tooltip = document.createElement("span");
    const tooltipId = `${fieldId}Hint`;
    tooltip.id = tooltipId;
    tooltip.className = "hint-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.innerHTML = message;
    trigger.setAttribute("aria-describedby", tooltipId);

    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      document.querySelectorAll(".hint-trigger.is-open").forEach((button) => {
        if (button !== trigger) {
          button.classList.remove("is-open");
        }
      });
      trigger.classList.toggle("is-open");
    });

    trigger.addEventListener("blur", () => {
      trigger.classList.remove("is-open");
    });

    labelWrap.append(trigger, tooltip);
  });

  document.addEventListener("click", (event) => {
    if (
      event.target.closest(".label-with-hint") ||
      event.target.closest(".menu-group-hint")
    ) {
      return;
    }
    document.querySelectorAll(".hint-trigger.is-open").forEach((button) => {
      button.classList.remove("is-open");
    });
  });
}

function handleBackupInfoClick(event) {
  event.preventDefault();

  const trigger = event.currentTarget;
  if (!trigger) return;

  document.querySelectorAll(".hint-trigger.is-open").forEach((button) => {
    if (button !== trigger) {
      button.classList.remove("is-open");
    }
  });

  trigger.classList.toggle("is-open");
}

function syncInputOnlyToggleUI() {
  const toggle = document.getElementById("inputOnlyToggle");
  if (!toggle) return;

  const isActive = state.showOnlyInputted;
  toggle.classList.toggle("active", isActive);
  toggle.classList.remove("is-disabled");
  toggle.setAttribute("aria-pressed", String(isActive));
  toggle.setAttribute(
    "aria-label",
    isActive ? "入力済みのみを表示中" : "入力済みのみを表示",
  );
  toggle.title = "入力済みのみを切り替え";
  toggle.textContent = "入力済みのみ";
  toggle.disabled = false;
}

function syncSearchClearButton() {
  const searchInput = document.getElementById("searchInput");
  const clearBtn = document.getElementById("searchClearBtn");
  if (!searchInput || !clearBtn) return;

  clearBtn.hidden = String(searchInput.value || "").length === 0;
}

function formatNow() {
  return new Date().toLocaleString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDateTime(value) {
  const date =
    value instanceof Date
      ? value
      : Number.isFinite(new Date(value).getTime())
        ? new Date(value)
        : null;
  if (!date) return "";

  return date.toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function readLocalLogs() {
  try {
    const raw = localStorage.getItem(LOCAL_LOG_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("ローカルログの読み込みに失敗:", err);
    return [];
  }
}

function writeLocalLogs(logs) {
  try {
    localStorage.setItem(
      LOCAL_LOG_STORAGE_KEY,
      JSON.stringify(logs.slice(0, LOCAL_LOG_LIMIT)),
    );
  } catch (err) {
    console.warn("ローカルログの保存に失敗:", err);
  }
}

function addLocalLog(type, message) {
  const logs = readLocalLogs();
  logs.unshift({
    type,
    message,
    room: state.roomLabel || state.roomKey || "",
    at: new Date().toISOString(),
  });
  writeLocalLogs(logs);
}

function getLogTypeClass(type) {
  const normalized = String(type || "").toLowerCase();
  if (normalized === "conflict" || normalized === "error") {
    return "log-entry-type is-alert";
  }
  return "log-entry-type";
}

function renderLocalLogsDialog() {
  const listEl = document.getElementById("localLogsList");
  if (!listEl) return;

  const logs = readLocalLogs();
  if (logs.length === 0) {
    listEl.innerHTML = `<div class="empty">ログはまだありません。</div>`;
    return;
  }

  listEl.innerHTML = `
    <div class="log-list">
      ${logs
        .map(
          (log) => `
            <article class="log-entry">
              <div class="log-entry-head">
                <span class="${getLogTypeClass(log.type)}">${escapeHtml(log.type || "info")}</span>
                <span class="log-entry-time">${escapeHtml(formatDateTime(log.at))}</span>
              </div>
              <div class="log-entry-message">${escapeHtml(log.message || "")}</div>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}

function openLocalLogsDialog() {
  renderLocalLogsDialog();
  openModal("localLogsDialog");
}

function clearLocalLogs() {
  try {
    localStorage.removeItem(LOCAL_LOG_STORAGE_KEY);
  } catch (err) {
    console.warn("ローカルログの削除に失敗:", err);
  }
  renderLocalLogsDialog();
}

function timestampToDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate();
  if (typeof ts.seconds === "number" && typeof ts.nanoseconds === "number") {
    return new Date(ts.seconds * 1000 + Math.floor(ts.nanoseconds / 1000000));
  }
  return null;
}

function formatTimestamp(ts) {
  const date = timestampToDate(ts);
  if (!date) return "";
  return date.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isInventoryCompleted() {
  return !!state.completedAt;
}

function getCompletionInfoMessage() {
  const completedAtLabel = formatTimestamp(state.completedAt);
  if (!completedAtLabel) {
    return "本部への送信が完了しています。再編集を希望する場合、教務本部までご連絡ください。";
  }

  return `本部への送信が完了しています。再編集を希望する場合、教務本部までご連絡ください。 / 本部送信: ${completedAtLabel}`;
}

function updateInfoBanner(message = "") {
  if (message) {
    setInfoMessage(message, false);
    return;
  }

  if (isInventoryCompleted()) {
    setInfoMessage(getCompletionInfoMessage(), false);
    return;
  }

  if (state.latestUpdatedAt) {
    setInfoMessage(
      `最終更新: ${formatTimestamp(state.latestUpdatedAt)}`,
      false,
    );
    return;
  }

  setInfoMessage(INFO_MESSAGES.LOAD_DONE);
}

function setInfoMessage(message, withTimestamp = true) {
  const el = document.getElementById("infoMessage");
  if (!el) return;
  if (isInventoryCompleted()) {
    el.textContent = getCompletionInfoMessage();
    return;
  }
  el.textContent = withTimestamp ? `${message} (${formatNow()})` : message;
}

function setErrorMessage(message = "") {
  const el = document.getElementById("errorMessage");
  if (!el) return;

  if (isInventoryCompleted()) {
    el.textContent = "";
    el.hidden = true;
    return;
  }

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

function syncTokenState(tokenData = null) {
  state.tokenDocData = tokenData;
  state.completedAt = tokenData?.completedAt || null;
  state.roomKey = String(tokenData?.roomKey || "")
    .trim()
    .toLowerCase();
  state.roomLabel = String(
    tokenData?.roomLabel || ROOM_LABEL_MAP[state.roomKey] || "",
  ).trim();
}

function syncCompletionUI() {
  const completeStatus = document.getElementById("completeInventoryStatus");
  const backupMenuGroup = document.getElementById("backupMenuGroup");

  if (completeStatus) {
    completeStatus.hidden = true;
  }

  updateFooterActions();

  if (backupMenuGroup) {
    backupMenuGroup.hidden = isInventoryCompleted();
  }
}

async function initAccessAndLoad() {
  try {
    clearErrorMessage();

    const tokenRef = doc(db, "inventory", state.token);
    const tokenSnap = await getDoc(tokenRef);

    state.accessReady = true;
    state.tokenDocExists = tokenSnap.exists();

    if (!tokenSnap.exists()) {
      setReadOnlyMode(true);
      syncCompletionUI();
      redirectToInvalidUrl();
      return;
    }

    const tokenData = tokenSnap.data() || {};
    syncTokenState(tokenData);
    updateRoomLabel();

    if (tokenData.enabled !== true) {
      setReadOnlyMode(true);
      state.accessGranted = false;
      syncCompletionUI();
      setErrorMessage(ERROR_MESSAGES.DISABLED_URL);
      renderEmptyMessage(ERROR_MESSAGES.DISABLED_URL);
      updateStatsUI();
      return;
    }

    state.accessGranted = true;
    setReadOnlyMode(!canEdit());
    clearErrorMessage();
    syncCompletionUI();

    await loadAppData();
  } catch (err) {
    console.error("アクセス確認失敗:", err);
    addLocalLog("error", "アクセス確認に失敗しました");
    setReadOnlyMode(true);
    syncCompletionUI();
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
    updatePageTitle();
    return;
  }

  if (state.roomKey) {
    roomLabelEl.textContent = ROOM_LABEL_MAP[state.roomKey] || state.roomKey;
    updatePageTitle();
    return;
  }

  roomLabelEl.textContent = "未設定";
  roomLabelEl.classList.add("muted");
  updatePageTitle();
}

function updatePageTitle() {
  const roomLabel = document.getElementById("roomLabel")?.textContent.trim();
  document.title = roomLabel ? `教材棚卸（${roomLabel}）` : "教材棚卸";
}

function canEdit() {
  return !!(state.token && state.accessGranted && !isInventoryCompleted());
}

async function loadAppData() {
  clearErrorMessage();
  setInfoMessage(INFO_MESSAGES.LOADING);

  try {
    const [masterData, inventoryMap] = await Promise.all([
      Promise.resolve(getFallbackMasterData()),
      loadInventoryFromFirestore(state.token),
    ]);

    const latestUpdatedAt = getLatestUpdatedAt(inventoryMap);
    state.latestUpdatedAt = latestUpdatedAt;

    buildStateFromSources(masterData, inventoryMap);
    generateCategoryChips();
    syncInputOnlyToggleUI();
    updateStatsUI();
    applyFilterAndRender();

    updateInfoBanner();
  } catch (err) {
    console.error(err);
    addLocalLog("error", "在庫データの読み込みに失敗しました");
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

function getInventoryCacheKey(token) {
  return `inventoryCache:${token}`;
}

function serializeTimestamp(ts) {
  if (
    !ts ||
    typeof ts.seconds !== "number" ||
    typeof ts.nanoseconds !== "number"
  ) {
    return null;
  }

  return {
    seconds: ts.seconds,
    nanoseconds: ts.nanoseconds,
  };
}

function reviveTimestamp(ts) {
  if (
    !ts ||
    typeof ts.seconds !== "number" ||
    typeof ts.nanoseconds !== "number"
  ) {
    return null;
  }

  return {
    seconds: ts.seconds,
    nanoseconds: ts.nanoseconds,
    toDate() {
      return new Date(ts.seconds * 1000 + Math.floor(ts.nanoseconds / 1000000));
    },
  };
}

function readInventoryCache(token) {
  if (!token) return null;

  try {
    const raw = localStorage.getItem(getInventoryCacheKey(token));
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      !Array.isArray(parsed.items) ||
      typeof parsed.cachedAt !== "number"
    ) {
      localStorage.removeItem(getInventoryCacheKey(token));
      return null;
    }

    if (Date.now() - parsed.cachedAt > INVENTORY_CACHE_TTL_MS) {
      localStorage.removeItem(getInventoryCacheKey(token));
      return null;
    }

    const inventoryMap = new Map();

    parsed.items.forEach((entry) => {
      const id = String(entry?.id || "").trim();
      if (!id || !entry?.data) return;

      inventoryMap.set(id, {
        ...entry.data,
        updatedAt: reviveTimestamp(entry.data.updatedAt),
      });
    });

    addLocalLog(
      "cache",
      `在庫キャッシュを使用しました (${inventoryMap.size}件)`,
    );
    return inventoryMap;
  } catch (err) {
    console.warn("在庫キャッシュの読み込みに失敗:", err);
    return null;
  }
}

function writeInventoryCache(token, inventoryMap) {
  if (!token) return;

  try {
    const items = Array.from(inventoryMap.entries()).map(([id, data]) => ({
      id,
      data: {
        ...data,
        updatedAt: serializeTimestamp(data?.updatedAt),
      },
    }));

    localStorage.setItem(
      getInventoryCacheKey(token),
      JSON.stringify({
        cachedAt: Date.now(),
        items,
      }),
    );
  } catch (err) {
    console.warn("在庫キャッシュの保存に失敗:", err);
  }
}

function clearInventoryCache(token) {
  if (!token) return;

  try {
    localStorage.removeItem(getInventoryCacheKey(token));
    addLocalLog("cache", "在庫キャッシュを無効化しました");
  } catch (err) {
    console.warn("在庫キャッシュの削除に失敗:", err);
  }
}

function buildInventoryMapFromState() {
  const inventoryMap = new Map();

  state.items.forEach((item) => {
    const updatedAtKey = state.originalUpdatedAtMap[item.id] || "";
    const hasRemoteState = updatedAtKey && updatedAtKey !== "__NEW_ITEM__";

    if (!item.isCustom && item.qty === 0 && !hasRemoteState) {
      return;
    }

    const data = buildFirestoreItemPayload(item);
    delete data.updatedAt;

    data.updatedAt = reviveTimestamp(parseTimestampKey(updatedAtKey));
    inventoryMap.set(item.id, data);
  });

  return inventoryMap;
}

async function loadInventoryFromFirestore(token) {
  const inventoryMap = new Map();
  if (!token || !state.accessGranted) return inventoryMap;

  const cachedInventoryMap = readInventoryCache(token);
  if (cachedInventoryMap) {
    return cachedInventoryMap;
  }

  const itemsRef = collection(db, "inventory", token, "items");
  const snapshot = await getDocs(itemsRef);

  snapshot.forEach((docSnap) => {
    inventoryMap.set(docSnap.id, docSnap.data());
  });

  writeInventoryCache(token, inventoryMap);
  addLocalLog(
    "load",
    `Firestore から在庫を読み込みました (${inventoryMap.size}件)`,
  );
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
  state.originalUpdatedAtMap = Object.create(null);
  state.totalQty = 0;
  state.dirtyCount = 0;
  state.autoSaveSuspended = false;
  state.hasShownRetryNotice = false;
  state.visibleCount = INITIAL_VISIBLE_COUNT;
  state.deletedItemIds = new Set();
  state.deletedItemMetaMap = Object.create(null);

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
      isCustom: false,
    });

    pushItemToState(item, savedData.updatedAt || null);
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
      isCustom: true,
    });
    pushItemToState(item, data.updatedAt || null);
  });

  recalcTotalQty();
}

function pushItemToState(item, updatedAt = null) {
  state.items.push(item);
  state.itemsById.set(item.id, item);
  state.originalSnapshotMap[item.id] = snapshotKey(item);
  state.originalUpdatedAtMap[item.id] = timestampKey(updatedAt);
}

function pushNewDirtyItemToState(item) {
  state.items.push(item);
  state.itemsById.set(item.id, item);
  state.originalSnapshotMap[item.id] = "__NEW_ITEM__";
  state.originalUpdatedAtMap[item.id] = "__NEW_ITEM__";
}

function timestampKey(ts) {
  if (
    !ts ||
    typeof ts.seconds !== "number" ||
    typeof ts.nanoseconds !== "number"
  ) {
    return "";
  }
  return `${ts.seconds}_${ts.nanoseconds}`;
}

function parseTimestampKey(key) {
  if (!key || key === "__NEW_ITEM__") return null;

  const [secondsStr, nanosecondsStr] = String(key).split("_");
  const seconds = Number(secondsStr);
  const nanoseconds = Number(nanosecondsStr);

  if (!Number.isFinite(seconds) || !Number.isFinite(nanoseconds)) {
    return null;
  }

  return { seconds, nanoseconds };
}

function hasConflictWithRemote(originalUpdatedAtKey, remoteUpdatedAtKey) {
  if (originalUpdatedAtKey === "__NEW_ITEM__") {
    return remoteUpdatedAtKey !== "";
  }
  return originalUpdatedAtKey !== remoteUpdatedAtKey;
}

function syncOriginalState(item, updatedAt = null) {
  state.originalSnapshotMap[item.id] = snapshotKey(item);
  state.originalUpdatedAtMap[item.id] = timestampKey(updatedAt);
  item.__dirty = false;
}

function replaceItemWithRemoteData(item, remoteData) {
  item.qty = Number(remoteData?.qty) || 0;

  if (item.isCustom) {
    item.name = remoteData?.name || item.name;
    item.publisher = remoteData?.publisher || "";
    item.edition = remoteData?.edition || "";
  }

  item.searchTag = [
    item.name,
    item.category,
    item.subject,
    item.publisher,
    item.edition,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function buildConflictMessage(conflictNames) {
  const names = conflictNames.join("、");
  return `${conflictNames.length}件は他の端末で更新されていたため保存していません。 対象: ${names}`;
}

async function handleCompleteInventory() {
  if (state.isCompleting || isInventoryCompleted()) {
    return;
  }

  if (!state.token || !state.accessGranted) {
    return;
  }

  const confirmed = confirm(
    "【棚卸完了】\n棚卸結果を本部へ送信しますか？\n（すべての在庫入力を終えてから実行してください）\n\n送信後は、入力内容を変更できなくなります。\n棚卸が完了していない場合は、キャンセルを押してください。",
  );
  if (!confirmed) return;

  if (state.isSyncing && activeSavePromise) {
    setInfoMessage("保存完了を待っています...", false);
    const currentSaveSucceeded = await activeSavePromise;
    if (!currentSaveSucceeded && state.dirtyCount === 0) {
      setInfoMessage(
        "保存処理で問題が発生したため、本部への送信を中止しました。",
        false,
      );
      return;
    }
  }

  if (state.dirtyCount > 0) {
    const saved = await sendData({
      silent: false,
      isManualRetry: true,
      requireClean: true,
    });
    if (!saved) {
      setInfoMessage(
        "保存処理で問題が発生したため、本部への送信を中止しました。",
        false,
      );
      return;
    }
  }

  state.isCompleting = true;
  syncCompletionUI();
  clearErrorMessage();
  setInfoMessage("本部送信中...", false);

  try {
    const tokenRef = doc(db, "inventory", state.token);
    await setDoc(
      tokenRef,
      {
        completedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    const completedSnap = await getDoc(tokenRef);
    if (completedSnap.exists()) {
      syncTokenState(completedSnap.data() || {});
      updateRoomLabel();
    }

    state.latestUpdatedAt = getLatestUpdatedAt(buildInventoryMapFromState());
    clearAutoSaveTimer();
    closeModal("toolMenuDialog");
    setReadOnlyMode(true);
    clearErrorMessage();
    updateInfoBanner();
    addLocalLog("info", "棚卸結果を本部に送信しました");
  } catch (err) {
    console.error("本部送信失敗:", err);
    addLocalLog("error", "棚卸結果の本部送信に失敗しました");
    setErrorMessage(
      "棚卸結果の本部送信に失敗しました。通信状態を確認して再度お試しください。",
    );
  } finally {
    state.isCompleting = false;
    syncCompletionUI();
    updateStatsUI();
  }
}

function sendData(options = {}) {
  if (state.isSyncing) {
    return activeSavePromise || Promise.resolve(false);
  }

  const savePromise = performSendData(options);
  const trackedSavePromise = savePromise.finally(() => {
    if (activeSavePromise === trackedSavePromise) {
      activeSavePromise = null;
    }
  });
  activeSavePromise = trackedSavePromise;
  return trackedSavePromise;
}

async function performSendData({
  silent = false,
  isManualRetry = false,
  requireClean = false,
} = {}) {
  if (!state.token || !canEdit()) return false;

  const dirtyItems = state.items.filter(
    (item) => snapshotKey(item) !== state.originalSnapshotMap[item.id],
  );
  const deletedItemIds = Array.from(state.deletedItemIds);

  if (dirtyItems.length === 0 && deletedItemIds.length === 0) {
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
  syncCompletionUI();
  updateStatsUI();
  clearErrorMessage();
  setInfoMessage(
    silent ? INFO_MESSAGES.AUTO_SAVING : INFO_MESSAGES.MANUAL_SAVING,
  );

  try {
    const conflictNames = [];
    let savedCount = 0;

    for (const itemId of deletedItemIds) {
      const ref = doc(db, "inventory", state.token, "items", itemId);
      const remoteSnap = await getDoc(ref);
      const remoteData = remoteSnap.exists() ? remoteSnap.data() : null;
      const remoteUpdatedAtKey = timestampKey(remoteData?.updatedAt);
      const deletedMeta = state.deletedItemMetaMap[itemId];

      if (
        remoteSnap.exists() &&
        deletedMeta &&
        hasConflictWithRemote(deletedMeta.updatedAtKey, remoteUpdatedAtKey)
      ) {
        const restoredItem = normalizeItem({
          id: itemId,
          name: remoteData?.name || deletedMeta.name || "未登録教材",
          category: "未登録教材",
          subject: "",
          publisher: remoteData?.publisher || "",
          edition: remoteData?.edition || "",
          qty: Number(remoteData?.qty) || 0,
          isCustom: true,
        });

        pushItemToState(restoredItem, remoteData?.updatedAt || null);
        conflictNames.push(getDisplayItemName(restoredItem));
        delete state.deletedItemMetaMap[itemId];
        state.deletedItemIds.delete(itemId);
        continue;
      }

      await deleteDoc(ref);
      state.deletedItemIds.delete(itemId);
      delete state.deletedItemMetaMap[itemId];
      savedCount += 1;
    }

    for (const item of dirtyItems) {
      const ref = doc(db, "inventory", state.token, "items", item.id);
      const remoteSnap = await getDoc(ref);
      const remoteData = remoteSnap.exists() ? remoteSnap.data() : null;
      const remoteUpdatedAtKey = timestampKey(remoteData?.updatedAt);
      const originalUpdatedAtKey = state.originalUpdatedAtMap[item.id] || "";

      if (hasConflictWithRemote(originalUpdatedAtKey, remoteUpdatedAtKey)) {
        if (remoteData) {
          replaceItemWithRemoteData(item, remoteData);
          syncOriginalState(item, remoteData.updatedAt || null);
        } else if (item.isCustom) {
          const conflictName = getDisplayItemName(item);
          removeItemFromState(item.id);
          conflictNames.push(conflictName);
          continue;
        }
        conflictNames.push(getDisplayItemName(item));
        continue;
      }

      const payload = buildFirestoreItemPayload(item);

      await setDoc(ref, payload);
      const savedSnap = await getDoc(ref);
      const savedData = savedSnap.exists() ? savedSnap.data() : null;

      syncOriginalState(item, savedData?.updatedAt || null);
      savedCount += 1;
    }

    recalcTotalQty();
    applyFilterAndRender();
    state.latestUpdatedAt = getLatestUpdatedAt(buildInventoryMapFromState());
    state.autoSaveSuspended = false;
    state.hasShownRetryNotice = false;
    clearAutoSaveTimer();
    clearErrorMessage();
    if (conflictNames.length > 0) {
      clearInventoryCache(state.token);
      addLocalLog(
        "conflict",
        `競合を検知しました: ${conflictNames.join("、")}`,
      );
      setErrorMessage(buildConflictMessage(conflictNames));
      if (savedCount > 0) {
        setInfoMessage(
          `${savedCount}件を保存しました。競合した教材は最新の内容に更新しています。`,
        );
      } else {
        setInfoMessage("競合した教材の最新内容を反映しました。");
      }
      return !requireClean;
    } else {
      writeInventoryCache(state.token, buildInventoryMapFromState());
      setInfoMessage(
        silent ? INFO_MESSAGES.AUTO_SAVED : INFO_MESSAGES.MANUAL_SAVED,
      );
    }
    return true;
  } catch (err) {
    console.error("保存失敗:", err);
    addLocalLog("error", "保存に失敗しました");
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
    syncCompletionUI();
    updateStatsUI();
  }
}

function scheduleAutoSave() {
  if (!canEdit()) return;

  clearAutoSaveDelayTimer();

  if (state.dirtyCount === 0) return;

  if (state.autoSaveSuspended) {
    setErrorMessage(ERROR_MESSAGES.AUTO_SAVE_RETRY);
    return;
  }

  clearErrorMessage();
  setInfoMessage(INFO_MESSAGES.EDITING);

  state.autoSaveTimerId = setTimeout(() => {
    clearAutoSaveTimer();
    void sendData({ silent: true, isManualRetry: false });
  }, AUTO_SAVE_DELAY_MS);

  if (!state.autoSaveMaxTimerId) {
    state.autoSaveMaxTimerId = setTimeout(() => {
      clearAutoSaveTimer();
      void sendData({ silent: true, isManualRetry: false });
    }, AUTO_SAVE_MAX_INTERVAL_MS);
  }
}

function clearAutoSaveDelayTimer() {
  if (state.autoSaveTimerId) {
    clearTimeout(state.autoSaveTimerId);
    state.autoSaveTimerId = null;
  }
}

function clearAutoSaveTimer() {
  clearAutoSaveDelayTimer();

  if (state.autoSaveMaxTimerId) {
    clearTimeout(state.autoSaveMaxTimerId);
    state.autoSaveMaxTimerId = null;
  }
}

function generateCategoryChips() {
  const container = document.getElementById("filterArea");
  if (!container) return;

  const categories = Array.from(
    new Set(
      state.items
        .filter((item) => !item.isCustom)
        .map((item) => item.category)
        .filter(Boolean),
    ),
  );

  const isCategoryActive = (key) =>
    state.activeCategoryFilter === key ? " active" : "";

  const categoryButtons = categories
    .filter((c) => c && c !== "未登録教材")
    .map((c) => {
      return `<button type="button" class="f-chip${isCategoryActive(c)}" data-filter="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
    })
    .join("");

  let html = "";

  html += `
    <div class="filter-section filter-section-primary">
      <div class="filter-chip-row">
        <button type="button" class="f-chip chip-custom${isCategoryActive("custom")}" data-filter="custom">未登録</button>
      </div>
    </div>
  `;

  html += `
    <div class="filter-section filter-section-category">
      <div class="filter-chip-row">
        <button type="button" class="f-chip chip-all${isCategoryActive("all")}" data-filter="all">すべて</button>
        ${categoryButtons}
      </div>
    </div>
  `;

  container.innerHTML = html;
}

function applyFilterAndRender() {
  const q = state.query;
  const categoryFilter = state.activeCategoryFilter;
  const showOnlyInputted = state.showOnlyInputted;

  state.filteredItems = state.items.filter((item) => {
    const matchesQuery = !q || item.searchTag.includes(q);
    if (!matchesQuery) return false;

    if (categoryFilter === "custom") {
      return item.isCustom && (!showOnlyInputted || item.qty > 0);
    }

    if (item.isCustom) return false;

    const matchesCategory =
      categoryFilter === "all" ? true : item.category === categoryFilter;

    if (!matchesCategory) return false;

    if (showOnlyInputted) {
      return item.qty > 0;
    }

    return true;
  });

  renderFilteredItems();
}

function renderFilteredItems() {
  const container = document.getElementById("list");
  if (!container) return;

  closeCopyPopover();

  if (state.filteredItems.length === 0) {
    const emptyText =
      state.activeCategoryFilter === "custom" && state.showOnlyInputted
        ? "入力済みの未登録教材はありません。"
        : getEmptyMessage();
    container.innerHTML = `<div class="empty">${escapeHtml(emptyText)}</div>`;
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

function getEmptyMessage() {
  if (state.activeCategoryFilter === "custom") {
    return "未登録教材はありません。";
  }

  if (state.showOnlyInputted) {
    return "入力済みの教材はありません。";
  }

  return "該当する教材がありません。";
}

function renderItemHTML(item) {
  const displayName = getDisplayItemName(item);
  const topMeta = [item.publisher].filter(Boolean).join(" / ");
  const hasQty = item.qty > 0;
  return `
    <article class="item ${hasQty ? "has-qty" : ""} ${item.isCustom ? "custom-item" : ""}" data-id="${escapeHtml(item.id)}">
      <div class="item-main">
        <div class="item-topline">
          <div class="item-badges">
            ${item.isCustom ? "" : `<span class="badge badge-cat">${escapeHtml(item.category)}</span>`}
            ${item.subject ? `<span class="badge badge-sub">${escapeHtml(item.subject)}</span>` : ""}
            ${item.isCustom ? `<span class="badge badge-custom">未登録教材</span>` : ""}
          </div>
          ${topMeta ? `<div class="item-publisher-top">${escapeHtml(topMeta)}</div>` : ""}
        </div>
        <div class="item-name">${escapeHtml(displayName)}</div>
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
    isCustom: !!raw.isCustom,
  };

  item.searchTag = [
    item.name,
    item.category,
    item.subject,
    item.publisher,
    item.edition,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return item;
}

function getDisplayItemName(item) {
  if (item.isCustom && item.edition) {
    return `${item.name}（${item.edition}）`;
  }
  return item.name;
}

function snapshotKey(item) {
  if (item.isCustom) {
    return `${item.id}_${item.qty}_${item.name}_${item.publisher}_${item.edition}_${item.category}_${item.subject}_1`;
  }
  return `${item.id}_${item.qty}_0`;
}

function buildFirestoreItemPayload(item) {
  const payload = {
    qty: item.qty,
    isCustom: !!item.isCustom,
    updatedAt: serverTimestamp(),
  };

  if (!item.isCustom) return payload;

  payload.name = item.name;

  if (item.publisher) payload.publisher = item.publisher;
  if (item.edition) payload.edition = item.edition;

  return payload;
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
  const addCustomBtn = document.getElementById("toolMenuBtnAddCustom");
  if (addCustomBtn) addCustomBtn.hidden = isReadOnly;

  const list = document.getElementById("list");
  closeCopyPopover();
  if (isReadOnly) {
    list?.classList.add("readonly-mode");
  } else {
    list?.classList.remove("readonly-mode");
  }

  syncCompletionUI();
}

function recalcTotalQty() {
  state.totalQty = state.items.reduce((sum, item) => sum + item.qty, 0);
  state.dirtyCount =
    state.items.filter(
      (item) => snapshotKey(item) !== state.originalSnapshotMap[item.id],
    ).length + state.deletedItemIds.size;
}

function updateStatsUI() {
  recalcTotalQty();

  const totalQtyEl = document.getElementById("totalQty");

  if (totalQtyEl) totalQtyEl.textContent = state.totalQty;

  updateFooterActions();
}

function updateFooterActions() {
  const dirtyCountEl = document.getElementById("dirtyCount");
  const saveStatusEl = document.querySelector(".save-status");
  const bottomActions = document.querySelector(".bottom-actions");
  const sendBtn = document.getElementById("sendBtn");
  const hasDirty = state.dirtyCount > 0;
  const isBusy = state.isSyncing || state.isCompleting;

  if (dirtyCountEl && saveStatusEl) {
    if (isInventoryCompleted()) {
      dirtyCountEl.textContent = "本部送信完了";
      saveStatusEl.dataset.state = "completed";
    } else if (state.isCompleting) {
      dirtyCountEl.textContent = "本部へ送信中…";
      saveStatusEl.dataset.state = "sending";
    } else if (state.isSyncing) {
      dirtyCountEl.textContent = "保存中…";
      saveStatusEl.dataset.state = "saving";
    } else if (state.autoSaveSuspended) {
      dirtyCountEl.textContent = "保存失敗";
      saveStatusEl.dataset.state = "error";
    } else if (hasDirty) {
      dirtyCountEl.textContent = "未保存の変更あり";
      saveStatusEl.dataset.state = "dirty";
    } else {
      dirtyCountEl.textContent = "保存済み";
      saveStatusEl.dataset.state = "saved";
    }
  }

  if (bottomActions) {
    bottomActions.hidden = isInventoryCompleted();
  }

  if (sendBtn) {
    sendBtn.textContent = "保存";
    sendBtn.classList.toggle("dirty", hasDirty);
    sendBtn.disabled = !hasDirty || isBusy || !canEdit();
  }
}

function handleListClick(e) {
  const target = e.target;

  if (target.id === "loadMoreBtn") {
    state.visibleCount += LOAD_MORE_COUNT;
    renderFilteredItems();
    return;
  }

  if (Date.now() < ignoreClickUntil) {
    return;
  }

  const popover = document.getElementById("copyPopover");
  if (
    popover &&
    !popover.hidden &&
    !target.closest("#copyPopover") &&
    target.closest(".item")
  ) {
    closeCopyPopover();
    lastMousePressItemId = "";
    lastMousePressDurationMs = Number.POSITIVE_INFINITY;
    return;
  }

  if (target.closest(".qty-btn")) {
    const itemEl = target.closest(".item");
    if (!itemEl) return;
    const id = itemEl.dataset.id;
    if (!id) return;
    const item = state.itemsById.get(id);
    if (!item) return;

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

  const mainArea = target.closest(".item-main");
  if (!mainArea) return;

  const itemEl = mainArea.closest(".item");
  if (!itemEl) return;

  const id = itemEl.dataset.id;
  if (!id) return;

  const isQuickMouseTap =
    lastMousePressItemId === id &&
    lastMousePressDurationMs <= CARD_QUICK_TAP_MAX_MS;
  lastMousePressItemId = "";
  lastMousePressDurationMs = Number.POSITIVE_INFINITY;
  if (!isQuickMouseTap) return;

  const item = state.itemsById.get(id);
  if (!item) return;

  closeCopyPopover();
  changeQty(id, 1);
}

function handleListTouchStart(e) {
  if (!e.touches || e.touches.length === 0) return;

  const target = e.target;
  if (
    !target.closest(".item-main") ||
    target.closest(".qty-box") ||
    target.closest(".qty-input") ||
    target.closest(".qty-btn")
  ) {
    clearLongPressState();
    return;
  }

  const itemEl = target.closest(".item");
  const id = itemEl?.dataset.id || "";
  const item = id ? state.itemsById.get(id) : null;

  listTouchStartY = e.touches[0].clientY;
  listTouchMoved = false;
  touchPressStartedAt = Date.now();
  longPressTriggered = false;

  if (!itemEl || !item || !canEdit()) {
    clearLongPressTimer();
    return;
  }

  startLongPress(itemEl, item);
}

function handleListTouchMove(e) {
  if (!e.touches || e.touches.length === 0) return;
  const currentY = e.touches[0].clientY;
  if (Math.abs(currentY - listTouchStartY) > CARD_TAP_MOVE_THRESHOLD_PX) {
    listTouchMoved = true;
    clearLongPressTimer();
  }
}

function handleListTouchEnd(e) {
  const wasLongPress = longPressTriggered;
  const touchDurationMs = touchPressStartedAt
    ? Date.now() - touchPressStartedAt
    : Number.POSITIVE_INFINITY;
  touchPressStartedAt = 0;
  clearLongPressTimer();
  longPressTriggered = false;

  if (wasLongPress) {
    ignoreClickUntil = Date.now() + SYNTHETIC_CLICK_GUARD_MS;
    return;
  }

  if (listTouchMoved) return;
  if (touchDurationMs > CARD_QUICK_TAP_MAX_MS) return;

  const target = e.target;
  const popover = document.getElementById("copyPopover");

  if (
    popover &&
    !popover.hidden &&
    !target.closest("#copyPopover") &&
    target.closest(".item")
  ) {
    closeCopyPopover();
    ignoreClickUntil = Date.now() + SYNTHETIC_CLICK_GUARD_MS;
    return;
  }

  if (!target.closest(".item-main")) return;
  if (target.id === "loadMoreBtn") return;
  if (target.closest(".qty-box")) return;
  if (target.closest(".qty-input")) return;
  if (target.closest(".qty-btn")) return;

  const itemEl = target.closest(".item");
  if (!itemEl) return;

  const id = itemEl.dataset.id;
  if (!id) return;

  const item = state.itemsById.get(id);
  if (!item) return;

  closeCopyPopover();
  changeQty(id, 1);
  ignoreClickUntil = Date.now() + SYNTHETIC_CLICK_GUARD_MS;
}

function handleListTouchCancel() {
  touchPressStartedAt = 0;
  clearLongPressState();
}

function handleListMouseDown(e) {
  if (e.button !== 0) return;

  const pressTarget = getPressableItemFromTarget(e.target);
  if (!pressTarget || !canEdit()) {
    clearMousePressState();
    return;
  }

  mousePressActive = true;
  mousePressStartX = e.clientX;
  mousePressStartY = e.clientY;
  mousePressStartedAt = Date.now();
  lastMousePressItemId = pressTarget.item.id;
  lastMousePressDurationMs = Number.POSITIVE_INFINITY;
  longPressTriggered = false;
  startLongPress(pressTarget.itemEl, pressTarget.item);
}

function handleListMouseMove(e) {
  if (!mousePressActive) return;

  const movedX = Math.abs(e.clientX - mousePressStartX);
  const movedY = Math.abs(e.clientY - mousePressStartY);
  if (
    movedX > CARD_TAP_MOVE_THRESHOLD_PX ||
    movedY > CARD_TAP_MOVE_THRESHOLD_PX
  ) {
    clearMousePressState();
  }
}

function handleListMouseUp() {
  if (!mousePressActive) return;

  const wasLongPress = longPressTriggered;
  lastMousePressDurationMs = mousePressStartedAt
    ? Date.now() - mousePressStartedAt
    : Number.POSITIVE_INFINITY;
  clearMousePressState();

  if (wasLongPress) {
    ignoreClickUntil = Date.now() + SYNTHETIC_CLICK_GUARD_MS;
  }
}

function handleListMouseLeave() {
  clearMousePressState();
}

function startLongPress(itemEl, item) {
  clearLongPressTimer();

  longPressTimerId = window.setTimeout(() => {
    longPressTriggered = true;
    openCopyPopover(itemEl, item);
  }, CARD_LONG_PRESS_MS);
}

function clearLongPressTimer() {
  if (longPressTimerId) {
    clearTimeout(longPressTimerId);
    longPressTimerId = 0;
  }
}

function clearLongPressState() {
  clearLongPressTimer();
  longPressTriggered = false;
}

function clearMousePressState() {
  mousePressActive = false;
  mousePressStartX = 0;
  mousePressStartY = 0;
  mousePressStartedAt = 0;
  clearLongPressTimer();
}

function getPressableItemFromTarget(target) {
  if (
    !target ||
    !target.closest(".item-main") ||
    target.closest(".qty-box") ||
    target.closest(".qty-input") ||
    target.closest(".qty-btn")
  ) {
    return null;
  }

  const itemEl = target.closest(".item");
  const id = itemEl?.dataset.id || "";
  const item = id ? state.itemsById.get(id) : null;

  if (!itemEl || !item) return null;
  return { itemEl, item };
}

function handleDocumentClickForCopyPopover(e) {
  const popover = document.getElementById("copyPopover");
  if (!popover || popover.hidden) return;

  if (e.target.closest("#copyPopover")) return;
  if (e.target.closest(".item-main")) return;
  closeCopyPopover();
}

function openCopyPopover(itemEl, item) {
  const popover = document.getElementById("copyPopover");
  const editBtn = document.getElementById("editCustomItemBtn");
  if (!popover || !itemEl || !item) return;

  state.activeCopyPopoverItemId = item.id;
  state.copySourceItemId = item.id;
  popover.classList.toggle("has-multiple-actions", Boolean(item.isCustom));
  if (editBtn) {
    editBtn.hidden = !item.isCustom;
  }
  popover.hidden = false;
  popover.setAttribute("aria-hidden", "false");

  requestAnimationFrame(() => {
    positionCopyPopover(itemEl, popover);
  });
}

function positionCopyPopover(itemEl, popover) {
  if (!itemEl || !popover || popover.hidden) return;

  const anchorEl = itemEl.querySelector(".item-main") || itemEl;
  const rect = anchorEl.getBoundingClientRect();
  const margin = 12;
  const popoverRect = popover.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = rect.left + 8;
  if (left + popoverRect.width > viewportWidth - margin) {
    left = viewportWidth - popoverRect.width - margin;
  }
  left = Math.max(margin, left);

  const needsAbove =
    viewportHeight - rect.bottom < popoverRect.height + 12 &&
    rect.top > popoverRect.height + 12;
  let top = needsAbove ? rect.top - popoverRect.height - 6 : rect.bottom + 6;
  top = Math.max(margin, top);
  top = Math.min(top, viewportHeight - popoverRect.height - margin);

  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

function closeCopyPopover() {
  const popover = document.getElementById("copyPopover");
  const editBtn = document.getElementById("editCustomItemBtn");

  state.activeCopyPopoverItemId = "";
  state.copySourceItemId = "";
  if (editBtn) {
    editBtn.hidden = true;
  }

  if (!popover) return;

  popover.classList.remove("has-multiple-actions");
  popover.hidden = true;
  popover.setAttribute("aria-hidden", "true");
  popover.style.left = "";
  popover.style.top = "";
}

function handleCopyFromItem() {
  const item = state.itemsById.get(state.copySourceItemId);
  closeCopyPopover();

  if (!item || !canEdit()) return;
  openCustomItemDialogForCreate(item);
}

function handleEditCustomItemFromPopover() {
  const item = state.itemsById.get(state.activeCopyPopoverItemId);
  closeCopyPopover();

  if (!item?.isCustom || !canEdit()) return;
  openCustomItemDialogForEdit(item);
}

function handleQtyInputFocusIn(e) {
  const input = e.target.closest(".qty-input");
  if (!input) return;

  selectInputValueOnFocus({ target: input });
}

function selectInputValueOnFocus(e) {
  const input = e?.target;
  if (!input || typeof input.select !== "function") return;

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

function openModal(id) {
  const dialog = document.getElementById(id);
  if (!dialog || dialog.open) return;
  dialog.showModal();
  syncBodyScrollLock();
}

function closeModal(id) {
  const dialog = document.getElementById(id);
  if (!dialog || !dialog.open) return;
  dialog.close();
  syncBodyScrollLock();
}

function attachDialogBackdropClose(id) {
  const dialog = document.getElementById(id);
  if (!dialog) return;

  dialog.addEventListener("close", syncBodyScrollLock);
  dialog.addEventListener("cancel", syncBodyScrollLock);
}

function syncBodyScrollLock() {
  const hasOpenDialog = Array.from(document.querySelectorAll("dialog")).some(
    (dialog) => dialog.open,
  );

  if (hasOpenDialog) {
    if (!document.body.classList.contains("modal-open")) {
      lockedBodyScrollY = window.scrollY || window.pageYOffset || 0;
      document.body.style.top = `-${lockedBodyScrollY}px`;
    }
    document.body.classList.add("modal-open");
    return;
  }

  if (document.body.classList.contains("modal-open")) {
    document.body.classList.remove("modal-open");
    document.body.style.top = "";
    window.scrollTo(0, lockedBodyScrollY);
    lockedBodyScrollY = 0;
  }
}

function downloadBackupFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body?.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

async function exportJsonBackup() {
  const data = {
    token: state.token,
    room: state.roomKey,
    roomLabel: state.roomLabel,
    exportedAt: new Date().toISOString(),
    items: state.items.filter((it) => it.qty > 0 || it.isCustom),
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8",
  });

  const filename = `inventory_${state.roomKey || "unknown"}_${new Date().getTime()}.json`;

  try {
    if (navigator.share && typeof File === "function") {
      const file = new File([blob], filename, { type: "application/json" });
      const shareData = {
        title: filename,
        text: "inventory backup",
        files: [file],
      };

      if (!navigator.canShare || navigator.canShare(shareData)) {
        await navigator.share(shareData);
        setInfoMessage("バックアップを共有シートに渡しました。");
        return;
      }
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      setInfoMessage("バックアップ共有をキャンセルしました。");
      return;
    }
    console.warn(
      "バックアップ共有に失敗したためファイル保存へ切り替えます:",
      err,
    );
  }

  downloadBackupFile(blob, filename);
  setInfoMessage("バックアップファイルを保存しました。");
}

function exportCsv() {
  const exportItems = state.items.filter((item) => item.qty > 0);
  const headers = [
    "マスタ区分",
    "商品コード",
    "教材名",
    "教科",
    "出版社",
    "部数",
  ];

  const rows = exportItems.map((item) => [
    item.category,
    item.isCustom ? "（未登録教材）" : item.id,
    getDisplayItemName(item),
    item.subject,
    item.publisher,
    item.qty,
  ]);

  const csv = [headers, ...rows]
    .map((row) => row.map(escapeCsvCell).join(","))
    .join("\r\n");

  const blob = new Blob(["\uFEFF", csv], {
    type: "text/csv;charset=utf-8;",
  });

  downloadBackupFile(
    blob,
    `inventory_${state.roomKey || "unknown"}_${new Date().getTime()}.csv`,
  );

  setInfoMessage(`CSVを出力しました (${exportItems.length}件)`);
}

function escapeCsvCell(value) {
  const text = value == null ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
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
            target.edition,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
        } else if (importedItem.isCustom) {
          pushNewDirtyItemToState(
            normalizeItem({
              id: importedId,
              name: importedItem.name || "名称未設定",
              category: importedItem.category || "未登録教材",
              subject: importedItem.subject || "",
              publisher: importedItem.publisher || "",
              edition: importedItem.edition || "",
              qty: Number(importedItem.qty) || 0,
              isCustom: true,
            }),
          );
        }
      });

      generateCategoryChips();
      syncInputOnlyToggleUI();
      applyFilterAndRender();
      updateStatsUI();
      scheduleAutoSave();
      alert("読み込みが完了しました。");
    } catch (err) {
      alert("ファイルの読み込みに失敗しました: " + err.message);
    }
  };

  reader.readAsText(file);
  e.target.value = "";
}

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

function setCustomDialogMode(mode, item = null) {
  state.customDialogMode = mode;
  state.editingCustomItemId = mode === "edit" && item ? item.id : "";

  const titleEl = document.querySelector("#customItemDialog .modal-title");
  const saveBtn = document.getElementById("saveCustomBtn");
  const deleteBtn = document.getElementById("deleteCustomBtn");

  if (titleEl) {
    if (mode === "edit") {
      titleEl.textContent = "未登録教材を編集";
    } else {
      titleEl.textContent = "未登録教材を追加";
    }
  }

  if (saveBtn) {
    saveBtn.textContent = mode === "edit" ? "保存する" : "追加する";
  }

  if (deleteBtn) {
    deleteBtn.hidden = mode !== "edit";
  }
}

function fillCustomItemForm(item = null) {
  const nameInput = document.getElementById("customName");
  const publisherInput = document.getElementById("customPublisher");
  const editionInput = document.getElementById("customEdition");
  const qtyInput = document.getElementById("customQtyInput");

  if (nameInput) nameInput.value = item?.name || "";
  if (publisherInput) publisherInput.value = item?.publisher || "";
  if (editionInput) editionInput.value = item?.edition || "";
  if (qtyInput) {
    qtyInput.value =
      state.customDialogMode === "edit" && item
        ? String(Number(item.qty) || 0)
        : "0";
  }
}

function openCustomItemDialogForCreate(sourceItem = null) {
  setCustomDialogMode("create");
  state.copySourceItemId = sourceItem?.id || "";
  fillCustomItemForm(sourceItem);
  openModal("customItemDialog");
}

function openCustomItemDialogForEdit(item) {
  if (!item?.isCustom || !canEdit()) return;
  state.copySourceItemId = "";
  setCustomDialogMode("edit", item);
  fillCustomItemForm(item);
  openModal("customItemDialog");
}

function removeItemFromState(itemId) {
  state.items = state.items.filter((item) => item.id !== itemId);
  state.itemsById.delete(itemId);
  delete state.originalSnapshotMap[itemId];
  delete state.originalUpdatedAtMap[itemId];
}

async function deleteCustomItem(item) {
  if (!item?.isCustom || !canEdit()) return;

  const confirmed = confirm("この未登録教材を削除しますか？");
  if (!confirmed) return;

  const originalSnapshot = state.originalSnapshotMap[item.id];
  if (originalSnapshot && originalSnapshot !== "__NEW_ITEM__") {
    state.deletedItemIds.add(item.id);
    state.deletedItemMetaMap[item.id] = {
      name: getDisplayItemName(item),
      updatedAtKey: state.originalUpdatedAtMap[item.id] || "",
    };
  }

  removeItemFromState(item.id);
  generateCategoryChips();
  syncInputOnlyToggleUI();
  applyFilterAndRender();
  updateStatsUI();
  scheduleAutoSave();
}

function handleDeleteCustomItem() {
  const item = state.itemsById.get(state.editingCustomItemId);
  if (!item) return;
  closeModal("customItemDialog");
  void deleteCustomItem(item);
}

function openInputtedItemsDialog() {
  renderInputtedItemsDialog();
  openModal("inputtedItemsDialog");
}

function renderInputtedItemsDialog() {
  const summaryEl = document.getElementById("inputtedItemsSummary");
  const listEl = document.getElementById("inputtedItemsList");

  if (!summaryEl || !listEl) return;

  const inputtedItems = state.items.filter((item) => item.qty > 0);
  const hasCustom = inputtedItems.some((item) => item.isCustom && item.qty > 0);

  summaryEl.innerHTML = `
    <div class="review-summarybar">
      <span>全${inputtedItems.length}件 / 合計 ${inputtedItems.reduce((sum, item) => sum + item.qty, 0)}冊</span>
    </div>
  `;

  if (inputtedItems.length === 0) {
    listEl.innerHTML = `<div class="empty">入力済みの教材はまだありません。</div>`;
    return;
  }

  const renderRows = (items) =>
    items
      .map((item) => {
        const displayName = getDisplayItemName(item);
        const publisherText = item.publisher
          ? escapeHtml(item.publisher)
          : `<span class="review-cell-meta-empty">（未入力）</span>`;

        return `
        <div class="review-row">
          <div class="review-cell review-cell-mark">${item.isCustom ? "＊" : ""}</div>
          <div class="review-cell review-cell-name">
            <div class="review-cell-title">${escapeHtml(displayName)}</div>
          </div>
          <div class="review-cell review-cell-meta">${publisherText}</div>
          <div class="review-row-qty num">${item.qty}</div>
        </div>
      `;
      })
      .join("");

  const renderTable = (items) => `
    <div class="review-table-wrapper">
      <div class="review-table">
        <div class="review-head">
          <div class="review-head-cell review-cell-mark"></div>
          <div class="review-head-cell review-cell-name">教材名</div>
          <div class="review-head-cell review-cell-meta">出版社</div>
          <div class="review-head-cell review-head-cell-qty">冊数</div>
        </div>
        <div class="review-body">
          ${renderRows(items)}
        </div>
      </div>

      ${
        hasCustom
          ? `<div class="review-table-note">
              <span class="mark">＊</span>…未登録教材
            </div>`
          : ""
      }
    </div>
  `;

  listEl.innerHTML = renderTable(inputtedItems);
}

function handleCustomItemSubmit(e) {
  e.preventDefault();
  if (!canEdit()) return;

  const name = document.getElementById("customName")?.value.trim() || "";
  const category = "未登録教材";
  const publisher =
    document.getElementById("customPublisher")?.value.trim() || "";
  const edition = document.getElementById("customEdition")?.value.trim() || "";

  const qtyEl = document.getElementById("customQtyInput");
  const qty = parseInt(qtyEl?.value || "0", 10) || 0;

  if (!name) {
    alert("教材名を入力してください。");
    return;
  }

  const sourceItem = state.itemsById.get(state.copySourceItemId);
  if (
    state.customDialogMode === "create" &&
    sourceItem &&
    normalizeQuotedField(name) === normalizeQuotedField(sourceItem.name) &&
    normalizeQuotedField(edition) === normalizeQuotedField(sourceItem.edition)
  ) {
    alert("教材名または版・準拠を変更してください。");
    return;
  }

  if (state.customDialogMode === "edit" && state.editingCustomItemId) {
    const target = state.itemsById.get(state.editingCustomItemId);
    if (!target) return;
    target.name = name;
    target.publisher = publisher;
    target.edition = edition;
    target.qty = qty;
    target.searchTag = [
      target.name,
      target.category,
      target.subject,
      target.publisher,
      target.edition,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  } else {
    const id = "custom_" + Date.now();

    const newItem = normalizeItem({
      id,
      name,
      category,
      subject: "",
      publisher,
      edition,
      qty,
      isCustom: true,
    });

    pushNewDirtyItemToState(newItem);
  }

  e.target.reset();

  const qtyInput = document.getElementById("customQtyInput");
  if (qtyInput) qtyInput.value = "0";

  state.copySourceItemId = "";
  closeModal("customItemDialog");
  setCustomDialogMode("create");

  generateCategoryChips();
  syncInputOnlyToggleUI();
  applyFilterAndRender();
  updateStatsUI();
  scheduleAutoSave();
}

function normalizeQuotedField(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}
