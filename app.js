// ================================
// 設定
// ================================

// GASのWebアプリURLに差し替えてください
const GAS_URL = "https://script.google.com/macros/s/AKfycbzqkOFekM__viIWAOCeeUSVnMCqJUXvOK0zxY4vkSW4AgXUnl_EWwDP5rqskScEeWbo/exec";

// URLパラメータ room の初期値
const DEFAULT_ROOM = "room1";

// localStorageのキー接頭辞
const STORAGE_PREFIX = "inventory_cache_";

// アプリ状態
let state = {
  room: DEFAULT_ROOM,
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

// ================================
// 初期化
// ================================

document.addEventListener("DOMContentLoaded", async () => {
  // URLから教室IDを取得
  state.room = getRoomFromUrl();
  roomLabelEl.textContent = `対象教室: ${state.room}`;

  // まずはローカルキャッシュを表示
  const cached = loadCache(state.room);
  if (cached && Array.isArray(cached.items)) {
    state.items = cached.items;
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
// URL / localStorage
// ================================

function getRoomFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get("room");
  return room ? room : DEFAULT_ROOM;
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

    // GAS取得失敗時、まだ何もなければ data.json を読む
    if (!state.items || state.items.length === 0) {
      await loadInitialJson();
      setStatus("オフラインのため初期データを読み込みました");
    } else {
      setStatus("通信失敗のためローカルキャッシュを使用中");
    }
  }
}

async function fetchLatestData(manual = false) {
  setStatus(manual ? "最新データ再取得中..." : "最新データ取得中...");

  const response = await fetch(`${GAS_URL}?room=${encodeURIComponent(state.room)}`, {
    method: "GET",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`GET失敗: ${response.status}`);
  }

  const result = await response.json();

  // GASにデータがある場合はそれを正とする
  if (result && Array.isArray(result.items) && result.items.length > 0) {
    state.items = normalizeItems(result.items);
    state.lastLoadedAt = result.timestamp || new Date().toISOString();
    saveCache(state.room);
    applyFilterAndRender();
    setStatus("サーバの最新データを取得しました");
    return;
  }

  // GASが空なら data.json を読み込む
  await loadInitialJson();
  setStatus("サーバにデータがないため初期データを読み込みました");
}

async function loadInitialJson() {
  const response = await fetch("./data.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`data.json読込失敗: ${response.status}`);
  }

  const items = await response.json();
  state.items = normalizeItems(items);
  state.lastLoadedAt = new Date().toISOString();
  saveCache(state.room);
  applyFilterAndRender();
}

// ================================
// データ送信
// ================================

async function sendAllData() {
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
      // GAS側で JSON.parse(e.postData.contents) する
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

    // 送信成功後の状態をキャッシュへ保存
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

  // 即時反映
  item.qty += 1;

  // localStorageへ即保存
  saveCache(state.room);

  // 再描画
  applyFilterAndRender();
}

function decrementItem(id) {
  const item = state.items.find(x => x.id === id);
  if (!item) return;

  // 0未満禁止
  if (item.qty <= 0) return;

  // 即時反映
  item.qty -= 1;

  // localStorageへ即保存
  saveCache(state.room);

  // 再描画
  applyFilterAndRender();
}

// ================================
// 検索
// ================================

function applyFilterAndRender() {
  const q = state.query.toLowerCase();

  if (!q) {
    state.filteredItems = state.items;
  } else {
    state.filteredItems = state.items.filter(item =>
      item.name.toLowerCase().includes(q)
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
      <div class="item-name">${escapeHtml(item.name)}</div>
      <div class="counter">
        <button class="minus" data-action="minus" data-id="${escapeHtml(item.id)}">－</button>
        <div class="qty">${item.qty}</div>
        <button data-action="plus" data-id="${escapeHtml(item.id)}">＋</button>
      </div>
    </div>
  `).join("");

  listEl.innerHTML = html;

  // イベント委譲
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
    id: String(item.id),
    name: String(item.name),
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
