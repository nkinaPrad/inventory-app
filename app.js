/**
 * ====================================================================
 * 教材在庫管理システム - data.js マスタ利用版 (app.js)
 * * 【システム概要】
 * 1. 起動時: URLパラメータのtokenを元に、Firestoreから校舎情報と在庫データを取得。
 * 2. マスタ管理: data.jsのMASTER_DATAと、Firestore側の実在庫をIDで紐付け。
 * 3. 未登録教材: マスタにない教材は "custom_" IDで個別管理。
 * 4. 保存: 編集後5秒の自動保存、または手動保存。変更があったアイテムのみ送信。
 * 5. オフライン対策: JSONファイルへの書き出し・読み込み機能を搭載。
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
// 校舎キーと表示名のマッピング
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

// 動作パラメータ
const SEARCH_DEBOUNCE_MS = 120; // 検索入力の待機時間
const INITIAL_VISIBLE_COUNT = 30; // 初期表示件数
const LOAD_MORE_COUNT = 30;      // 「さらに表示」で追加する件数
const AUTO_SAVE_DELAY_MS = 5000; // 自動保存実行までの遅延(5秒)

// UI表示メッセージ定義
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
 * アプリ全体で共有する動的なデータ
 */
const state = {
  token: "",              // FirestoreのドキュメントID
  roomKey: "",            // 校舎識別子 (takadanobaba等)
  roomLabel: "",          // 表示用校舎名
  items: [],              // 全教材データの配列
  itemsById: new Map(),   // ID検索用のMap
  filteredItems: [],      // 検索・フィルタ適用後の配列
  activeFilter: "all",    // 現在選択中のカテゴリ
  query: "",              // 検索窓の入力文字列
  isSyncing: false,       // 保存処理中フラグ
  totalQty: 0,            // 合計在庫数
  dirtyCount: 0,          // 未保存の変更があるアイテム数
  originalSnapshotMap: Object.create(null), // 変更検知用の比較用データ
  visibleCount: INITIAL_VISIBLE_COUNT,      // 現在の表示件数上限
  autoSaveTimerId: null,  // setTimeoutのリファレンス
  autoSaveSuspended: false, // エラー等による自動保存一時停止フラグ
  hasShownRetryNotice: false, // リトライ通知表示済みフラグ
  isLocalPreview: false,   // ローカル実行環境かどうかの判定
  accessReady: false,      // トークン確認完了フラグ
  accessGranted: false,    // 書き込み権限確認フラグ
  tokenDocExists: false,   // トークン自体の存在有無
  tokenDocData: null       // トークンドキュメントの内容
};

/**
 * =========================
 * 起動処理 (EntryPoint)
 * =========================
 */
