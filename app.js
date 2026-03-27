/**
 * ================================================================
 * 在庫カウント アプリケーション フロントエンド
 * ================================================================
 */

// --- 設定情報 ---

// デプロイしたGASのWebアプリURL
const GAS_URL = "https://script.google.com/macros/s/AKfycbzoWI5gWRgnluVkSBpNT7E29Q-bHyFch-VzyFXnaQn3OPJ6Wg7NsQd1y9UmvIWRcM7cQw/exec";

// localStorageで使用するキーの接頭辞
const STORAGE_PREFIX = "inventory_cache_";

/** * GAS側と一致する教室名マッピング 
 * URLの room=takadanobaba から「高田馬場」という表示名を得るために使用
 */
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

// アプリの共通状態管理（State）
let state = {
  roomKey: null,   // URLから取得した英字ID (例: "takadanobaba")
  roomName: null,  // 表示用の日本語名 (例: "高田馬場")
  items: [],       // 全在庫データ
  filteredItems: [], // 検索フィルタ後の表示用データ
  query: "",       // 検索キーワード
  lastLoadedAt: null,
  lastSentAt: null
};

// --- DOM要素の参照取得 ---
const roomLabelEl = document.getElementById("roomLabel");
const statusEl = document.getElementById("status");
const searchInputEl = document.getElementById("searchInput");
const reloadBtnEl = document.getElementById("reloadBtn");
const sendBtnEl = document.getElementById("sendBtn");
const listEl = document.getElementById("list");
const toolbarEl = document.getElementById("toolbar");
const guideEl = document.getElementById("guide");

/**
 * ================================================================
 * 初期化処理
 * ================================================================
 */

document.addEventListener("DOMContentLoaded", async () => {
  // 1. URLからroomパラメータを取得
  state.roomKey = getRoomKeyFromUrl();

  // 2. 教室指定がない、または無効なIDの場合は案内画面を表示
  if (!state.roomKey || !ROOM_MAP[state.roomKey]) {
    showRoomRequiredState();
    return;
  }

  // 3. 表示名の設定とUIの切り替え
  state.roomName = ROOM_MAP[state.roomKey];
  roomLabelEl.textContent = `対象教室: ${state.roomName}`;
  toolbarEl.classList.remove("hidden");
  guideEl.classList.add("hidden");

  // 4. ローカルキャッシュ（前回保存分）があれば即座に表示
  const cached = loadCache(state.roomKey);
  if (cached && Array.isArray(cached.items)) {
    state.items = normalizeItems(cached.items);
    state.lastLoadedAt = cached.lastLoadedAt || null;
    state.lastSentAt = cached.lastSentAt || null;
    applyFilterAndRender();
    setStatus("ローカルキャッシュを表示中");
  }

  // 5. サーバ（GAS）から最新データを取得
  await initializeData();

  // --- イベントリスナーの登録 ---

  // 検索入力時のリアルタイムフィルタ
  searchInputEl.addEventListener("input", (e) => {
    state.query = e.target.value.trim();
    applyFilterAndRender();
  });

  // 再取得ボタン：サーバの最新データで上書き
  reloadBtnEl.addEventListener("click", async () => {
    if (confirm("サーバから最新データを再取得しますか？（現在の未送信分は消去されます）")) {
      await fetchLatestData(true);
    }
  });

  // 送信ボタン：現在の全データをGAS経由でシートへ保存
  sendBtnEl.addEventListener("click", async () => {
    await sendAllData();
  });
});

/**
 * ================================================================
 * 画面表示・状態制御
 * ================================================================
 */

/** 教室指定がない場合の表示切り替え */
function showRoomRequiredState() {
  roomLabelEl.textContent = "対象教室: 未指定";
  toolbarEl.classList.add("hidden");
  guideEl.classList.remove("hidden");
  listEl.innerHTML = `<div class="empty">URLに正しい room パラメータを指定してください</div>`;
  setStatus("教室が指定されていません");
}

/** 画面下部のステータスバーを更新 */
function setStatus(message) {
  const now = new Date();
  const time = now.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  statusEl.textContent = `[${time}] ${message}`;
}

/**
 * ================================================================
 * 外部通信 (GAS API)
 * ================================================================
 */

/** 起動時のデータ取得フロー */
async function initializeData() {
  try {
    await fetchLatestData(false);
  } catch (error) {
    console.error("データ取得失敗:", error);
    if (!state.items || state.items.length === 0) {
      setStatus("通信失敗。データを取得できませんでした");
      listEl.innerHTML = `<div class="empty">オフラインかつキャッシュもありません</div>`;
    } else {
      setStatus("通信失敗のためキャッシュを継続使用中");
    }
  }
}

/** * サーバから最新データを取得 
 * 教室別の在庫が空なら、自動的に教材マスタを読み込む
 */
async function fetchLatestData(manual = false) {
  setStatus(manual ? "最新データ再取得中..." : "最新データ取得中...");

  // GASのdoGetへリクエスト (roomには英字IDを渡す)
  const response = await fetch(`${GAS_URL}?type=inventory&room=${encodeURIComponent(state.roomKey)}`, {
    method: "GET",
    cache: "no-store"
  });

  if (!response.ok) throw new Error(`GET失敗: ${response.status}`);
  const result = await response.json();

  // 在庫データが存在する場合
  if (result.success && Array.isArray(result.items) && result.items.length > 0) {
    state.items = normalizeItems(result.items);
    state.lastLoadedAt = result.timestamp || new Date().toISOString();
    saveCache(state.roomKey);
    applyFilterAndRender();
    setStatus("サーバから在庫データを読み込みました");
    return;
  }

  // 在庫データが空（新規教室など）なら、教材マスタからリストを作成
  await loadMasterItems();
  setStatus("在庫がないため教材マスタを読み込みました");
}

/** 教材マスタを全件取得して初期リストを作成 */
async function loadMasterItems() {
  const response = await fetch(`${GAS_URL}?type=master`, {
    method: "GET",
    cache: "no-store"
  });

  if (!response.ok) throw new Error(`教材マスタ取得失敗: ${response.status}`);
  const result = await response.json();

  if (!result.success || !Array.isArray(result.items)) throw new Error("マスタの解析に失敗しました");

  state.items = normalizeItems(result.items);
  state.lastLoadedAt = result.timestamp || new Date().toISOString();
  saveCache(state.roomKey);
  applyFilterAndRender();
}

/** 全データをPOST送信してスプレッドシートを更新 */
async function sendAllData() {
  if (!state.roomKey) return;
  
  if (!confirm(`${state.roomName} のデータを送信して上書きしますか？`)) return;

  setStatus("送信中...");
  sendBtnEl.disabled = true;

  const payload = {
    room: state.roomKey, // GAS側の英字IDバリデーションを通るように送る
    items: state.items
  };

  try {
    const response = await fetch(GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // GASはtext/plainで受け取るのが安定
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    if (!result.success) throw new Error(result.message || "送信失敗");

    state.lastSentAt = result.timestamp || new Date().toISOString();
    saveCache(state.roomKey);

    setStatus(`送信成功: ${formatDateTime(state.lastSentAt)}`);
    alert("送信が完了しました");
  } catch (error) {
    console.error(error);
    setStatus("送信失敗。オフラインで継続可能です");
    alert(`送信エラー: ${error.message}`);
  } finally {
    sendBtnEl.disabled = false;
  }
}

/**
 * ================================================================
 * データ処理・キャッシュ
 * ================================================================
 */

/** * GASから取得したデータをフロント用の構造に整える 
 * プロパティ名をGAS側のマスタ定義に合わせる (category -> subject等)
 */
function normalizeItems(items) {
  return items.map(item => ({
    master: String(item.master || ""),       // マスタ区分
    id: String(item.id || ""),               // 商品コード
    subject: String(item.subject || item.category || ""), // 科目
    name: String(item.name || ""),           // 商品名
    publisher: String(item.publisher || ""), // 出版社
    qty: Math.max(0, Number(item.qty || 0))  // 部数
  }));
}

/** 検索・並び替えを適用してリストを描画 */
function applyFilterAndRender() {
  const q = state.query.toLowerCase();

  if (!q) {
    state.filteredItems = [...state.items];
  } else {
    // ID、科目、商品名、出版社から部分一致検索
    state.filteredItems = state.items.filter(item =>
      (item.id || "").toLowerCase().includes(q) ||
      (item.subject || "").toLowerCase().includes(q) ||
      (item.name || "").toLowerCase().includes(q) ||
      (item.publisher || "").toLowerCase().includes(q)
    );
  }
  renderList();
}

/** ブラウザのLocalStorageへ現在の状態を保存 */
function saveCache(roomKey) {
  const payload = {
    items: state.items,
    lastLoadedAt: state.lastLoadedAt,
    lastSentAt: state.lastSentAt,
    cachedAt: new Date().toISOString()
  };
  localStorage.setItem(`${STORAGE_PREFIX}${roomKey}`, JSON.stringify(payload));
}

/** キャッシュの読み込み */
function loadCache(roomKey) {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${roomKey}`);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

/** URLパラメータのroom値を取得 */
function getRoomKeyFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return (params.get("room") || "").trim().toLowerCase();
}

/**
 * ================================================================
 * 数量操作・UI描画
 * ================================================================
 */

function incrementItem(id) {
  const item = state.items.find(x => x.id === id);
  if (item) {
    item.qty += 1;
    saveCache(state.roomKey);
    applyFilterAndRender();
  }
}

function decrementItem(id) {
  const item = state.items.find(x => x.id === id);
  if (item && item.qty > 0) {
    item.qty -= 1;
    saveCache(state.roomKey);
    applyFilterAndRender();
  }
}

/** 画面上のリストを生成 */
function renderList() {
  if (!state.filteredItems || state.filteredItems.length === 0) {
    listEl.innerHTML = `<div class="empty">該当する教材がありません</div>`;
    return;
  }

  const html = state.filteredItems.map(item => `
    <div class="item">
      <div class="item-main">
        <div class="item-top">
          <span class="chip">${escapeHtml(item.id)}</span>
          ${item.subject ? `<span class="chip category">${escapeHtml(item.subject)}</span>` : ""}
        </div>
        <div class="item-name">${escapeHtml(item.name)}</div>
        <div class="item-meta">
          ${item.publisher ? `出版社: ${escapeHtml(item.publisher)}` : ""}
        </div>
      </div>

      <div class="counter">
        <button type="button" class="minus" data-action="minus" data-id="${escapeHtml(item.id)}">－</button>
        <div class="qty">${item.qty}</div>
        <button type="button" data-action="plus" data-id="${escapeHtml(item.id)}">＋</button>
      </div>
    </div>
  `).join("");

  listEl.innerHTML = html;

  // ボタンイベントの一括登録
  listEl.querySelectorAll("button[data-action]").forEach(btn => {
    btn.addEventListener("click", () => {
      const { action, id } = btn.dataset;
      action === "plus" ? incrementItem(id) : decrementItem(id);
    });
  });
}

/** 日時フォーマット */
function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : d.toLocaleString("ja-JP");
}

/** HTMLエスケープ（セキュリティ対策） */
function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[m]);
}
