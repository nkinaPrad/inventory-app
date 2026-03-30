/**
 * ==================================================================================
 * 1. 定数・設定
 * ==================================================================================
 */

// あなたのGAS WebアプリURL
const APP_ID = "AKfycbwngbo2pCFZxAz5jJ9FjloOgjIixpt_SM1ZxTcs0-Bph2lXF1sqKgG8c86Fyq1_ZGLNdA";
const GAS_URL = `https://script.google.com/macros/s/${APP_ID}/exec`;

// GitHub上に置く教材マスタCSV
const MASTER_CSV_URL = "https://raw.githubusercontent.com/nkinaPrad/inbentory-app/main/master.csv";

const STORAGE_PREFIX = "inventory_cache_";
const INITIAL_RENDER_COUNT = 50;
const RENDER_STEP = 50;
const CACHE_SAVE_DELAY = 800;
const SEARCH_DEBOUNCE_MS = 250;
const AUTO_SAVE_INTERVAL_MS = 60000; // 60秒ごとに自動保存

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
  originalQtyMap: {},
  lastAutoSaveAt: 0
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

  // キャッシュ表示
  const cached = localStorage.getItem(STORAGE_PREFIX + state.roomKey);
  if (cached) {
    try {
      const data = JSON.parse(cached);
      state.items = normalizeItems(data.items || []);
      state.originalQtyMap = buildQtyMap(state.items);
      applyFilterAndRender();
      setStatus("キャッシュを表示中（同期中...）");
    } catch (e) {
      console.error(e);
      listEl.innerHTML = `<div class="empty">データを読み込んでいます...</div>`;
    }
  } else {
    listEl.innerHTML = `<div class="empty">データを読み込んでいます...</div>`;
  }

  fetchLatestData();

  // 検索（デバウンス）
  searchInputEl.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = e.target.value.trim().toLowerCase();
      state.displayLimit = INITIAL_RENDER_COUNT;
      applyFilterAndRender();
    }, SEARCH_DEBOUNCE_MS);
  });

  // 再取得
  document.getElementById("reloadBtn").addEventListener("click", () => {
    if (confirm("最新データを再取得しますか？")) {
      fetchLatestData(true);
    }
  });

  // 手動送信
  document.getElementById("sendBtn").addEventListener("click", sendAllData);

  // さらに表示
  loadMoreBtnEl.addEventListener("click", () => {
    state.displayLimit += RENDER_STEP;
    applyVisibleItems_();
    renderList();
  });

  // ＋ / －
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

    const itemCard = btn.closest(".item");
    if (itemCard) {
      const qtyDisplay = itemCard.querySelector(".qty");
      if (qtyDisplay) qtyDisplay.textContent = item.qty;
    }

    updateDirtyStatus_();
    scheduleCacheSave();
  });

  // 定期自動保存
  setInterval(async () => {
    if (document.hidden) return;
    await syncChanges_("auto");
  }, AUTO_SAVE_INTERVAL_MS);

  // 画面離脱時は最低限キャッシュ保存
  window.addEventListener("beforeunload", () => {
    if (getChangedItems_().length > 0) {
      saveCacheNow();
    }
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
    loadMoreWrapEl.classList.add("hidden");
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
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    const [masterItems, inventoryRes] = await Promise.all([
      fetchMasterCsv_(),
      fetch(`${GAS_URL}?room=${encodeURIComponent(state.roomKey)}`, {
        method: "GET",
        signal: controller.signal
      })
    ]);

    const inventoryResult = await inventoryRes.json();
    clearTimeout(timeoutId);

    if (!inventoryResult.success) {
      throw new Error(inventoryResult.message || "在庫データの取得に失敗しました");
    }

    const qtyMap = {};
    (inventoryResult.items || []).forEach(item => {
      const id = String(item.id || "").trim();
      if (id) {
        qtyMap[id] = Math.max(0, Number(item.qty || 0));
      }
    });

    state.items = normalizeItems(
      masterItems.map(item => ({
        ...item,
        qty: qtyMap[item.id] || 0
      }))
    );

    state.originalQtyMap = buildQtyMap(state.items);
    saveCacheNow();
    applyFilterAndRender();
    setStatus(`同期完了（${formatTime_(new Date())}）`);
  } catch (e) {
    console.error(e);
    setStatus(`取得失敗: ${e.message}`);
  } finally {
    state.isSyncing = false;
  }
}

/**
 * ==================================================================================
 * 7. CSV読み込み
 * ==================================================================================
 */