document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(location.search);
  state.token = (params.get("token") || "").trim();

  // 実行環境の判定（開発時やローカル確認用）
  state.isLocalPreview = (
    location.protocol === "file:" ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1"
  );

  initUI(); // イベントリスナー等の初期化

  // トークンがない場合の処理
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

  // ローカル環境での動作
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

  // オンライン環境での正規アクセス確認
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

  // 校舎名の初期表示
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

  // 検索入力 (Debounce処理付き)
  searchInput?.addEventListener("input", debounce((e) => {
    state.query = String(e.target.value || "").trim().toLowerCase();
    state.visibleCount = INITIAL_VISIBLE_COUNT;
    applyFilterAndRender();
  }, SEARCH_DEBOUNCE_MS));

  // カテゴリチップのクリック
  filterArea?.addEventListener("click", (e) => {
    const chip = e.target.closest(".f-chip");
    if (!chip || chip.dataset.filter === state.activeFilter) return;

    document.querySelectorAll(".f-chip").forEach((el) => el.classList.remove("active"));
    chip.classList.add("active");
    state.activeFilter = chip.dataset.filter;
    state.visibleCount = INITIAL_VISIBLE_COUNT;
    applyFilterAndRender();
  });

  // リスト内クリック（数量変更、もっと見る）
  list?.addEventListener("click", handleListClick);

  // 保存ボタン
  sendBtn?.addEventListener("click", () => {
    if (!canEdit()) {
      setErrorMessage(ERROR_MESSAGES.SAVE_NOT_ALLOWED);
      return;
    }
    void sendData({ silent: false, isManualRetry: true });
  });

  // メニュー・ダイアログ操作
  document.getElementById("toolMenuBtn")?.addEventListener("click", () => openModal("toolMenuDialog"));
  document.getElementById("closeToolMenuBtn")?.addEventListener("click", () => closeModal("toolMenuDialog"));

  // 未登録教材追加
  document.getElementById("toolMenuBtnAddCustom")?.addEventListener("click", () => {
    if (!canEdit()) {
      setErrorMessage(ERROR_MESSAGES.ADD_CUSTOM_NOT_ALLOWED);
      return;
    }
    closeModal("toolMenuDialog");
    openModal("customItemDialog");
  });

  // 未登録教材ダイアログ内の数量ボタン
  document.getElementById("customQtyMinus")?.addEventListener("click", () => changeCustomQty(-1));
  document.getElementById("customQtyPlus")?.addEventListener("click", () => changeCustomQty(1));
  document.getElementById("customItemForm")?.addEventListener("submit", handleCustomItemSubmit);
  document.getElementById("cancelCustomBtn")?.addEventListener("click", () => closeModal("customItemDialog"));

  // JSONエクスポート・インポート
  document.getElementById("exportJsonBtn")?.addEventListener("click", () => {
    closeModal("toolMenuDialog");
    exportJsonBackup();
  });

  document.getElementById("importJsonBtn")?.addEventListener("click", () => {
    closeModal("toolMenuDialog");
    document.getElementById("importFileInput")?.click();
  });

  document.getElementById("importFileInput")?.addEventListener("change", importJsonBackup);

  // ダイアログの外側クリックで閉じる設定
  attachDialogBackdropClose("toolMenuDialog");
  attachDialogBackdropClose("customItemDialog");
}

/**
 * =========================
 * メッセージ表示関連ユーティリティ
 * =========================
 */

// 時刻フォーマット (HH:mm:ss)
function formatNow() {
  return new Date().toLocaleString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

// FirestoreのTimestampを文字列に変換
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

// 情報メッセージの表示更新
function setInfoMessage(message, withTimestamp = true) {
  const el = document.getElementById("infoMessage");
  if (!el) return;
  el.textContent = withTimestamp ? `${message} (${formatNow()})` : message;
}

// エラーメッセージの表示更新
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

    // 1. tokenドキュメントの存在確認
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

    // 2. 有効化状態や校舎名の取得
    const tokenData = tokenSnap.data() || {};
    state.tokenDocData = tokenData;

    state.roomKey = String(tokenData.roomKey || "").trim().toLowerCase();
    state.roomLabel = String(tokenData.roomLabel || ROOM_LABEL_MAP[state.roomKey] || "").trim();
    updateRoomLabel();

    // 無効なURL（enabledフラグがfalse）の場合
    if (tokenData.enabled !== true) {
      setReadOnlyMode(true);
      state.accessGranted = false;
      setErrorMessage(ERROR_MESSAGES.DISABLED_URL);
      renderEmptyMessage(ERROR_MESSAGES.DISABLED_URL);
      updateStatsUI();
      return;
    }

    // アクセス許可
    state.accessGranted = true;
    setReadOnlyMode(false);
    clearErrorMessage();

    // 3. 実際の在庫データの読み込みへ
    await loadAppData();
  } catch (err) {
    console.error("アクセス確認失敗:", err);
    setReadOnlyMode(true);
    setErrorMessage(ERROR_MESSAGES.ACCESS_CHECK_FAILED);
    renderEmptyMessage(ERROR_MESSAGES.ACCESS_CHECK_FAILED);
    updateStatsUI();
  }
}

// 校舎表示ラベルの更新
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

// 編集・保存が可能かどうかを判定
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
    // マスタ(data.js)と実在庫(Firestore)を並列で取得
    const [masterData, inventoryMap] = await Promise.all([
      Promise.resolve(getFallbackMasterData()),
      loadInventoryFromFirestore(state.token)
    ]);

    // 取得データから最新の更新日時を特定
    const latestUpdatedAt = getLatestUpdatedAt(inventoryMap);

    // データをマージしてアプリケーション状態を構築
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

