/**
 * ==================================================================================
 * 1. 定数・設定セクション
 * ==================================================================================
 */

// GAS Web AppのURL（デプロイごとに変わるため、更新時はここを書き換える）
const APP_ID = "AKfycbylyAVHX4YkqN-wHhMzNFErhLNvVPySUeB7fxymcc2USaF8rB-lKrorSzm9kdBzD16HOg";
const GAS_URL = "https://script.google.com/macros/s/" & APP_ID & "/exec";

// ローカルストレージ用の名前空間。拠点が違ってもデータが混ざらないようにする
const STORAGE_PREFIX = "inventory_cache_";

// パフォーマンス対策：一度に描画する件数。これを超えると「もっと見る」ボタンが出る
const INITIAL_RENDER_COUNT = 50;
const RENDER_STEP = 50;

// 【重要】キャッシュ保存の遅延時間(ミリ秒)。
// ボタンを連打した際、最後の操作から800ms後に1回だけ保存を実行する（デバウンス処理）
const CACHE_SAVE_DELAY = 800;

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
 * 2. 状態管理（State）
 * ==================================================================================
 */
let state = {
  roomKey: null,      // 現在の拠点キー
  items: [],          // マスタ/サーバーから取得した全データ
  filteredItems: [],  // 検索フィルタにヒットしたデータ
  visibleItems: [],   // 現在画面に見えているデータ（分割表示用）
  query: "",          // 検索キーワード
  isSyncing: false,   // 通信中フラグ（二重送信防止用）
  displayLimit: INITIAL_RENDER_COUNT // 現在の表示上限数
};

// デバウンス（遅延実行）用のタイマーを保持する変数
let cacheSaveTimer = null;

/**
 * ==================================================================================
 * 3. 初期化処理（イベント登録）
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

document.addEventListener("DOMContentLoaded", () => {
  // URLのパラメータ (?room=xxx) を取得
  state.roomKey = new URLSearchParams(window.location.search).get("room")?.toLowerCase();

  // 拠点指定がない、または無効な拠点の場合は案内を表示して終了
  if (!state.roomKey || !ROOM_MAP[state.roomKey]) {
    guideEl.classList.remove("hidden");
    setStatus("教室を選択してください");
    return;
  }

  // 有効な拠点ならUIを準備
  roomLabelEl.textContent = `対象教室: ${ROOM_MAP[state.roomKey]}`;
  toolbarEl.classList.remove("hidden");
  guideEl.classList.add("hidden");

  // まずは前回保存したキャッシュを読み込んで即座に表示（オフライン対応/高速表示）
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

  // キャッシュ表示後に、最新データをサーバーへ取りに行く
  fetchLatestData();

  // 検索入力：文字が変わるたびにフィルタをかけて再描画
  searchInputEl.addEventListener("input", (e) => {
    state.query = e.target.value.trim();
    state.displayLimit = INITIAL_RENDER_COUNT;
    applyFilterAndRender();
  });

  // 再取得ボタン：確認後にサーバーからデータをロード
  document.getElementById("reloadBtn").addEventListener("click", () => {
    if (confirm("最新データを再取得しますか？")) fetchLatestData(true);
  });

  // 送信ボタン：全データをサーバーへPOST
  document.getElementById("sendBtn").addEventListener("click", sendAllData);

  // 「もっと見る」：表示上限を増やして追加描画
  loadMoreBtnEl.addEventListener("click", () => {
    state.displayLimit += RENDER_STEP;
    applyVisibleItems_();
    renderList();
  });

  // リスト内クリック：＋/－ボタンの判定（イベント委譲）
  listEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;

    // ボタンに埋め込んだ index（visibleItems内での位置）を取得
    const idx = Number(btn.dataset.index);
    if (Number.isNaN(idx)) return;

    const item = state.visibleItems[idx];
    if (!item) return;

    // 在庫数の加減算
    if (btn.classList.contains("plus")) {
      item.qty += 1;
    } else if (btn.classList.contains("minus")) {
      item.qty = Math.max(0, item.qty - 1);
    } else {
      return;
    }

    // パフォーマンス向上のため、該当する箇所の数値だけをDOM書き換え
    const itemCard = btn.closest(".item");
    if (itemCard) {
      const qtyDisplay = itemCard.querySelector(".qty");
      if (qtyDisplay) qtyDisplay.textContent = item.qty;
    }

    // 操作のたびに「後で保存する予約」を入れる
    scheduleCacheSave();
  });
});

/**
 * ==================================================================================
 * 4. 描画・フィルタリングロジック
 * ==================================================================================
 */

