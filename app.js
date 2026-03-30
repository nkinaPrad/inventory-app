/**
 * ==================================================================================
 * 1. 定数・設定セクション
 * ==================================================================================
 */

// GAS Web AppのURL
const APP_ID = "AKfycbwK-FB7GtWyVsU7aalWfryBk_4oNHqWy2c2PpBwhE5ioIXQEv0WpuP9pX-z0X0Wqqa8AA";
const GAS_URL = `https://script.google.com/macros/s/${APP_ID}/exec`;

// ローカルストレージ用の名前空間
const STORAGE_PREFIX = "inventory_cache_";

// 一度に描画する件数
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
  roomTimestamp: ""
};

// 初回同期時の基準値
// id => qty
let baselineQtyMap = {};

// 変更された商品コードを保持
let changedIds = new Set();

// デバウンス用タイマー
let cacheSaveTimer = null;

/**
 * ==================================================================================
 * 3. DOM参照
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
 * 4. 初期化
 * ==================================================================================
 */
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

  loadCacheAndRender_();
  fetchLatestData();

  searchInputEl.addEventListener("input", (e) => {
    state.query = e.target.value.trim();
    state.displayLimit = INITIAL_RENDER_COUNT;
    applyFilterAndRender();
  });

  document.getElementById("reloadBtn").addEventListener("click", () => {
    if (confirm("最新データを再取得しますか？")) fetchLatestData(true);
  });

  document.getElementById("sendBtn").addEventListener("click", sendChangedData);

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

    markItemAsChanged_(item);

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
 * 5. 初期表示・取得
 * ==================================================================================
 */
function loadCacheAndRender_() {
  const cached = localStorage.getItem(STORAGE_PREFIX + state.roomKey);

  if (!cached) {
    listEl.innerHTML = `<div class="empty">データを読み込んでいます...</div>`;
    return;
  }

  try {
    const data = JSON.parse(cached);
    state.items = normalizeItems(data.items || []);
    state.roomTimestamp = String(data.roomTimestamp || "");

    baselineQtyMap = buildQtyMap_(state.items);
    changedIds = new Set();

    applyFilterAndRender();
    setStatus("キャッシュを表示中（背後で同期中...）");
  } catch (e) {
    console.error(e);
    listEl.innerHTML = `<div class="empty">データを読み込んでいます...</div>`;
  }
}

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
    state.roomTimestamp = String(result.roomTimestamp || "");

    baselineQtyMap = buildQtyMap_(state.items);
    changedIds = new Set();

    saveCacheNow();
    applyFilterAndRender();

    const tsText = state.roomTimestamp ? ` / 最終更新: ${formatDateTime_(state.roomTimestamp)}` : "";
    setStatus(`同期完了${tsText}`);
  } catch (e) {
    console.error(e);
    setStatus("オフライン表示中");
  } finally {
    state.isSyncing = false;
  }
}

/**
 * ==================================================================================
 * 6. 描画・検索
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
          ${changedIds.has(item.id) ? `<span class="chip" style="background:#fff8e1;color:#8d6e63;">未送信</span>` : ""}
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
    const dirtyCount = changedIds.size;
    const dirtyText = dirtyCount > 0 ? ` / 未送信 ${dirtyCount}件` : "";
    countInfoEl.textContent = `${visible} / ${total}件を表示${dirtyText}`;
  }

  if (!state.query && state.filteredItems.length > state.visibleItems.length) {
    loadMoreWrapEl.classList.remove("hidden");
  } else {
    loadMoreWrapEl.classList.add("hidden");
  }
}

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

function applyVisibleItems_() {
  if (state.query) {
    state.visibleItems = state.filteredItems;
  } else {
    state.visibleItems = state.filteredItems.slice(0, state.displayLimit);
  }
}

/**
 * ==================================================================================
 * 7. 送信処理（差分送信）
 * ==================================================================================
 */
async function sendChangedData() {
  const btn = document.getElementById("sendBtn");

  if (changedIds.size === 0) {
    alert("未送信の変更はありません。");
    return;
  }

  if (!confirm(`変更分 ${changedIds.size} 件を送信しますか？`)) return;

  saveCacheNow();

  const changedItems = state.items
    .filter(item => changedIds.has(item.id))
    .map(item => ({
      id: item.id,
      qty: item.qty
    }));

  btn.disabled = true;
  setStatus("送信中...");

  try {
    const res = await fetch(GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room: state.roomKey,
        changedItems: changedItems
      })
    });

    const result = await res.json();
    if (!result.success) throw new Error(result.message || "送信失敗");

    // 送信成功後、基準値を更新
    changedItems.forEach(item => {
      baselineQtyMap[item.id] = item.qty;
    });
    changedIds.clear();

    state.roomTimestamp = String(result.roomTimestamp || state.roomTimestamp);
    saveCacheNow();
    applyFilterAndRender();

    const tsText = state.roomTimestamp ? ` / 最終更新: ${formatDateTime_(state.roomTimestamp)}` : "";
    setStatus(`送信成功${tsText}`);
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
 * 8. 変更追跡
 * ==================================================================================
 */
function markItemAsChanged_(item) {
  const baseQty = Number(baselineQtyMap[item.id] || 0);

  if (item.qty === baseQty) {
    changedIds.delete(item.id);
  } else {
    changedIds.add(item.id);
  }
}

function updateDirtyStatus_() {
  const dirtyCount = changedIds.size;
  if (dirtyCount === 0) {
    setStatus("編集中
