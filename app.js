/**
 * ================================================================
 * 在庫カウント アプリケーション フロントエンド
 * GAS API仕様 (master, id, subject, name, publisher, qty) に完全準拠
 * ================================================================
 */

// --- 設定情報 ---
const GAS_URL = "https://script.google.com/macros/s/AKfycbzoWI5gWRgnluVkSBpNT7E29Q-bHyFch-VzyFXnaQn3OPJ6Wg7NsQd1y9UmvIWRcM7cQw/exec";
const STORAGE_PREFIX = "inventory_cache_";

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

let state = {
  roomKey: null,
  roomName: null,
  items: [],
  filteredItems: [],
  query: "",
  lastLoadedAt: null,
  lastSentAt: null
};

// --- DOM参照 ---
const roomLabelEl = document.getElementById("roomLabel");
const statusEl = document.getElementById("status");
const searchInputEl = document.getElementById("searchInput");
const reloadBtnEl = document.getElementById("reloadBtn");
const sendBtnEl = document.getElementById("sendBtn");
const listEl = document.getElementById("list");
const toolbarEl = document.getElementById("toolbar");
const guideEl = document.getElementById("guide");

/** 初期化 */
document.addEventListener("DOMContentLoaded", async () => {
  state.roomKey = getRoomKeyFromUrl();

  if (!state.roomKey || !ROOM_MAP[state.roomKey]) {
    showRoomRequiredState();
    return;
  }

  state.roomName = ROOM_MAP[state.roomKey];
  roomLabelEl.textContent = `対象教室: ${state.roomName}`;
  toolbarEl.classList.remove("hidden");
  guideEl.classList.add("hidden");

  // キャッシュ読込
  const cached = loadCache(state.roomKey);
  if (cached && Array.isArray(cached.items)) {
    state.items = normalizeItems(cached.items);
    state.lastLoadedAt = cached.lastLoadedAt || null;
    state.lastSentAt = cached.lastSentAt || null;
    applyFilterAndRender();
    setStatus("キャッシュを表示中（サーバーと同期します...）");
  }

  await initializeData();

  // イベント登録
  searchInputEl.addEventListener("input", (e) => {
    state.query = e.target.value.trim();
    applyFilterAndRender();
  });

  reloadBtnEl.addEventListener("click", async () => {
    if (confirm("最新データを再取得しますか？（入力中の数値は消去されます）")) {
      await fetchLatestData(true);
    }
  });

  sendBtnEl.addEventListener("click", async () => {
    await sendAllData();
  });
});

/** GASデータとフロント変数のマッピングを修正 (categoryを廃止し subjectへ) */
function normalizeItems(items) {
  return items.map(item => ({
    master: String(item.master || "").trim(),    // マスタ区分
    id: String(item.id || "").trim(),            // 商品コード (B列)
    subject: String(item.subject || "").trim(),  // 科目 (C列)
    name: String(item.name || "").trim(),        // 商品名
    publisher: String(item.publisher || "").trim(), // 出版社
    qty: Math.max(0, Number(item.qty || 0))      // 部数
  })).filter(item => item.id !== ""); // IDなしを除外
}

/** 描画処理：HTML側のCSSクラス (master, subject) に合わせる */
function renderList() {
  if (!state.filteredItems || state.filteredItems.length === 0) {
    listEl.innerHTML = `<div class="empty">該当する教材がありません</div>`;
    return;
  }

  const html = state.filteredItems.map(item => `
    <div class="item">
      <div class="item-main">
        <div class="item-top">
          ${item.master ? `<span class="chip master">${escapeHtml(item.master)}</span>` : ""}
          <span class="chip">${escapeHtml(item.id)}</span>
          ${item.subject ? `<span class="chip subject">${escapeHtml(item.subject)}</span>` : ""}
        </div>
        <div class="item-name">${escapeHtml(item.name)}</div>
        <div class="item-meta">${item.publisher ? `出版社: ${escapeHtml(item.publisher)}` : ""}</div>
      </div>
      <div class="counter">
        <button type="button" class="minus" data-action="minus" data-id="${escapeHtml(item.id)}">－</button>
        <div class="qty">${item.qty}</div>
        <button type="button" data-action="plus" data-id="${escapeHtml(item.id)}">＋</button>
      </div>
    </div>
  `).join("");

  listEl.innerHTML = html;

  // ボタンイベント（バブリングを考慮し確実に個別のIDで動かす）
  listEl.querySelectorAll("button[data-action]").forEach(btn => {
    btn.onclick = () => {
      const { action, id } = btn.dataset;
      action === "plus" ? incrementItem(id) : decrementItem(id);
    };
  });
}

/** 数量変更ロジック (ID一致を厳格に判定) */
function incrementItem(id) {
  const item = state.items.find(x => String(x.id) === String(id));
  if (item) {
    item.qty += 1;
    saveCache(state.roomKey);
    applyFilterAndRender();
  }
}

function decrementItem(id) {
  const item = state.items.find(x => String(x.id) === String(id));
  if (item && item.qty > 0) {
    item.qty -= 1;
    saveCache(state.roomKey);
    applyFilterAndRender();
  }
}

/** 検索処理 (マスタ区分・科目も検索対象) */
function applyFilterAndRender() {
  const q = state.query.toLowerCase();
  state.filteredItems = q 
    ? state.items.filter(i => 
        i.id.toLowerCase().includes(q) || 
        i.name.toLowerCase().includes(q) || 
        i.subject.toLowerCase().includes(q) || 
        i.master.toLowerCase().includes(q) || 
        i.publisher.toLowerCase().includes(q)
      )
    : [...state.items];
  renderList();
}

/** 通信：最新データ取得 */
async function fetchLatestData(manual = false) {
  setStatus(manual ? "最新データ再取得中..." : "最新データ取得中...");
  try {
    const res = await fetch(`${GAS_URL}?type=inventory&room=${encodeURIComponent(state.roomKey)}`, { cache: "no-store" });
    const result = await res.json();

    if (result.success && result.items && result.items.length > 0) {
      state.items = normalizeItems(result.items);
    } else {
      // 在庫が空ならマスタから取得
      const mRes = await fetch(`${GAS_URL}?type=master`, { cache: "no-store" });
      const mResult = await mRes.json();
      state.items = normalizeItems(mResult.items);
    }
    state.lastLoadedAt = new Date().toISOString();
    saveCache(state.roomKey);
    applyFilterAndRender();
    setStatus("サーバーと同期しました");
  } catch (e) {
    console.error(e);
    setStatus("通信エラー：オフラインモード");
  }
}

/** 通信：データ送信 */
async function sendAllData() {
  if (!confirm(`${state.roomName} のデータを送信しますか？`)) return;
  setStatus("送信中...");
  sendBtnEl.disabled = true;

  try {
    const res = await fetch(GAS_URL, {
      method: "POST",
      body: JSON.stringify({ room: state.roomKey, items: state.items })
    });
    const result = await res.json();
    if (!result.success) throw new Error(result.message);

    state.lastSentAt = new Date().toISOString();
    saveCache(state.roomKey);
    setStatus(`送信成功: ${formatDateTime(state.lastSentAt)}`);
    alert("送信完了しました");
  } catch (e) {
    alert("送信失敗: " + e.message);
    setStatus("送信失敗（キャッシュに保存済み）");
  } finally {
    sendBtnEl.disabled = false;
  }
}

/** 補助関数群 */
async function initializeData() { await fetchLatestData(false); }
function showRoomRequiredState() { guideEl.classList.remove("hidden"); setStatus("教室を選択してください"); }
function getRoomKeyFromUrl() { return new URLSearchParams(window.location.search).get("room")?.toLowerCase(); }
function loadCache(key) { const c = localStorage.getItem(STORAGE_PREFIX + key); return c ? JSON.parse(c) : null; }
function saveCache(key) { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify({ items: state.items, lastLoadedAt: state.lastLoadedAt, lastSentAt: state.lastSentAt })); }
function setStatus(msg) { const t = new Date().toLocaleTimeString("ja-JP"); statusEl.textContent = `[${t}] ${msg}`; }
function formatDateTime(v) { return v ? new Date(v).toLocaleString("ja-JP") : ""; }
function escapeHtml(s) { return String(s || "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }
