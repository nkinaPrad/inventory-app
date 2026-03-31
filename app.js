/**
 * ====================================================================
 * 教材在庫管理システム - フロントエンド・スクリプト
 * HTML変更版対応 / 初期表示30件 / 詳細コメント版
 * ====================================================================
 */

/**
 * =========================
 * 設定・定数
 * =========================
 */
// データを保存・取得するGoogle Apps ScriptのURL
const GAS_URL = "https://script.google.com/macros/s/AKfycbz0HdzSg-7ABwypga37Fb0sn7EYDb0CtJ7o83wXEEHjRAVKspAtqT1FNgHiGq89Sj5DrA/exec";

// URLパラメータ(?room=...)と表示名の対応表
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

const SEARCH_DEBOUNCE_MS = 120; // 検索時の入力待ち時間（負荷軽減）
const INITIAL_VISIBLE_COUNT = 30; // 最初に見せる件数
const LOAD_MORE_COUNT = 30;    // 「さらに表示」で増える件数

/**
 * アプリケーション状態（メモリ上で保持する最新データ）
 */
const state = {
  roomKey: "",            // 校舎キー（例: takadanobaba）
  roomLabel: "",          // 校舎名（例: 高田馬場）
  items: [],              // すべての教材データ
  itemsById: new Map(),   // IDからデータを即座に引くための辞書
  filteredItems: [],      // 検索やフィルタで絞り込まれた後のリスト
  activeFilter: "all",    // 現在選択中のカテゴリフィルタ
  query: "",              // 検索窓の入力文字列
  isSyncing: false,       // 保存処理中かどうか
  totalQty: 0,            // 画面上の全教材の合計在庫数
  dirtyCount: 0,          // 変更があった（保存が必要な）教材の数
  originalSnapshotMap: Object.create(null), // 変更検知用の「保存直後」の状態記録
  lastUpdatedAt: "",      // 最終更新日時
  visibleCount: INITIAL_VISIBLE_COUNT // 現在リストに表示している件数
};

/**
 * =========================
 * 起動処理
 * =========================
 */
document.addEventListener("DOMContentLoaded", async () => {
  // 1. URLから校舎情報を取得
  const params = new URLSearchParams(location.search);
  state.roomKey = (params.get("room") || "").trim().toLowerCase();
  state.roomLabel = ROOM_LABEL_MAP[state.roomKey] || "";

  // 2. ボタンや入力フォームのイベント設定
  initUI();
  
  // 3. サーバーから最新の在庫データを取得して描画
  await loadAppData();
});

/**
 * =========================
 * UI初期化（イベントリスナー登録）
 * =========================
 */
