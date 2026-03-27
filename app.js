/**
 * ================================================================
 * 在庫カウント アプリケーション (高速起動版)
 * ================================================================
 */

const GAS_URL = "https://script.google.com/macros/s/AKfycbzoWI5gWRgnluVkSBpNT7E29Q-bHyFch-VzyFXnaQn3OPJ6Wg7NsQd1y9UmvIWRcM7cQw/exec";
const STORAGE_PREFIX = "inventory_cache_";

const ROOM_MAP = {
  "takadanobaba": "高田馬場", "sugamo": "巣鴨", "nishinippori": "西日暮里",
  "ohji": "王子", "itabashi": "板橋", "minamisenju": "南千住",
  "kiba": "木場", "gakuin": "学院"
};

let state = {
  roomKey: null, items: [], filteredItems: [], query: "",
  isSyncing: false
};

// DOM要素
const roomLabelEl = document.getElementById("roomLabel");
const statusEl = document.getElementById("status");
const searchInputEl = document.getElementById("searchInput");
const listEl = document.getElementById("list");
const toolbarEl = document.getElementById("toolbar");
const guideEl = document.getElementById("guide");

document.addEventListener("DOMContentLoaded", () => {
  state.roomKey = new URLSearchParams(window.location.search).get("room")?.toLowerCase();

  if (!state.roomKey || !ROOM_MAP[state.roomKey]) {
    guideEl.classList.remove("hidden");
    setStatus("教室を選択してください");
    return;
  }

  // 1. 【高速化】UIを即座に構築
  roomLabelEl.textContent = `対象教室: ${ROOM_MAP[state.roomKey]}`;
  toolbarEl.classList.remove("hidden");
  guideEl.classList.add("hidden");

  // 2. 【高速化】サーバーを待たずにキャッシュを即表示
  const cached = localStorage.getItem(STORAGE_PREFIX + state.roomKey);
  if (cached) {
    const data = JSON.parse(cached);
    state.items = data.items || [];
    applyFilterAndRender();
    setStatus("キャッシュを表示中（背後で同期中...）");
  } else {
    listEl.innerHTML = `<div class="empty">データを読み込んでいます...</div>`;
  }

  // 3. 裏でこっそりサーバーと同期
  fetchLatestData();

  // イベント登録
  searchInputEl.addEventListener("input", (e) => {
    state.query = e.target.value.trim();
    applyFilterAndRender();
  });

  document.getElementById("reloadBtn").onclick = () => {
    if (confirm("最新データを再取得しますか？")) fetchLatestData(true);
  };

  document.getElementById("sendBtn").onclick = sendAllData;
});

/** 描画の最適化: 書き換え回数を最小限に */
function renderList() {
  if (state.items.length === 0 && !state.isSyncing) {
    listEl.innerHTML = `<div class="empty">データがありません。[再取得]を試してください。</div>`;
    return;
  }

  // 文字列結合を高速化
  const fragments = state.filteredItems.map(item => `
    <div class="item">
      <div class="item-main">
        <div class="item-top">
          ${item.master ? `<span class="chip master">${escapeHtml(item.master)}</span>` : ""}
          ${item.subject ? `<span class="chip subject">${escapeHtml(item.subject)}</span>` : ""}
          <span class="chip">${escapeHtml(item.id)}</span>
        </div>
        <div class="item-name">${escapeHtml(item.name)}</div>
        <div class="item-meta">${item.publisher ? `出版社: ${escapeHtml(item.publisher)}` : ""}</div>
      </div>
      <div class="counter">
        <button type="button" class="minus" data-id="${escapeHtml(item.id)}">－</button>
        <div class="qty">${item.qty}</div>
        <button type="button" class="plus" data-id="${escapeHtml(item.id)}">＋</button>
      </div>
    </div>
  `).join("");

  listEl.innerHTML = fragments;

  // イベント一括登録（メモリ効率化）
  listEl.onclick = (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    
    const id = btn.dataset.id;
    const isPlus = btn.classList.contains("plus");
    const item = state.items.find(x => String(x.id) === String(id));
    
    if (item) {
      item.qty = isPlus ? item.qty + 1 : Math.max(0, item.qty - 1);
      const qtyDisplay = btn.parentElement.querySelector(".qty");
      if (qtyDisplay) qtyDisplay.textContent = item.qty; // 部分書き換えで高速化
      saveCache();
    }
  };
}

/** データの同期（非同期で実行） */
async function fetchLatestData(manual = false) {
  if (state.isSyncing) return;
  state.isSyncing = true;
  if (manual) setStatus("最新データ取得中...");

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15秒でタイムアウト

    const res = await fetch(`${GAS_URL}?type=inventory&room=${encodeURIComponent(state.roomKey)}`, {
      signal: controller.signal
    });
    const result = await res.json();
    clearTimeout(timeoutId);

    if (result.success && result.items?.length > 0) {
      state.items = normalizeItems(result.items);
    } else {
      // 在庫がなければマスタを取得
      const mRes = await fetch(`${GAS_URL}?type=master`);
      const mResult = await mRes.json();
      state.items = normalizeItems(mResult.items);
    }
    
    saveCache();
    applyFilterAndRender();
    setStatus("同期完了");
  } catch (e) {
    console.error(e);
    setStatus("オフライン表示中");
  } finally {
    state.isSyncing = false;
  }
}

/** 検索処理の高速化 */
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
  renderList();
}

/** 送信処理 */
async function sendAllData() {
  const btn = document.getElementById("sendBtn");
  if (!confirm("送信しますか？")) return;
  
  btn.disabled = true;
  setStatus("送信中...");
  
  try {
    const res = await fetch(GAS_URL, {
      method: "POST",
      body: JSON.stringify({ room: state.roomKey, items: state.items })
    });
    const result = await res.json();
    if (!result.success) throw new Error();
    setStatus("送信成功");
    alert("送信完了！");
  } catch (e) {
    alert("送信に失敗しました。電波の良い所で再度お試しください。");
    setStatus("送信失敗");
  } finally {
    btn.disabled = false;
  }
}

// 補助関数
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
function saveCache() { localStorage.setItem(STORAGE_PREFIX + state.roomKey, JSON.stringify({ items: state.items })); }
function setStatus(msg) { statusEl.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`; }
function escapeHtml(s) { return String(s || "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }
