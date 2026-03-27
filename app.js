// ================================
// 設定
// ================================

// GASのWebアプリURL
const GAS_URL = "https://script.google.com/macros/s/AKfycbzoWI5gWRgnluVkSBpNT7E29Q-bHyFch-VzyFXnaQn3OPJ6Wg7NsQd1y9UmvIWRcM7cQw/exec";

// localStorageのキー接頭辞
const STORAGE_PREFIX = "inventory_cache_";

// アプリ状態
let state = {
  room: null,
  items: [],
  filteredItems: [],
  query: "",
  lastLoadedAt: null,
  lastSentAt: null
};

// DOM参照
const roomLabelEl = document.getElementById("roomLabel");
const statusEl = document.getElementById("status");
const searchInputEl = document.getElementById("searchInput");
const reloadBtnEl = document.getElementById("reloadBtn");
const sendBtnEl = document.getElementById("sendBtn");
const listEl = document.getElementById("list");
const toolbarEl = document.getElementById("toolbar");
const guideEl = document.getElementById("guide");

// ================================
// 初期化
// ================================

document.addEventListener("DOMContentLoaded", async () => {
  state.room = getRoomFromUrl();

  if (!state.room) {
    showRoomRequiredState();
    return;
  }

  roomLabelEl.textContent = `対象教室: ${state.room}`;
  toolbarEl.classList.remove("hidden");
  guideEl.classList.add("hidden");

  // まずはローカルキャッシュを表示
  const cached = loadCache(state.room);
  if (cached && Array.isArray(cached.items)) {
    state.items = normalizeItems(cached.items);
    state.lastLoadedAt = cached.lastLoadedAt || null;
    state.lastSentAt = cached.lastSentAt || null;
    applyFilterAndRender();
    setStatus("ローカルキャッシュを表示中");
  }

  // 起動時はGASから最新取得
  await initializeData();

  // 検索イベント
  searchInputEl.addEventListener("input", (e) => {
    state.query = e.target.value.trim();
    applyFilterAndRender();
  });

  // 再取得ボタン
  reloadBtnEl.addEventListener("click", async () => {
    await fetchLatestData(true);
  });

  // 送信ボタン
  sendBtnEl.addEventListener("click", async () => {
    await sendAllData();
  });
});

// ================================
// 画面状態
// ================================

function showRoomRequiredState() {
  roomLabelEl.textContent = "対象教室: 未指定";
  toolbarEl.classList.add("hidden");
  guideEl.classList.remove("hidden");
  listEl.innerHTML = "";
  setStatus("room パラメータがありません");
}

// ================================
// URL / localStorage
// ================================

function getRoomFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const room = (params.get("room") || "").trim();
  return room || null;
}

function getStorageKey(room) {
  return `${STORAGE_PREFIX}${room}`;
}

function loadCache(room) {
  try {
    const raw = localStorage.getItem(getStorageKey(room));
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error("キャッシュ読込エラー:", error);
    return null;
  }
}

function saveCache(room) {
  const payload = {
    items: state.items,
    lastLoadedAt: state.lastLoadedAt,
    lastSentAt: state.lastSentAt,
    cachedAt: new Date().toISOString()
  };

  try {
    localStorage.setItem(getStorageKey(room), JSON.stringify(payload));
  } catch (error) {
    console.error("キャッシュ保存エラー:", error);
  }
}

// ================================
// 初期データ取得
// ================================

async function initializeData() {
  try {
    await fetchLatestData(false);
  } catch (error) {
    console.error(error);

    if (!state.items || state.items.length === 0) {
      setStatus("通信失敗。データを取得できませんでした");
      listEl.innerHTML = `<div class="empty">データを取得できませんでした</div>`;
    } else {
      setStatus("通信失敗のためローカルキャッシュを使用中");
    }
  }
}

async function fetchLatestData(manual = false) {
  setStatus(manual ? "最新データ再取得中..." : "最新データ取得中...");

  const response = await fetch(`${GAS_URL}?type=inventory&room=${encodeURIComponent(state.room)}`, {
    method: "GET",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`GET失敗: ${response.status}`);
  }

  const result = await response.json();

  if (result && Array.isArray(result.items) && result.items.length > 0) {
    state.items = normalizeItems(result.items);
    state.lastLoadedAt = result.timestamp || new Date().toISOString();
    saveCache(state.room);
    applyFilterAndRender();
    setStatus("サーバの最新データを取得しました");
    return;
  }

  // 在庫データが空なら教材マスタから初期化
  await loadMasterItems();
  setStatus("在庫データがないため教材マスタを読み込みました");
}

async function loadMasterItems() {
  const response = await fetch(`${GAS_URL}?type=master`, {
    method: "GET",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`教材マスタ取得失敗: ${response.status}`);
  }

  const result = await response.json();

  if (!result.success || !Array.isArray(result.items)) {
    throw new Error("教材マスタの取得に失敗しました");
  }

  state.items = normalizeItems(result.items);
  state.lastLoadedAt = result.timestamp || new Date().toISOString();
  saveCache(state.room);
  applyFilterAndRender();
}

// ================================
// データ送信
// ================================

async function sendAllData() {
  if (!state.room) {
    alert("教室が指定されていません。");
    return;
  }

  setStatus("送信中...");

  const payload = {
    room: state.room,
    items: state.items
  };

  try {
    const response = await fetch(GAS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`POST失敗: ${response.status}`);
    }

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.message || "送信に失敗しました");
    }

    state.lastSentAt = result.timestamp || new Date().toISOString();
    state.lastLoadedAt = state.lastSentAt;
    saveCache(state.room);

    setStatus(`送信成功: ${formatDateTime(state.lastSentAt)}`);
  } catch (error) {
    console.error(error);
    setStatus("送信失敗。オフラインのまま継続可能です");
    alert("送信に失敗しました。通信環境をご確認ください。");
  }
}

// ================================
// 数量操作
// ================================

function incrementItem(id) {
  const item = state.items.find(x => x.id === id);
  if (!item) return;

  item.qty += 1;
  saveCache(state.room);
  applyFilterAndRender();
}

function decrementItem(id) {
  const item = state.items.find(x => x.id === id);
  if (!item) return;

  if (item.qty <= 0) return;

  item.qty -= 1;
  saveCache(state.room);
  applyFilterAndRender();
}

// ================================
// 検索
// ================================

function applyFilterAndRender() {
  const q = state.query.toLowerCase();

  if (!q) {
    state.filteredItems = [...state.items];
  } else {
    state.filteredItems = state.items.filter(item =>
      (item.id || "").toLowerCase().includes(q) ||
      (item.category || "").toLowerCase().includes(q) ||
      (item.name || "").toLowerCase().includes(q) ||
      (item.publisher || "").toLowerCase().includes(q)
    );
  }

  renderList();
}

// ================================
// 描画
// ================================

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
          ${item.category ? `<span class="chip">${escapeHtml(item.category)}</span>` : ""}
        </div>
        <div class="item-name">${escapeHtml(item.name)}</div>
        <div class="item-meta">
          ${item.publisher ? `出版社: ${escapeHtml(item.publisher)}` : ""}
        </div>
      </div>

      <div class="counter">
        <button class="minus" data-action="minus" data-id="${escapeHtml(item.id)}">－</button>
        <div class="qty">${item.qty}</div>
        <button data-action="plus" data-id="${escapeHtml(item.id)}">＋</button>
      </div>
    </div>
  `).join("");

  listEl.innerHTML = html;

  listEl.querySelectorAll("button[data-action]").forEach(button => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      const id = button.dataset.id;

      if (action === "plus") {
        incrementItem(id);
      } else if (action === "minus") {
        decrementItem(id);
      }
    });
  });
}

// ================================
// ユーティリティ
// ================================

function normalizeItems(items) {
  return items.map(item => ({
    id: String(item.id || ""),
    category: String(item.category || ""),
    name: String(item.name || ""),
    publisher: String(item.publisher || ""),
    qty: Math.max(0, Number(item.qty || item.quantity || 0))
  }));
}

function setStatus(message) {
  const now = new Date();
  const time = now.toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  statusEl.textContent = `[${time}] ${message}`;
}

function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleString("ja-JP");
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