function initUI() {
  const roomLabelEl = document.getElementById("roomLabel");
  const sendBtn = document.getElementById("sendBtn");
  const searchInput = document.getElementById("searchInput");
  const filterArea = document.getElementById("filterArea");
  const list = document.getElementById("list");

  // 校舎名の表示（なければ閲覧モード）
  if (roomLabelEl) {
    if (state.roomKey && state.roomLabel) {
      roomLabelEl.textContent = state.roomLabel;
    } else {
      roomLabelEl.textContent = "閲覧モード";
      roomLabelEl.classList.add("muted");
      if (sendBtn) sendBtn.style.display = "none";
    }
  }

  // 検索入力：文字を打つたびにフィルタを実行（デバウンスで実行回数を抑制）
  searchInput?.addEventListener("input", debounce((e) => {
    state.query = String(e.target.value || "").trim().toLowerCase();
    state.visibleCount = INITIAL_VISIBLE_COUNT; // 検索時は表示件数をリセット
    applyFilterAndRender();
  }, SEARCH_DEBOUNCE_MS));

  // カテゴリチップ：クリックしたカテゴリで絞り込み
  filterArea?.addEventListener("click", (e) => {
    const chip = e.target.closest(".f-chip");
    if (!chip) return;

    const next = chip.dataset.filter;
    if (!next || next === state.activeFilter) return;

    // アクティブな見た目を切り替え
    document.querySelectorAll(".f-chip").forEach(el => el.classList.remove("active"));
    chip.classList.add("active");

    state.activeFilter = next;
    state.visibleCount = INITIAL_VISIBLE_COUNT;
    applyFilterAndRender();
  });

  // リスト全体のクリック：数量ボタン（＋/－）または「さらに表示」ボタンを判別
  list?.addEventListener("click", handleListClick);
  
  // 保存ボタン
  sendBtn?.addEventListener("click", sendData);

  // --- ツールメニュー関連 ---
  document.getElementById("toolMenuBtn")?.addEventListener("click", openToolMenu);
  document.getElementById("closeToolMenuBtn")?.addEventListener("click", closeToolMenu);

  document.getElementById("menuAddCustomBtn")?.addEventListener("click", () => {
    closeToolMenu();
    openCustomDialog();
  });

  // --- バックアップ関連 ---
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

  // --- マスタ外追加ダイアログ関連 ---
  document.getElementById("cancelCustomBtn")?.addEventListener("click", closeCustomDialog);
  document.getElementById("customItemForm")?.addEventListener("submit", handleCustomItemSubmit);

  // ダイアログの背景（外側）をクリックしたら閉じる設定
  attachDialogBackdropClose("toolMenuDialog");
  attachDialogBackdropClose("customItemDialog");

  // 初期のUI表示を更新
  updateStatsUI();
  updateMetaInfo();
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
    // 1. data.jsが正しく読み込まれているかチェック
    if (typeof MASTER_DATA === 'undefined' || !Array.isArray(MASTER_DATA) || MASTER_DATA.length === 0) {
      throw new Error("data.js の読み込みに失敗したか、データが空です。");
    }

    const masterData = MASTER_DATA;
    let invData = { success: true, inventory: {}, extraItems: [], updatedAt: "" };

    // 2. 校舎キーがある場合、GASから現在の在庫を取得
    if (state.roomKey) {
      const invRes = await fetch(`${GAS_URL}?room=${encodeURIComponent(state.roomKey)}`, { cache: "no-store" });
      if (!invRes.ok) throw new Error("在庫データの取得に失敗しました。");
      invData = await invRes.json();
    }

    if (!invData.success) {
      throw new Error(invData.message || "在庫データ取得に失敗しました。");
    }

    // 3. 取得したデータをstateに展開して整理
    buildStateFromServer(masterData, invData);

    // 4. UIの構築
    generateCategoryChips(); // カテゴリボタン作成
    updateStatsUI();         // 合計数などの更新
    applyFilterAndRender();  // リストの描画

    const sec = ((performance.now() - started) / 1000).toFixed(2);
    setStatus(`同期完了: ${sec}秒`);

  } catch (err) {
    console.error("Critical Error:", err);
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

/**
 * サーバーデータとマスタデータを合体させてstateを構築する
 */
function buildStateFromServer(masterData, invData) {
  const inventory = invData.inventory || {};
  const extraItems = Array.isArray(invData.extraItems) ? invData.extraItems : [];

  state.lastUpdatedAt = invData.updatedAt || "";
  state.items = [];
  state.itemsById = new Map();
  state.totalQty = 0;
  state.dirtyCount = 0;
  state.originalSnapshotMap = Object.create(null);
  state.visibleCount = INITIAL_VISIBLE_COUNT;

  // 1. マスタデータ（教科書一覧）を処理
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
      qty: Number(inventory[id]) || 0, // 在庫データがあれば入れる
      isCustom: false
    });

    pushItemToState(item);
  }

  // 2. マスタ外教材（以前保存された追加分）を処理
  for (let i = 0; i < extraItems.length; i++) {
    const src = extraItems[i] || {};
    const ex = normalizeItem({
      id: exOrDefault(src.id, createCustomId_()),
      name: exOrDefault(src.name, "名称未設定"),
      category: exOrDefault(src.category, "未分類"),
      subject: exOrDefault(src.subject, ""),
      publisher: exOrDefault(src.publisher, ""),
      edition: exOrDefault(src.edition, ""),
      qty: Math.max(0, Number(src.qty) || 0),
      isCustom: true
    });

    pushItemToState(ex);
  }
}

/**
 * 教材オブジェクトを正規化し、検索用のタグを生成
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
    __dirty: false // 変更フラグ
  };

  // 検索用文字列をあらかじめ作っておく
  item.searchTag = [
    item.id, item.name, item.category, item.subject, item.publisher, item.edition,
    item.isCustom ? "マスタ外" : ""
  ].join(" ").toLowerCase();

  return item;
}

/**
 * 変更検知用のデータ比較用文字列（JSON）を作成
 */
function snapshotKey(item) {
  return JSON.stringify({
    name: item.name, category: item.category, subject: item.subject,
    publisher: item.publisher, edition: item.edition, qty: item.qty,
    isCustom: !!item.isCustom
  });
}

/**
 * 教材カテゴリのボタン（チップ）を自動生成
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

/**
 * =========================
 * 絞り込み・描画処理
 * =========================
 */
