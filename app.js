/**
 * ================================================================
 * 在庫カウント アプリケーション フロントエンド (完全版)
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
  lastLoadedAt: null, lastSentAt: null
};

// DOM要素
const roomLabelEl = document.getElementById("roomLabel");
const statusEl = document.getElementById("status");
const searchInputEl = document.getElementById("searchInput");
const reloadBtnEl = document.getElementById("reloadBtn");
const sendBtnEl = document.getElementById("sendBtn");
const listEl = document.getElementById("list");
const toolbarEl = document.getElementById("toolbar");
const guideEl = document.getElementById("guide");

document.addEventListener("DOMContentLoaded", async () => {
  state.roomKey = new URLSearchParams(window.location.search).get("room")?.toLowerCase();

  if (!state.roomKey || !ROOM_MAP[state.roomKey]) {
    guideEl.classList.remove("hidden");
    setStatus("教室を選択してください");
    return;
  }

  roomLabelEl.textContent = `対象教室: ${ROOM_MAP[state.roomKey]}`;
  toolbarEl.classList.remove("hidden");
  guideEl.classList.add("hidden");

  // キャッシュ復元
  const cached = JSON.parse(localStorage.getItem(STORAGE_PREFIX + state.roomKey) || "{}");
  if (cached.items) {
    state.items = normalizeItems(cached.items);
    applyFilterAndRender();
    setStatus("キャッシュを表示中");
  }

  await fetchLatestData();

  searchInputEl.addEventListener("input", (e) => {
    state.query = e.target.value.trim();
    applyFilterAndRender();
  });

  reloadBtnEl.addEventListener("click", () => {
    if (confirm("最新データを再取得しますか？")) fetchLatestData(true);
  });

  sendBtnEl.addEventListener("click", sendAllData);
});

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

function renderList() {
  if (state.filteredItems.length === 0) {
    listEl.innerHTML = `<div class="empty">該当なし</div>`;
    return;
  }

  listEl.innerHTML = state.filteredItems.map(item => `
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
        <button type="button" class="minus" data-id="${escapeHtml(item.id)}">－</button>
        <div class="qty">${item.qty}</div>
        <button type="button" class="plus" data-id="${escapeHtml(item.id)}">＋</button>
      </div>
    </div>
  `).join("");

  // イベント登録
  listEl.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      const isPlus = btn.classList.contains("plus");
      const id = btn.dataset.id;
      const item = state.items.find(x => String(x.id) === String(id));
      if (item) {
        item.qty = isPlus ? item.qty + 1 : Math.max(0, item.qty - 1);
        saveCache();
        applyFilterAndRender();
      }
    };
  });
}

async function fetchLatestData(manual = false) {
  setStatus("同期中...");
  try {
    const res = await fetch(`${GAS_URL}?type=inventory&room=${encodeURIComponent(state.roomKey)}`);
    const result = await res.json();
    if (result.success && result.items?.length > 0) {
      state.items = normalizeItems(result.items);
    } else {
      const mRes = await fetch(`${GAS_URL}?type=master`);
      const mResult = await mRes.json();
      state.items = normalizeItems(mResult.items);
    }
    saveCache();
    applyFilterAndRender();
    setStatus("最新状態です");
  } catch (e) {
    setStatus("通信エラー（オフライン）");
  }
}

async function sendAllData() {
  if (!confirm("送信しますか？")) return;
  setStatus("送信中...");
  try {
    const res = await fetch(GAS_URL, {
      method: "POST",
      body: JSON.stringify({ room: state.roomKey, items: state.items })
    });
    const result = await res.json();
    if (!result.success) throw new Error();
    setStatus("送信成功しました");
    alert("送信完了！");
  } catch (e) {
    alert("送信失敗しました");
    setStatus("送信エラー");
  }
}

function applyFilterAndRender() {
  const q = state.query.toLowerCase();
  state.filteredItems = state.items.filter(i => 
    i.id.toLowerCase().includes(q) || i.name.toLowerCase().includes(q) || i.subject.toLowerCase().includes(q)
  );
  renderList();
}

function saveCache() { localStorage.setItem(STORAGE_PREFIX + state.roomKey, JSON.stringify({ items: state.items })); }
function setStatus(msg) { statusEl.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`; }
function escapeHtml(s) { return String(s || "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }
