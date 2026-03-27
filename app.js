/**
 * ==================================================================================
 * 定数・基本設定
 * ==================================================================================
 */

// 連携先となるGoogle Apps ScriptのWebアプリURL
const GAS_URL = "https://script.google.com/macros/s/AKfycbwC5pANYvRlwAqEFESKb5-rSPQQMR85UBEX9BZJAZRAYBxdYvEdiXGWnymIxmZO7kgUTw/exec";

// ブラウザのLocalStorageに保存する際の接頭辞（他のサイトのデータと混ざらないようにするため）
const STORAGE_PREFIX = "inventory_cache_";

// 初回表示時に描画するアイテム数（一度に数千件出すとブラウザが固まるため制限する）
const INITIAL_RENDER_COUNT = 100;

// 「もっと見る」ボタンを押した際に追加で読み込む件数
const RENDER_STEP = 100;

// URLパラメータ(?room=xxx)と表示名の対応表
const ROOM_MAP = {
  "takadanobaba": "高田馬場",
  "sugamo": "巣鴨",
  "nishinippori": "西日暮里",
  "ohji": "王子",
  "itabashi": "板橋",
  "minamisenju": "南千住",
  "kiba": "木場",
  "gakuin": "学院"
};

/**
 * ==================================================================================
 * 状態管理（State）
 * アプリの現在の状況を一元管理するオブジェクト
 * ==================================================================================
 */
let state = {
  roomKey: null,      // 現在選択されている拠点のキー（例: sugamo）
  items: [],          // 全データ（原本）
  filteredItems: [],  // 検索フィルタ適用後の全データ
  visibleItems: [],   // 実際に画面に表示されている（描画制限内の）データ
  query: "",          // 検索窓に入力された文字列
  isSyncing: false,   // GASと通信中かどうか
  displayLimit: INITIAL_RENDER_COUNT // 現在の表示件数上限
};

/**
 * ==================================================================================
 * DOM要素の取得
 * ==================================================================================
 */
const roomLabelEl = document.getElementById("roomLabel");
const statusEl = document.getElementById("status");
const searchInputEl = document.getElementById("searchInput");
const listEl = document.getElementById("list");
const toolbarEl = document.getElementById("toolbar");
const guideEl = document.getElementById("guide");
const countInfoEl = document.getElementById("countInfo");
const loadMoreWrapEl = document.getElementById("loadMoreWrap");
const loadMoreBtnEl = document.getElementById("loadMoreBtn");

/**
 * ==================================================================================
 * 初期化処理（イベントリスナー設定）
 * ==================================================================================
 */