// 在庫データの中から最も新しい updatedAt を探す
function getLatestUpdatedAt(inventoryMap) {
  let latest = null;

  inventoryMap.forEach((data) => {
    if (!data?.updatedAt) return;
    const ts = data.updatedAt;
    if (!latest || ts.seconds > latest.seconds || (ts.seconds === latest.seconds && ts.nanoseconds > latest.nanoseconds)) {
      latest = ts;
    }
  });

  return latest;
}

// Firestoreの items サブコレクションから全ドキュメントを取得
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

// グローバル変数 MASTER_DATA の存在チェック
function getFallbackMasterData() {
  if (typeof MASTER_DATA !== 'undefined' && Array.isArray(MASTER_DATA)) {
    return MASTER_DATA;
  }
  return [];
}

/**
 * マスタと在庫データを突合し、state.itemsを組み立てる
 */
function buildStateFromSources(masterData, inventoryMap) {
  state.items = [];
  state.itemsById = new Map();
  state.originalSnapshotMap = Object.create(null);
  state.totalQty = 0;
  state.dirtyCount = 0;
  state.autoSaveSuspended = false;
  state.hasShownRetryNotice = false;
  state.visibleCount = INITIAL_VISIBLE_COUNT;

  // 1. マスタデータにある教材を処理
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
    inventoryMap.delete(id); // 処理済みはMapから削除
  });

  // 2. マスタにないがFirestoreに保存されている教材（未登録教材）を処理
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

// アイテムを状態管理に追加し、比較用のスナップショットを保存
function pushItemToState(item) {
  state.items.push(item);
  state.itemsById.set(item.id, item);
  state.originalSnapshotMap[item.id] = snapshotKey(item);
}

