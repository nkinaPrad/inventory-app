/**
 * ==================================================================================
 * 1. 定数・設定セクション
 * ==================================================================================
 */

// GAS Web AppのURL
const APP_ID = "AKfycbx_u7dfc0xHyxOSQ64N3vNLkzqRO0uE-X8VGenwpQaSpX8_jas9ZbZHiQ1y4-Pw7L-ulA";
const GAS_URL = `https://script.google.com/macros/s/${APP_ID}/exec`;

// ローカルストレージ用の名前空間
const STORAGE_PREFIX = "inventory_cache_";

// 表示件数
const INITIAL_RENDER_COUNT = 50;
const RENDER_STEP = 50;

// キャッシュ保存の遅延時間
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
 * 2. 状態管理
 * ==================================================================================
 */
let state = {
  roomKey: null,
  items: [],
  filteredItems: [],
  visibleItems: [],
  query: "",
  isSyncing: false,
  displayLimit: INITIAL_RENDER_COUNT,
  updatedAt: "",
  originalQtyMap: {} // 初回取得時点 or 送信成功時点の数量
};

let cacheSaveTimer = null;

/**
 * ==================================================================================
 * 3. 初期化
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
  state.roomKey = new URLSearchParams(window.location.search).get("room")?.toLowerCase();

  if (!state.roomKey || !ROOM_MAP[state.roomKey]) {
    guideEl.classList.remove("hidden");
    setStatus("教室を選択してください");
    return;
  }

  roomLabelEl.textContent = `対象教室: ${ROOM_MAP[state.roomKey]}`;
  toolbarEl.classList.remove("hidden");
  guideEl.classList.add("hidden");

  // キャッシュ表示
  const cached = localStorage.getItem(STORAGE_PREFIX + state.roomKey);
  if (cached) {
    try {
      const data = JSON.parse(cached);
      state.items = normalizeItems(data.items || []);
      state.updatedAt = String(data.updatedAt || "");
      state.originalQtyMap = buildQtyMap(state.items);

      applyFilterAndRender();
      setStatus(buildStatusMessage_("キャッシュを表示中（背後で同期中...）"));
    } catch (e) {
      listEl.innerHTML = `<div class="empty">データを読み込んでいます...</div>`;
    }
  } else {
    listEl.innerHTML = `<div class="empty">データを読み込んでいます...</div>`;
  }

  fetchLatestData();

  searchInputEl.addEventListener("input", (e) => {
    state.query = e.target.value.trim();
    state.displayLimit = INITIAL_RENDER_COUNT;
    applyFilterAndRender();
  });

  document.getElementById("reloadBtn").addEventListener("click", () => {
    if (confirm("最新データを再取得しますか？")) fetchLatestData(true);
  });

  document.getElementById("sendBtn").addEventListener("click", sendAllData);

  loadMoreBtnEl.addEventListener("click", () => {
    state.displayLimit += RENDER_STEP;
    applyVisibleItems_();
    renderList();
  });

  listEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;

    const idx = Number(btn.dataset.index);
    if (Number.isNaN(idx)) return;

    const item = state.visibleItems[idx];
    if (!item) return;

    if (btn.classList.contains("plus")) {
      item.qty += 1;
    } else if (btn.classList.contains("minus")) {
      item.qty = Math.max(0, item.qty - 1);
    } else {
      return;
    }

    const itemCard = btn.closest(".item");
    if (itemCard) {
      const qtyDisplay = itemCard.querySelector(".qty");
      if (qtyDisplay) qtyDisplay.textContent = item.qty;
    }

    updateDirtyStatus_();
    scheduleCacheSave();
  });
});

/**
 * ==================================================================================
 * 4. 描画・フィルタリング
 * ==================================================================================
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

  const total = state.filteredItems.length;
  const visible = state.visibleItems.length;

  if (state.query) {
    countInfoEl.textContent = `${total}件ヒット`;
  } else {
    countInfoEl.textContent = `${visible} / ${total}件を表示`;
  }

  if (!state.query && state.filteredItems.length > state.visibleItems.length) {
    loadMoreWrapEl.classList.remove("hidden");
  } else {
    loadMoreWrapEl.classList.add("hidden");
  }
}

/**
 * 最新データ取得
 */