function applyFilterAndRender() {
  const q = state.query;
  const filter = state.activeFilter;
  const result = [];

  // 条件に合う教材を抽出
  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];

    // カテゴリ/種別フィルタ
    if (filter === "input") {
      if (item.qty <= 0) continue;
    } else if (filter === "custom") {
      if (!item.isCustom) continue;
    } else if (filter !== "all") {
      if (item.category !== filter) continue;
    }

    // 検索ワードフィルタ
    if (q && !item.searchTag.includes(q)) continue;
    
    result.push(item);
  }

  // ソート（マスタ外が上、次にカテゴリ順）
  result.sort(compareItems_);
  state.filteredItems = result;

  renderFilteredItems();
  updateMetaInfo();
}

/**
 * リストをHTMLとして画面に表示（visibleCount分だけ表示）
 */
function renderFilteredItems() {
  const container = document.getElementById("list");
  if (!container) return;

  container.innerHTML = "";

  if (state.filteredItems.length === 0) {
    container.innerHTML = `<div class="empty">該当する教材がありません。</div>`;
    updateMetaInfo();
    return;
  }

  // 表示件数分だけ切り出す
  const visibleItems = state.filteredItems.slice(0, state.visibleCount);
  let html = "";

  for (let i = 0; i < visibleItems.length; i++) {
    html += renderItemHTML(visibleItems[i]);
  }

  // 全件数より表示数が少なければ「さらに表示」ボタンを追加
  if (state.filteredItems.length > state.visibleCount) {
    html += renderLoadMoreHTML();
  }

  container.innerHTML = html;
  updateMetaInfo();
}

/**
 * 教材カード1枚分のHTML
 */
