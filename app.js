/**
 * ==================================================================================
 * 1. 定数・設定
 * ==================================================================================
 */

const APP_ID = "AKfycbwAVn5ftZbhxmKQRfjjbrzUceS6UuLMWEVw7_t-OdQh-Zs4ZsvrMHwi9cFIJGiyaXw4GA";
const GAS_URL = `https://script.google.com/macros/s/${APP_ID}/exec`;

const STORAGE_PREFIX = "inventory_cache_";
const INITIAL_RENDER_COUNT = 50;
const RENDER_STEP = 50;
const CACHE_SAVE_DELAY = 800;

// 検索実行を遅らせるミリ秒（チャタリング防止）
const SEARCH_DEBOUNCE_MS = 250;

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
  originalQtyMap: {}
};

let cacheSaveTimer = null;
let searchTimer = null;

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

  // キャッシュ読み込み
  const cached = localStorage.getItem(STORAGE_PREFIX + state.roomKey);
  if (cached) {
    try {
      const data = JSON.parse(cached);
      state.items = normalizeItems(data.items || []);
      state.originalQtyMap = buildQtyMap(state.items);
      applyFilterAndRender();
      setStatus("キャッシュを表示中（同期中...）");
    } catch (e) {
      listEl.innerHTML = `<div class="empty">データを読み込んでいます...</div>`;
    }
  } else {
    listEl.innerHTML = `<div class="empty">データを読み込んでいます...</div>`;
  }

  fetchLatestData();

  // 【高速化】デバウンス処理：入力のたびに検索せず、タイピングが止まってから実行
  searchInputEl.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = e.target.value.trim().toLowerCase();
      state.displayLimit = INITIAL_RENDER_COUNT;
      applyFilterAndRender();
    }, SEARCH_DEBOUNCE_MS);
  });

  document.getElementById("reloadBtn").addEventListener("click", () => {
    if (confirm("最新データを再取得しますか？")) {
      fetchLatestData(true);
    }
  });

  document.getElementById("sendBtn").addEventListener("click", sendAllData);

  loadMoreBtnEl.addEventListener("click", () => {
    state.displayLimit += RENDER_STEP;
    applyVisibleItems_();
    renderList();
  });

  // イベント委譲によるカウンター操作
  listEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;

    const idx = Number(btn.dataset.index);
    const item = state.visibleItems[idx];
    if (!item) return;

    if (btn.classList.contains("plus")) {
      item.qty += 1;
    } else if (btn.classList.contains("minus")) {
      item.qty = Math.max(0, item.qty - 1);
    } else {
      return;
    }

    // DOMを直接書き換えて再描画コストを最小化
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
 * 5. 描画
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

  // 【高速化】DocumentFragment 相当の文字列一括生成
  // 大量の innerHTML 呼び出しを避けるため、1つの長い文字列を作成して一気に挿入
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
    loadMoreWrapEl.classList.add("hidden"); // 検索時は全件出す仕様に合わせる
  } else {
    countInfoEl.textContent = `${visible} / ${total}件を表示`;
    if (total > visible) {
      loadMoreWrapEl.classList.remove("hidden");
    } else {
      loadMoreWrapEl.classList.add("hidden");
    }
  }
}

/**
 * ==================================================================================
 * 6. データ取得
 * ==================================================================================
 */
async function fetchLatestData() {
  if (state.isSyncing) return;

  state.isSyncing = true;
  setStatus("最新データ取得中...");

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const [masterRes, inventoryRes] = await Promise.all([
      fetch(`${GAS_URL}?type=master`, { signal: controller.signal }),
      fetch(`${GAS_URL}?type=inventory&room=${encodeURIComponent(state.roomKey)}`, { signal: controller.signal })
    ]);

    const masterResult = await masterRes.json();
    const inventoryResult = await inventoryRes.json();

    clearTimeout(timeoutId);

    if (!masterResult.success || !inventoryResult.success) {
      throw new Error("データの取得に失敗しました");
    }

    const qtyMap = {};
    (inventoryResult.items || []).forEach(item => {
      const id = String(item.id || "").trim();
      if (id) qtyMap[id] = Math.max(0, Number(item.qty || 0));
    });

    // 【高速化】取得時に検索用インデックスを生成しておく
    state.items = normalizeItems(
      (masterResult.items || []).map(item => ({
        ...item,
        qty: qtyMap[item.id] || 0
      }))
    );

    state.originalQtyMap = buildQtyMap(state.items);
    saveCacheNow();
    applyFilterAndRender();
    setStatus(`同期完了（${new Date().toLocaleTimeString()}）`);
  } catch (e) {
    console.error(e);
    setStatus(`取得失敗: ${e.message}`);
  } finally {
    state.isSyncing = false;
  }
}