/**
 * 現在の visibleItems を使ってHTMLを構築し、画面に反映
 */
function renderList() {
  if (state.items.length === 0 && !state.isSyncing) {
    listEl.innerHTML = `<div class="empty">データがありません。</div>`;
    countInfoEl.textContent = "";
    loadMoreWrapEl.classList.add("hidden");
    return;
  }

  if (state.visibleItems.length === 0) {
    listEl.innerHTML = `<div class="empty">該当する教材がありません。</div>`;
    countInfoEl.textContent = `0件`;
    loadMoreWrapEl.classList.add("hidden");
    return;
  }

  // data-index を各ボタンに付与することで、クリック時にどのアイテムか特定可能にする
  const fragments = state.visibleItems.map((item, index) => `
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
        <button type="button" class="minus" data-index="${index}">－</button>
        <div class="qty">${item.qty}</div>
        <button type="button" class="plus" data-index="${index}">＋</button>
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

  // 「もっと見る」ボタンの表示判断
  if (!state.query && state.filteredItems.length > state.visibleItems.length) {
    loadMoreWrapEl.classList.remove("hidden");
  } else {
    loadMoreWrapEl.classList.add("hidden");
  }
}

/**
 * サーバーから最新情報を取得。成功したらキャッシュを即時保存し描画。
 */
async function fetchLatestData(manual = false) {
  if (state.isSyncing) return;

  state.isSyncing = true;
  if (manual) setStatus("最新データ取得中...");

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(`${GAS_URL}?type=inventory&room=${encodeURIComponent(state.roomKey)}`, {
      signal: controller.signal
    });

    const result = await res.json();
    clearTimeout(timeoutId);

    if (!result.success) throw new Error(result.message || "データ取得に失敗しました");

    state.items = normalizeItems(result.items || []);
    saveCacheNow(); // 取得成功時は即時保存
    applyFilterAndRender();
    setStatus("同期完了");
  } catch (e) {
    console.error(e);
    setStatus("オフライン表示中");
  } finally {
    state.isSyncing = false;
  }
}

/**
 * 検索キーワードに基づいて全データからフィルタリング
 */
function applyFilterAndRender() {
  const q = state.query.toLowerCase();

  if (!q) {
    state.filteredItems = state.items;
  } else {
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
 * 表示上限(displayLimit)に合わせて、実際にDOMにするアイテムを切り出す
 */
function applyVisibleItems_() {
  if (state.query) {
    state.visibleItems = state.filteredItems;
  } else {
    state.visibleItems = state.filteredItems.slice(0, state.displayLimit);
  }
}

/**
 * 現在の在庫状況をサーバー(GAS)に保存
 */
async function sendAllData() {
  const btn = document.getElementById("sendBtn");
  if (!confirm("送信しますか？")) return;

  // 送信前に現在の状態を確実にキャッシュ保存
  saveCacheNow();

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
 * 5. ユーティリティ・キャッシュ関連
 * ==================================================================================
 */

/**
 * データのクリーニング。不正な値や空のIDを取り除く。
 */
function normalizeItems(items) {
  return items.map(item => ({
    master: String(item.master || "").trim(),
    id: String(item.id || "").trim(),
    subject: String(item.subject || "").trim(),
    name: String(item.name || "").trim(),
    publisher: String(item.publisher || "").trim(),
    qty: Math.max(0, Number(item.qty || 0))
  })).filter(item => item.id !== "");
}

/**
 * キャッシュ保存の「予約」を行う（デバウンス）。
 * 頻繁なディスク書き込みを抑制し、ブラウザの負荷を下げる。
 */
function scheduleCacheSave() {
  if (cacheSaveTimer) clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    saveCacheNow();
  }, CACHE_SAVE_DELAY);
}

/**
 * ローカルストレージに現在の items を保存する。
 */
function saveCacheNow() {
  localStorage.setItem(
    STORAGE_PREFIX + state.roomKey,
    JSON.stringify({ items: state.items })
  );
  // タイマーが走っていたらクリアしておく
  if (cacheSaveTimer) {
    clearTimeout(cacheSaveTimer);
    cacheSaveTimer = null;
  }
}

/**
 * ステータス表示の更新（時刻付き）
 */
function setStatus(msg) {
  statusEl.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
}

/**
 * 特殊文字をエスケープしてXSSを防ぐ
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