document.addEventListener("DOMContentLoaded", () => {
  // 1. URLから拠点キーを取得 (?room=sugamo など)
  state.roomKey = new URLSearchParams(window.location.search).get("room")?.toLowerCase();

  // 不正な拠点キー、または指定がない場合は案内を表示して終了
  if (!state.roomKey || !ROOM_MAP[state.roomKey]) {
    guideEl.classList.remove("hidden");
    setStatus("教室を選択してください");
    return;
  }

  // UIの初期設定
  roomLabelEl.textContent = `対象教室: ${ROOM_MAP[state.roomKey]}`;
  toolbarEl.classList.remove("hidden");
  guideEl.classList.add("hidden");

  // 2. キャッシュの読み込み（速度向上のため、まずは前回のデータを表示する）
  const cached = localStorage.getItem(STORAGE_PREFIX + state.roomKey);
  if (cached) {
    try {
      const data = JSON.parse(cached);
      state.items = normalizeItems(data.items || []);
      applyFilterAndRender();
      setStatus("キャッシュを表示中（背後で同期中...）");
    } catch (e) {
      listEl.innerHTML = `<div class="empty">データを読み込んでいます...</div>`;
    }
  } else {
    listEl.innerHTML = `<div class="empty">データを読み込んでいます...</div>`;
  }

  // 3. サーバー(GAS)から最新データを取得
  fetchLatestData();

  // 検索入力時のイベント
  searchInputEl.addEventListener("input", (e) => {
    state.query = e.target.value.trim();
    state.displayLimit = INITIAL_RENDER_COUNT; // 検索時は表示上限をリセット
    applyFilterAndRender();
  });

  // リロードボタン
  document.getElementById("reloadBtn").onclick = () => {
    if (confirm("最新データを再取得しますか？")) fetchLatestData(true);
  };

  // 送信ボタン
  document.getElementById("sendBtn").onclick = sendAllData;

  // 「もっと見る」ボタン
  loadMoreBtnEl.onclick = () => {
    state.displayLimit += RENDER_STEP;
    applyVisibleItems_();
    renderList();
  };

  // リスト内のボタン（＋・－）クリックイベント（イベント委譲を利用）
  listEl.onclick = (e) => {
    const btn = e.target.closest("button");
    if (!btn || btn.id === "loadMoreBtn") return;

    const id = btn.dataset.id;
    const isPlus = btn.classList.contains("plus");
    const item = state.items.find(x => String(x.id) === String(id));

    if (!item) return;

    // 数値を更新（マイナスは0未満にならないように制御）
    item.qty = isPlus ? item.qty + 1 : Math.max(0, item.qty - 1);

    // 画面上の数値表示だけを即時書き換え（再描画全体を行わないことで軽快に動作させる）
    const itemCard = btn.closest(".item");
    if (itemCard) {
      const qtyDisplay = itemCard.querySelector(".qty");
      if (qtyDisplay) qtyDisplay.textContent = item.qty;
    }

    // 更新のたびにキャッシュへ保存（ブラウザを閉じても大丈夫なように）
    saveCache();
  };
});

/**
 * ==================================================================================
 * 描画・フィルタ関連
 * ==================================================================================
 */

/**
 * stateにあるデータを元に、HTMLを生成して画面に反映する
 */
function renderList() {
  // データが1件もない場合
  if (state.items.length === 0 && !state.isSyncing) {
    listEl.innerHTML = `<div class="empty">データがありません。</div>`;
    countInfoEl.textContent = "";
    loadMoreWrapEl.classList.add("hidden");
    return;
  }

  // 検索結果が0件の場合
  if (state.visibleItems.length === 0) {
    listEl.innerHTML = `<div class="empty">該当する教材がありません。</div>`;
    countInfoEl.textContent = `0件`;
    loadMoreWrapEl.classList.add("hidden");
    return;
  }

  // 配列からHTML文字列を一括生成
  const fragments = state.visibleItems.map(item => `
    <div class="item">
      <div class="item-main">
        <div class="item-top">
          ${item.master ? `<span class="chip master">${escapeHtml(item.master)}</span>` : ""}
          ${item.subject ? `<span class="chip subject">${escapeHtml(item.subject)}</span>` : ""}
          <span class="chip">${escapeHtml(item.id)}</span>
        </div>
        <div class="item-name">${escapeHtml(item.name)}</div>
        <div class="item-meta">
          ${item.publisher ? `出版社: ${escapeHtml(item.publisher)}` : ""}
        </div>
      </div>
      <div class="counter">
        <button type="button" class="minus" data-id="${escapeHtml(item.id)}">－</button>
        <div class="qty">${item.qty}</div>
        <button type="button" class="plus" data-id="${escapeHtml(item.id)}">＋</button>
      </div>
    </div>
  `).join("");

  listEl.innerHTML = fragments;

  // 件数表示の更新
  const total = state.filteredItems.length;
  const visible = state.visibleItems.length;

  if (state.query) {
    countInfoEl.textContent = `${total}件ヒット`;
  } else {
    countInfoEl.textContent = `${visible} / ${total}件を表示`;
  }

  // 「もっと見る」ボタンの表示制御（まだ表示しきれていないデータがある場合のみ出す）
  if (!state.query && state.filteredItems.length > state.visibleItems.length) {
    loadMoreWrapEl.classList.remove("hidden");
  } else {
    loadMoreWrapEl.classList.add("hidden");
  }
}