/**
 * ==================================================================================
 * 7. フィルタ
 * ==================================================================================
 */
function applyFilterAndRender() {
  const q = state.query;

  if (!q) {
    state.filteredItems = state.items;
  } else {
    // 【高速化】事前に作成した _searchTag プロパティで判定（2000件でも高速）
    state.filteredItems = state.items.filter(item => item._searchTag.includes(q));
  }

  applyVisibleItems_();
  renderList();
}

function applyVisibleItems_() {
  if (state.query) {
    // 検索時は全件（または多め）に表示しても良いが、負荷軽減のためフィルタ結果をそのまま使う
    state.visibleItems = state.filteredItems;
  } else {
    state.visibleItems = state.filteredItems.slice(0, state.displayLimit);
  }
}

/**
 * ==================================================================================
 * 8. 送信
 * ==================================================================================
 */
async function sendAllData() {
  const btn = document.getElementById("sendBtn");
  if (!confirm("送信しますか？")) return;

  const changedItems = getChangedItems_();
  if (changedItems.length === 0) {
    alert("変更はありません。");
    return;
  }

  saveCacheNow();
  btn.disabled = true;
  setStatus(`送信中...（${changedItems.length}件）`);

  try {
    const body = new URLSearchParams();
    body.append("room", state.roomKey);
    body.append("changedItems", JSON.stringify(changedItems));

    const res = await fetch(GAS_URL, { method: "POST", body: body });
    const result = await res.json();

    if (!result.success) throw new Error(result.message || "送信失敗");

    state.originalQtyMap = buildQtyMap(state.items);
    saveCacheNow();
    setStatus(`送信成功 / ${new Date().toLocaleTimeString()}`);
    alert("送信完了！");
  } catch (e) {
    alert(`送信に失敗しました: ${e.message}`);
    setStatus(`送信失敗: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

/**
 * ==================================================================================
 * 9. ユーティリティ
 * ==================================================================================
 */
function normalizeItems(items) {
  return items.map(item => {
    const m = String(item.master || "").trim();
    const id = String(item.id || "").trim();
    const s = String(item.subject || "").trim();
    const n = String(item.name || "").trim();
    const p = String(item.publisher || "").trim();
    
    return {
      master: m,
      id: id,
      subject: s,
      name: n,
      publisher: p,
      qty: Math.max(0, Number(item.qty || 0)),
      // 【高速化】検索用タグを事前に小文字で結合して持っておく
      _searchTag: `${m} ${id} ${s} ${n} ${p}`.toLowerCase()
    };
  }).filter(item => item.id !== "");
}

function buildQtyMap(items) {
  const map = {};
  items.forEach(item => { map[item.id] = item.qty; });
  return map;
}

function getChangedItems_() {
  return state.items
    .filter(item => {
      const original = state.originalQtyMap[item.id] ?? 0;
      return item.qty !== original;
    })
    .map(item => ({ id: item.id, qty: item.qty }));
}

function updateDirtyStatus_() {
  const count = getChangedItems_().length;
  setStatus(count > 0 ? `未送信の変更あり（${count}件）` : "変更なし");
}

function scheduleCacheSave() {
  if (cacheSaveTimer) clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => saveCacheNow(), CACHE_SAVE_DELAY);
}

function saveCacheNow() {
  // 保存時はインデックス(_searchTag)を含めると重いので除外して保存
  const saveItems = state.items.map(({_searchTag, ...rest}) => rest);
  localStorage.setItem(STORAGE_PREFIX + state.roomKey, JSON.stringify({ items: saveItems }));
}

function setStatus(msg) {
  statusEl.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  }[m]));
}