function renderItemHTML(item) {
  const metaTexts = [];
  if (item.publisher) metaTexts.push(`出版社: ${item.publisher}`);
  if (item.edition) metaTexts.push(`版/準拠: ${item.edition}`);

  return `
    <article class="item ${item.qty > 0 ? "has-qty" : ""} ${item.isCustom ? "custom-item" : ""}" data-id="${escapeHtml(item.id)}">
      <div class="item-main">
        <div class="item-badges">
          <span class="badge badge-cat">${escapeHtml(item.category || "未分類")}</span>
          ${item.subject ? `<span class="badge badge-sub">${escapeHtml(item.subject)}</span>` : ""}
          ${item.publisher ? `<span class="badge badge-pub">${escapeHtml(item.publisher)}</span>` : ""}
          ${item.isCustom ? `<span class="badge badge-custom">マスタ外</span>` : ""}
        </div>
        <div class="item-name">${escapeHtml(item.name)}</div>
        <div class="item-meta-text">
          ${escapeHtml(item.id)}
          ${metaTexts.length ? ` / ${escapeHtml(metaTexts.join(" / "))}` : ""}
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

/**
 * =========================
 * 在庫数の変更操作
 * =========================
 */
function handleListClick(e) {
  // 「さらに表示」ボタンクリック時
  const loadMoreBtn = e.target.closest("#loadMoreBtn");
  if (loadMoreBtn) {
    state.visibleCount += LOAD_MORE_COUNT;
    renderFilteredItems();
    return;
  }
  // ＋・－ボタンクリック時
  handleCounterClick(e);
}

function handleCounterClick(e) {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (!btn.classList.contains("plus") && !btn.classList.contains("minus")) return;

  const card = e.target.closest(".item");
  const id = card?.dataset.id;
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

  // 数値を更新
  item.qty = newQty;
  const qtyEl = card.querySelector(".qty-num");
  if (qtyEl) qtyEl.textContent = String(newQty);
  card.classList.toggle("has-qty", newQty > 0);

  // 変更検知と合計値の再計算
  applyDirtyRecalcForItem(item);
  updateStatsUI();

  // 「入力済み」フィルタ中に0にした場合はリストから消す
  if (state.activeFilter === "input" && newQty === 0) {
    applyFilterAndRender();
    return;
  }
  updateMetaInfo();
}

/**
 * 教材が「保存後の状態から変更されたか」をチェックしてdirtyCountを増減させる
 */
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

/**
 * 全教材の在庫数を合計する
 */
function recalcTotalQty() {
  let total = 0;
  for (let i = 0; i < state.items.length; i++) {
    total += Number(state.items[i].qty) || 0;
  }
  state.totalQty = total;
}

/**
 * 下部バー（合計部数・保存ボタンの状態）を更新
 */
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

/**
 * メタ情報（最終更新日時など）を表示
 */
function updateMetaInfo() {
  const updatedEl = document.getElementById("updatedAt");
  if (updatedEl) {
    updatedEl.textContent = formatDateForDisplay(state.lastUpdatedAt);
  }
}

/**
 * =========================
 * サーバー保存処理
 * =========================
 */
async function sendData() {
  if (!state.roomKey || state.isSyncing) return;
  if (state.dirtyCount === 0) return;

  const ok = confirm(`${state.dirtyCount}件の変更を保存しますか？`);
  if (!ok) return;

  const btn = document.getElementById("sendBtn");

  try {
    state.isSyncing = true;
    updateStatsUI();
    if (btn) btn.textContent = "保存中...";
    setStatus("保存中...");

    // 全アイテムを送信（マスタ外も含む）
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

    // GASへPOST送信
    await fetch(GAS_URL, {
      method: "POST",
      mode: "no-cors", // GASの仕様上、レスポンスは見られないが送信は可能
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });

    // 保存が成功したとみなして、今の状態を「オリジナル」として記録
    refreshOriginalSnapshotsAfterSave();
    state.lastUpdatedAt = new Date().toISOString();

    updateStatsUI();
    updateMetaInfo();
    setStatus("保存リクエスト送信完了");
    alert("保存リクエストを送信しました。\n（反映には数秒かかる場合があります）");

  } catch (err) {
    console.error(err);
    setStatus(`保存失敗: ${err.message}`);
    alert(`保存失敗: ${err.message}`);
  } finally {
    state.isSyncing = false;
    if (btn) btn.textContent = "保存する";
    updateStatsUI();
  }
}

/**
 * 保存後、現在の状態を比較用スナップショットとして上書きする
 */
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
 * マスタ外教材の追加ダイアログ
 * =========================
 */
function handleCustomItemSubmit(e) {
  e.preventDefault();

  // フォームから値を取得
  const name = document.getElementById("customName")?.value.trim() || "";
  const category = document.getElementById("customCategory")?.value.trim() || "未分類";
  const subject = document.getElementById("customSubject")?.value.trim() || "";
  const publisher = document.getElementById("customPublisher")?.value.trim() || "";
  const edition = document.getElementById("customEdition")?.value.trim() || "";
  const qty = Math.max(0, Number(document.getElementById("customQty")?.value) || 0);

  if (!name) {
    alert("教材名を入力してください。");
    return;
  }

  // 新しい教材オブジェクトを作成
  const item = normalizeItem({
    id: createCustomId_(),
    name, category, subject, publisher, edition, qty,
    isCustom: true
  });

  // リストの先頭に追加
  state.items.unshift(item);
  state.itemsById.set(item.id, item);
  state.originalSnapshotMap[item.id] = ""; // 初期状態は空＝変更ありとみなす
  item.__dirty = true;
  state.dirtyCount++;

  recalcTotalQty();
  generateCategoryChips(); // 新しいカテゴリが増えた可能性があるので更新
  updateStatsUI();

  // 表示を更新
  state.visibleCount = INITIAL_VISIBLE_COUNT;
  applyFilterAndRender();

  // フォームリセット
  const form = document.getElementById("customItemForm");
  if (form) form.reset();
  const qtyInput = document.getElementById("customQty");
  if (qtyInput) qtyInput.value = "1";

  closeCustomDialog();
  setStatus("マスタ外教材を追加しました。未保存の状態です。");
}

/**
 * =========================
 * ユーティリティ・小関数
 * =========================
 */
// ステータスバーのメッセージを更新（現在時刻付き）
function setStatus(msg) {
  const now = new Date().toLocaleTimeString("ja-JP");
  const el = document.getElementById("statusLine");
  if (el) {
    const total = state.filteredItems.length;
    const visible = Math.min(state.visibleCount, total);
    const suffix = total > 0 ? `（${total}件中 ${visible}件表示）` : "";
    el.textContent = `[${now}] ${msg}${suffix}`;
  }
}

// 入力イベントの頻度を抑えるためのデバウンス関数
function debounce(fn, wait) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

// 画面表示用の日付整形
function formatDateForDisplay(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);

  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  }).format(d);
}

// HTMLエスケープ（セキュリティ対策：タグなどを無効化）
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[ch];
  });
}

// ダイアログの「外側」をクリックした時に閉じるための処理
function attachDialogBackdropClose(dialogId) {
  const dialog = document.getElementById(dialogId);
  if (!dialog) return;
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}