// 新規追加アイテム用（比較用データをダミーにして「変更あり」と判定させる）
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

  // 変更があるアイテム（現在の状態とスナップショットが不一致なもの）を抽出
  const dirtyItems = state.items.filter(
    (item) => snapshotKey(item) !== state.originalSnapshotMap[item.id]
  );

  // 変更がなければ終了
  if (dirtyItems.length === 0) {
    if (!silent) {
      clearErrorMessage();
      setInfoMessage(INFO_MESSAGES.NO_CHANGES);
    }
    return true;
  }

  // 自動保存が停止している場合は、手動リトライ以外は受け付けない
  if (!isManualRetry && state.autoSaveSuspended) {
    return false;
  }

  state.isSyncing = true;
  updateStatsUI();
  clearErrorMessage();
  setInfoMessage(silent ? INFO_MESSAGES.AUTO_SAVING : INFO_MESSAGES.MANUAL_SAVING);

  try {
    // 変更があった各アイテムをループで保存
    for (const item of dirtyItems) {
      const ref = doc(db, "inventory", state.token, "items", item.id);

      // 保存するオブジェクトの構築
      const payload = item.isCustom
        ? {
            // 未登録教材は全ての情報を保存
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
            // 通常教材は数量と管理フラグのみ保存
            qty: item.qty,
            isCustom: false,
            updatedAt: serverTimestamp()
          };

      // Firestoreに書き込み
      await setDoc(ref, payload, { merge: true });

      // 保存成功したら、スナップショットを更新して「変更なし」状態に戻す
      state.originalSnapshotMap[item.id] = snapshotKey(item);
      item.__dirty = false;
    }

    // 全保存成功後のクリーンアップ
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

    // ユーザーへのエラー通知
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

/**
 * 変更があった際に、数秒後に自動保存が走るよう予約する
 */
function scheduleAutoSave() {
  if (!canEdit()) return;

  clearAutoSaveTimer();

  if (state.dirtyCount === 0) return;

  // すでに保存エラーが起きている場合は、自動保存はさせず手動保存を促す
  if (state.autoSaveSuspended) {
    setErrorMessage(ERROR_MESSAGES.AUTO_SAVE_RETRY);
    return;
  }

  clearErrorMessage();
  setInfoMessage(INFO_MESSAGES.EDITING);
  
  // 5秒後に sendData を実行
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

/**
 * 全アイテムのカテゴリを抽出して、フィルタ用ボタンを生成する
 */
function generateCategoryChips() {
  const container = document.getElementById("filterArea");
  if (!container) return;

  const categories = Array.from(
    new Set(state.items.map((item) => item.category).filter(Boolean))
  );

  const isActive = (key) => (state.activeFilter === key ? " active" : "");
  
  // 基本的な固定フィルタ
  let html = `<button type="button" class="f-chip${isActive("custom")} chip-custom" data-filter="custom">未登録</button>`;
  html += `<button type="button" class="f-chip${isActive("input")} chip-input" data-filter="input">入力済み</button>`;
  html += `<button type="button" class="f-chip${isActive("all")} chip-all" data-filter="all">すべて</button>`;

  // マスタから抽出したカテゴリ
  categories
    .filter((c) => c && c !== "未登録教材")
    .forEach((c) => {
      html += `<button type="button" class="f-chip${isActive(c)}" data-filter="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
    });

  container.innerHTML = html;
}

/**
 * 現在の検索クエリと選択中フィルタに基づいてリストをフィルタリングする
 */
function applyFilterAndRender() {
  const q = state.query;
  const filter = state.activeFilter;

  state.filteredItems = state.items.filter((item) => {
    // 検索語のチェック
    const matchesQuery = !q || item.searchTag.includes(q);
    if (!matchesQuery) return false;

    // フィルタの適用
    if (filter === "custom") return item.isCustom;
    if (item.isCustom) return false; // 以下のカテゴリフィルタは通常教材のみ対象

    if (filter === "input") return item.qty > 0;
    if (filter === "all") return true;
    return item.category === filter;
  });

  renderFilteredItems();
}

/**
 * フィルタ後の配列を実際にHTMLとしてレンダリングする
 */
function renderFilteredItems() {
  const container = document.getElementById("list");
  if (!container) return;

  if (state.filteredItems.length === 0) {
    container.innerHTML = `<div class="empty">該当する教材がありません。</div>`;
    return;
  }

  // 表示件数分だけ切り出す（無限スクロール的な実装）
  const visibleItems = state.filteredItems.slice(0, state.visibleCount);
  let html = visibleItems.map((item) => renderItemHTML(item)).join("");

  // まだ表示しきれていない分があれば「さらに表示」ボタンを出す
  if (state.filteredItems.length > state.visibleCount) {
    const remain = state.filteredItems.length - state.visibleCount;
    html += `
      <div class="empty" style="padding:24px 16px;">
        <button id="loadMoreBtn" type="button" class="btn-subtle">さらに表示（あと${remain}件）</button>
      </div>`;
  }

  container.innerHTML = html;
}

/**
 * 個別教材のHTMLを生成
 */
function renderItemHTML(item) {
  const topMeta = [item.publisher, item.edition].filter(Boolean).join(" / ");
  return `
    <article class="item ${item.qty > 0 ? "has-qty" : ""} ${item.isCustom && hasQty ? "custom-item" : ""}" data-id="${escapeHtml(item.id)}">
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

/**
 * 短時間に何度も実行されないように間引く関数
 */
function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

/**
 * 教材オブジェクトのプロパティを整え、検索用タグを生成する
 */
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

  // 全ての属性を小文字で結合して検索しやすくする
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
 * 変更検知用のユニークな文字列を作成
 * 通常教材は数量さえ合っていれば変更なしとみなす
 * 未登録教材は名前なども編集される可能性があるため全て含める
 */
function snapshotKey(item) {
  if (item.isCustom) {
    return `${item.id}_${item.qty}_${item.name}_${item.publisher}_${item.edition}_${item.category}_${item.subject}_1`;
  }
  return `${item.id}_${item.qty}_0`;
}

/**
 * HTMLエスケープ（XSS脆弱性対策）
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

/**
 * 読み取り専用モード（保存不可な状態）のUI切り替え
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
 * 合計在庫数と未保存件数の再計算
 */
function recalcTotalQty() {
  state.totalQty = state.items.reduce((sum, item) => sum + item.qty, 0);
  state.dirtyCount = state.items.filter(
    (item) => snapshotKey(item) !== state.originalSnapshotMap[item.id]
  ).length;
}

/**
 * 合計在庫数などを画面のバッジ等に反映
 */
function updateStatsUI() {
  recalcTotalQty();

  const totalQtyEl = document.getElementById("totalQty");
  const dirtyCountEl = document.getElementById("dirtyCount");
  const sendBtn = document.getElementById("sendBtn");

  if (totalQtyEl) totalQtyEl.textContent = state.totalQty;

  // 未保存件数の表示
  if (dirtyCountEl) {
    dirtyCountEl.textContent = state.dirtyCount > 0 ? `(未保存: ${state.dirtyCount})` : "";
  }

  // 保存ボタンの色などを変更
  if (sendBtn) {
    sendBtn.classList.toggle("dirty", state.dirtyCount > 0);
  }
}

/**
 * リスト部分のクリックイベントを集約して処理
 */
function handleListClick(e) {
  const target = e.target;

  // もっと見るボタン
  if (target.id === "loadMoreBtn") {
    state.visibleCount += LOAD_MORE_COUNT;
    renderFilteredItems();
    return;
  }

  // 各教材のプラスマイナスボタン
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
 * 数量の増減処理
 */
function changeQty(id, diff) {
  const item = state.itemsById.get(id);
  if (!item || !canEdit()) return;

  const newQty = Math.max(0, item.qty + diff);
  if (newQty === item.qty) return;

  item.qty = newQty;

  // 画面の数字部分を直接書き換える（再描画せず高速化）
  const itemEl = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
  if (itemEl) {
    const numEl = itemEl.querySelector(".qty-num");
    if (numEl) numEl.textContent = item.qty;
    itemEl.classList.toggle("has-qty", item.qty > 0);
    itemEl.classList.toggle("custom-item", item.isCustom && item.qty > 0);
  }

  updateStatsUI();
  scheduleAutoSave(); // 自動保存を予約
}

/**
 * ダイアログ制御関連
 */
function openModal(id) {
  const dialog = document.getElementById(id);
  if (dialog) dialog.showModal();
}

function closeModal(id) {
  const dialog = document.getElementById(id);
  if (dialog) dialog.close();
}

// モーダルの背景をクリックした時に閉じる
function attachDialogBackdropClose(id) {
  const dialog = document.getElementById(id);
  if (!dialog) return;
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}

/**
 * 現時点での入力データをJSON形式でファイル保存する
 * (ネットワーク不良時のバックアップ用)
 */
function exportJsonBackup() {
  const data = {
    token: state.token,
    room: state.roomKey,
    roomLabel: state.roomLabel,
    exportedAt: new Date().toISOString(),
    // 在庫があるもの、もしくは未登録教材をエクスポート対象にする
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
 * 保存されたJSONファイルからデータを復元する
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
        const importedId = String(importedItem.id || "").trim();
        if (!importedId) return;

        const target = state.itemsById.get(importedId);

        if (target) {
          // マスタに存在する教材は数量のみ更新
          target.qty = Number(importedItem.qty) || 0;

          if (target.isCustom) {
            // 未登録教材の場合は付随情報も更新
            target.name = importedItem.name || target.name;
            target.category = importedItem.category || target.category;
            target.subject = importedItem.subject || target.subject;
            target.publisher = importedItem.publisher || target.publisher;
            target.edition = importedItem.edition || target.edition;
          }

          // 検索タグの再構築
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
            // 現在のリストにない未登録教材があれば追加
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

      // 読み込み後の画面反映
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
  e.target.value = ""; // 同じファイルを再度選べるようにリセット
}

/**
 * 未登録教材ダイアログ内の数量入力値を変更する
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
 * 未登録教材登録フォームの送信処理
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

  // 重複しないIDを生成
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

  // 状態に追加（まだFirestoreには送られていない）
  pushNewDirtyItemToState(newItem);

  // フォームのリセット
  e.target.reset();

  const qtyInput = document.getElementById("customQtyInput");
  if (qtyInput) qtyInput.value = "0";

  const qtyValue = document.getElementById("customQtyValue");
  if (qtyValue) qtyValue.textContent = "0";

  closeModal("customItemDialog");

  // 画面更新と保存予約
  generateCategoryChips();
  applyFilterAndRender();
  updateStatsUI();
  scheduleAutoSave();
}