async function fetchLatestData() {
  if (state.isSyncing) return;
  state.isSyncing = true;
  setStatus("最新データ取得中...");

  try {
    const [masterRes, inventoryRes] = await Promise.all([
      fetch(`${GAS_URL}?type=master`),
      fetch(`${GAS_URL}?type=inventory&room=${encodeURIComponent(state.roomKey)}`)
    ]);

    const masterResult = await masterRes.json();
    const inventoryResult = await inventoryRes.json();

    if (!masterResult.success) throw new Error(masterResult.message || "マスタ取得失敗");
    if (!inventoryResult.success) throw new Error(inventoryResult.message || "在庫取得失敗");

    const qtyMap = {};
    (inventoryResult.items || []).forEach(item => {
      qtyMap[item.id] = item.qty;
    });

    state.items = (masterResult.items || []).map(item => ({
      master: String(item.master || "").trim(),
      id: String(item.id || "").trim(),
      subject: String(item.subject || "").trim(),
      name: String(item.name || "").trim(),
      publisher: String(item.publisher || "").trim(),
      qty: Math.max(0, Number(qtyMap[item.id] || 0))
    }));

    state.updatedAt = String(inventoryResult.updatedAt || "");
    state.originalQtyMap = buildQtyMap(state.items);

    saveCacheNow();
    applyFilterAndRender();
    setStatus(buildStatusMessage_("同期完了"));
  } catch (e) {
    console.error(e);
    setStatus(`取得失敗: ${e.message}`);
    listEl.innerHTML = `<div class="empty">取得失敗: ${escapeHtml(e.message)}</div>`;
  } finally {
    state.isSyncing = false;
  }
}

/**
 * 検索キーワードに基づいてフィルタ
 */
function applyFilterAndRender() {
  const q = state.query.toLowerCase();

  if (!q) {
    state.filteredItems = state.items;
  } else {
    state.filteredItems = state.items.filter(i =>
      i.id.toLowerCase().includes(q) ||
      i.name.toLowerCase().includes(q) ||
      i.subject.toLowerCase().includes(q) ||
      i.publisher.toLowerCase().includes(q) ||
      i.master.toLowerCase().includes(q)
    );
  }

  applyVisibleItems_();
  renderList();
}

/**
 * 表示上限に応じて visibleItems を更新
 */
function applyVisibleItems_() {
  if (state.query) {
    state.visibleItems = state.filteredItems;
  } else {
    state.visibleItems = state.filteredItems.slice(0, state.displayLimit);
  }
}

/**
 * 差分送信
 */
async function sendAllData() {
  const btn = document.getElementById("sendBtn");
  if (!confirm("送信しますか？")) return;

  const changedItems = getChangedItems_();
  if (changedItems.length === 0) {
    alert("変更されたデータがありません。");
    setStatus(buildStatusMessage_("未送信（変更なし）"));
    return;
  }

  saveCacheNow();

  btn.disabled = true;
  setStatus(`送信中...（${changedItems.length}件）`);

  try {
    const body = new URLSearchParams();
    body.append("room", state.roomKey);
    body.append("changedItems", JSON.stringify(changedItems));

    const res = await fetch(GAS_URL, {
      method: "POST",
      body: body
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const result = await res.json();
    if (!result.success) throw new Error(result.message || "送信失敗");

    state.updatedAt = String(result.updatedAt || "");
    state.originalQtyMap = buildQtyMap(state.items);
    saveCacheNow();

    setStatus(buildStatusMessage_(`送信成功（${changedItems.length}件更新）`));
    alert("送信完了！");
  } catch (e) {
    console.error(e);
    alert(`送信に失敗しました: ${e.message}`);
    setStatus(buildStatusMessage_(`送信失敗: ${e.message}`));
  } finally {
    btn.disabled = false;
  }
}

/**
 * ==================================================================================
 * 5. ユーティリティ・キャッシュ関連
 * ==================================================================================
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

function buildQtyMap(items) {
  const map = {};
  items.forEach(item => {
    map[item.id] = item.qty;
  });
  return map;
}

function getChangedItems_() {
  return state.items
    .filter(item => {
      const originalQty = Object.prototype.hasOwnProperty.call(state.originalQtyMap, item.id)
        ? state.originalQtyMap[item.id]
        : 0;
      return item.qty !== originalQty;
    })
    .map(item => ({
      id: item.id,
      qty: item.qty
    }));
}

function updateDirtyStatus_() {
  const changedCount = getChangedItems_().length;
  if (changedCount > 0) {
    setStatus(buildStatusMessage_(`未送信の変更あり（${changedCount}件）`));
  } else {
    setStatus(buildStatusMessage_("変更なし"));
  }
}

function scheduleCacheSave() {
  if (cacheSaveTimer) clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    saveCacheNow();
  }, CACHE_SAVE_DELAY);
}

function saveCacheNow() {
  localStorage.setItem(
    STORAGE_PREFIX + state.roomKey,
    JSON.stringify({
      items: state.items,
      updatedAt: state.updatedAt
    })
  );

  if (cacheSaveTimer) {
    clearTimeout(cacheSaveTimer);
    cacheSaveTimer = null;
  }
}

function buildStatusMessage_(message) {
  if (state.updatedAt) {
    return `${message} / 最終更新: ${formatDateTime_(state.updatedAt)}`;
  }
  return message;
}

function formatDateTime_(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return isoString;
  return d.toLocaleString("ja-JP");
}

function setStatus(msg) {
  statusEl.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, m => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[m]));
}