async function fetchMasterCsv_() {
  const res = await fetch(MASTER_CSV_URL, {
    method: "GET",
    cache: "no-store"
  });

  if (!res.ok) {
    throw new Error("教材マスタCSVの取得に失敗しました");
  }

  const text = await res.text();
  return parseMasterCsv_(text);
}

function parseMasterCsv_(csvText) {
  const rows = parseCsvText_(csvText);
  if (rows.length <= 1) return [];

  const header = rows[0].map(v => String(v || "").trim());

  const idx = {
    master: header.indexOf("マスタ区分"),
    id: header.indexOf("商品コード"),
    subject: header.indexOf("科目"),
    name: header.indexOf("商品名"),
    publisher: header.indexOf("出版社")
  };

  const missingHeaders = Object.entries(idx)
    .filter(([, value]) => value === -1)
    .map(([key]) => key);

  if (missingHeaders.length > 0) {
    throw new Error(
      `CSVヘッダーが不足しています: ${missingHeaders.join(", ")} / 期待する1行目: マスタ区分, 商品コード, 科目, 商品名, 出版社`
    );
  }

  return rows.slice(1)
    .map(cols => ({
      master: String(cols[idx.master] || "").trim(),
      id: String(cols[idx.id] || "").trim(),
      subject: String(cols[idx.subject] || "").trim(),
      name: String(cols[idx.name] || "").trim(),
      publisher: String(cols[idx.publisher] || "").trim()
    }))
    .filter(item => item.id !== "");
}

function parseCsvText_(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        value += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      row.push(value);
      value = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += ch;
    }
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }

  return rows
    .map(r => r.map(v => String(v || "").trim()))
    .filter(r => r.some(v => v !== ""));
}

/**
 * ==================================================================================
 * 8. フィルタ
 * ==================================================================================
 */
function applyFilterAndRender() {
  const q = state.query;

  if (!q) {
    state.filteredItems = state.items;
  } else {
    state.filteredItems = state.items.filter(item => item._searchTag.includes(q));
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
 * 9. 送信
 * ==================================================================================
 */
async function sendAllData() {
  if (!confirm("送信しますか？")) return;

  const ok = await syncChanges_("manual");
  if (ok) {
    alert("送信完了！");
  }
}

async function syncChanges_(mode = "manual") {
  if (state.isSyncing && mode === "manual") return false;

  const changedItems = getChangedItems_();
  if (changedItems.length === 0) {
    if (mode === "manual") {
      alert("変更はありません。");
    }
    return false;
  }

  saveCacheNow();

  const btn = document.getElementById("sendBtn");
  if (mode === "manual") {
    btn.disabled = true;
  }

  setStatus(
    mode === "manual"
      ? `送信中...（${changedItems.length}件）`
      : `自動保存中...（${changedItems.length}件）`
  );

  try {
    const body = new URLSearchParams();
    body.append("room", state.roomKey);
    body.append("changedItems", JSON.stringify(changedItems));

    const res = await fetch(GAS_URL, {
      method: "POST",
      body
    });

    const result = await res.json();

    if (!result.success) {
      throw new Error(result.message || "送信失敗");
    }

    state.originalQtyMap = buildQtyMap(state.items);
    state.lastAutoSaveAt = Date.now();
    saveCacheNow();

    setStatus(
      mode === "manual"
        ? `送信成功 / ${formatTime_(new Date())}`
        : `自動保存完了 / ${formatTime_(new Date())}`
    );

    return true;
  } catch (e) {
    console.error(e);
    setStatus(`${mode === "manual" ? "送信" : "自動保存"}失敗: ${e.message}`);

    if (mode === "manual") {
      alert(`送信に失敗しました: ${e.message}`);
    }

    return false;
  } finally {
    if (mode === "manual") {
      btn.disabled = false;
    }
  }
}

/**
 * ==================================================================================
 * 10. ユーティリティ
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
      _searchTag: `${m} ${id} ${s} ${n} ${p}`.toLowerCase()
    };
  }).filter(item => item.id !== "");
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
      const original = state.originalQtyMap[item.id] ?? 0;
      return item.qty !== original;
    })
    .map(item => ({
      id: item.id,
      qty: item.qty
    }));
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
  const saveItems = state.items.map(({ _searchTag, ...rest }) => rest);
  localStorage.setItem(
    STORAGE_PREFIX + state.roomKey,
    JSON.stringify({ items: saveItems })
  );
}

function setStatus(msg) {
  statusEl.textContent = `[${formatTime_(new Date())}] ${msg}`;
}

function formatTime_(date) {
  return date.toLocaleTimeString("ja-JP");
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