/**
 * 入力されたクエリに基づきフィルタリングし、表示用リストを作成する
 */
function applyFilterAndRender() {
  const q = state.query.toLowerCase();

  if (!q) {
    state.filteredItems = state.items;
  } else {
    // ID、商品名、科目のいずれかにヒットすれば抽出
    state.filteredItems = state.items.filter(i =>
      i.id.toLowerCase().includes(q) ||
      i.name.toLowerCase().includes(q) ||
      i.subject.toLowerCase().includes(q)
    );
  }

  applyVisibleItems_();
  renderList();
}

/**
 * フィルタリング後のリストから、実際に描画する件数分(displayLimit)だけを切り出す
 */
function applyVisibleItems_() {
  if (state.query) {
    // 検索中は全件表示（フィルタで絞られているはずなので）
    state.visibleItems = state.filteredItems;
  } else {
    // 通常時はステップごとに分割表示
    state.visibleItems = state.filteredItems.slice(0, state.displayLimit);
  }
}

/**
 * ==================================================================================
 * 通信関連（API呼び出し）
 * ==================================================================================
 */

/**
 * GASから最新の在庫データを取得する
 * @param {boolean} manual - 手動更新ボタンから呼ばれたかどうか
 */
async function fetchLatestData(manual = false) {
  if (state.isSyncing) return; // 二重送信防止

  state.isSyncing = true;
  if (manual) setStatus("最新データ取得中...");

  try {
    // タイムアウト設定（15秒で中断）
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(`${GAS_URL}?type=inventory&room=${encodeURIComponent(state.roomKey)}`, {
      signal: controller.signal
    });

    const result = await res.json();
    clearTimeout(timeoutId);

    if (!result.success) throw new Error(result.message || "データ取得に失敗しました");

    // 取得したデータを状態に反映し、キャッシュも更新
    state.items = normalizeItems(result.items || []);
    saveCache();
    applyFilterAndRender();
    setStatus("同期完了");
  } catch (e) {
    console.error(e);
    // 失敗してもキャッシュがあれば操作は継続可能
    setStatus("オフライン表示中");
  } finally {
    state.isSyncing = false;
  }
}

/**
 * 現在の状態（全アイテムの在庫数）をGASへPOST送信する
 */
async function sendAllData() {
  const btn = document.getElementById("sendBtn");
  if (!confirm("送信しますか？")) return;

  btn.disabled = true;
  setStatus("送信中...");

  try {
    const res = await fetch(GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room: state.roomKey,
        items: state.items
      })
    });

    const result = await res.json();
    if (!result.success) throw new Error(result.message || "送信失敗");

    setStatus("送信成功");
    alert("送信完了！");
  } catch (e) {
    console.error(e);
    alert("送信に失敗しました。電波の良い所で再度お試しください。");
    setStatus("送信失敗");
  } finally {
    btn.disabled = false;
  }
}

/**
 * ==================================================================================
 * ユーティリティ関数
 * ==================================================================================
 */

/**
 * データの型や値を安全に整形する
 */
function normalizeItems(items) {
  return items.map(item => ({
    master: String(item.master || "").trim(),
    id: String(item.id || "").trim(),
    subject: String(item.subject || "").trim(),
    name: String(item.name || "").trim(),
    publisher: String(item.publisher || "").trim(),
    qty: Math.max(0, Number(item.qty || 0))
  })).filter(item => item.id !== ""); // IDがない不正なデータは除去
}

/**
 * ブラウザのLocalStorageへ現在の状態を保存
 */
function saveCache() {
  localStorage.setItem(
    STORAGE_PREFIX + state.roomKey,
    JSON.stringify({ items: state.items })
  );
}

/**
 * 画面上のステータスバーにメッセージを表示
 */
function setStatus(msg) {
  statusEl.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
}

/**
 * HTMLエスケープ（XSS対策）
 * ユーザー入力値などを安全にHTMLに埋め込むために使用
 */
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, m => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[m]));
}
