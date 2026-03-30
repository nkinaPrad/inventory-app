/**
 * =========================
 * 設定
 * =========================
 */
const GITHUB_JSON_URL = "https://raw.githubusercontent.com/nkinaPrad/inventory-app/main/data.json";
const GAS_URL = "https://script.google.com/macros/s/AKfycbzcxHCv5cbaggJwl8sfNWQ1oCQZh5t5xRfza7SeH-UkXJKahPRJBD2LprQeBoZnYEmi6g/exec";

const ROOM_LABEL_MAP = {
  takadanobaba: "高田馬場",
  sugamo: "巣鴨",
  nishinippori: "西日暮里",
  ohji: "王子",
  itabashi: "板橋",
  minamisenju: "南千住",
  kiba: "木場",
  gakuin: "学院"
};

const SEARCH_DEBOUNCE_MS = 120;
const RENDER_CHUNK_SIZE = 80;

const state = {
  roomKey: "",
  roomLabel: "",
  items: [],
  itemsById: new Map(),
  filteredItems: [],
  activeFilter: "all",
  query: "",
  isSyncing: false,
  totalQty: 0,
  dirtyCount: 0,
  originalQtyMap: Object.create(null),
  renderToken: 0,
  lastUpdatedAt: ""
};


/**
 * =========================
 * 起動
 * =========================
 */
document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(location.search);
  state.roomKey = (params.get("room") || "").trim().toLowerCase();
  state.roomLabel = ROOM_LABEL_MAP[state.roomKey] || "";

  initUI();
  await loadAppData();
});


/**
 * =========================
 * UI初期化
 * =========================
 */
function initUI() {
  const roomLabelEl = document.getElementById("roomLabel");
  const sendBtn = document.getElementById("sendBtn");
  const searchInput = document.getElementById("searchInput");
  const filterArea = document.getElementById("filterArea");
  const list = document.getElementById("list");

  if (state.roomKey && state.roomLabel) {
    roomLabelEl.textContent = state.roomLabel;
  } else {
    roomLabelEl.textContent = "閲覧モード";
    roomLabelEl.classList.add("muted");
    sendBtn.style.display = "none";
  }

  searchInput.addEventListener("input", debounce((e) => {
    state.query = String(e.target.value || "").trim().toLowerCase();
    applyFilterAndRender();
  }, SEARCH_DEBOUNCE_MS));

  filterArea.addEventListener("click", (e) => {
    const chip = e.target.closest(".f-chip");
    if (!chip) return;

    const next = chip.dataset.filter;
    if (!next || next === state.activeFilter) return;

    document.querySelectorAll(".f-chip").forEach(el => el.classList.remove("active"));
    chip.classList.add("active");

    state.activeFilter = next;
    applyFilterAndRender();
  });

  list.addEventListener("click", handleCounterClick);
  sendBtn.addEventListener("click", sendData);
}


/**
 * =========================
 * データ取得
 * =========================
 */
async function loadAppData() {
  const started = performance.now();
  setStatus("データ同期中...");

  try {
    let masterData;
    let invData = { success: true, inventory: {}, updatedAt: "" };

    if (state.roomKey) {
      const [masterRes, invRes] = await Promise.all([
        fetch(GITHUB_JSON_URL, { cache: "no-store" }),
        fetch(`${GAS_URL}?room=${encodeURIComponent(state.roomKey)}`, { cache: "no-store" })
      ]);

      if (!masterRes.ok) throw new Error("マスタデータの取得に失敗しました。");
      if (!invRes.ok) throw new Error("在庫データの取得に失敗しました。");

      masterData = await masterRes.json();
      invData = await invRes.json();
    } else {
      const masterRes = await fetch(GITHUB_JSON_URL, { cache: "no-store" });
      if (!masterRes.ok) throw new Error("マスタデータの取得に失敗しました。");
      masterData = await masterRes.json();
    }

    if (!Array.isArray(masterData)) {
      throw new Error("マスタデータの形式が不正です。");
    }
    if (!invData.success) {
      throw new Error(invData.message || "在庫データ取得に失敗しました。");
    }

    const inventory = invData.inventory || {};
    state.lastUpdatedAt = invData.updatedAt || "";

    state.items = [];
    state.itemsById = new Map();
    state.originalQtyMap = Object.create(null);
    state.totalQty = 0;
    state.dirtyCount = 0;

    for (let i = 0; i < masterData.length; i++) {
      const m = masterData[i] || {};
      const id = String(m.id || "").trim();
      if (!id) continue;

      const qty = Number(inventory[id]) || 0;

      const item = {
        id,
        name: m.name || "名称不明",
        category: m.category || "未分類",
        subject: m.subject || "",
        publisher: m.publisher || "",
        qty,
        searchTag: `${id} ${m.name || ""} ${m.category || ""} ${m.subject || ""} ${m.publisher || ""}`.toLowerCase()
      };

      state.items.push(item);
      state.itemsById.set(id, item);
      state.originalQtyMap[id] = qty;
      state.totalQty += qty;
    }

    generateCategoryChips();
    updateStatsUI();
    applyFilterAndRender();

    const sec = ((performance.now() - started) / 1000).toFixed(2);
    setStatus(`同期完了: ${sec}秒`);
    updateMetaInfo();

  } catch (err) {
    console.error(err);
    setStatus(`取得失敗: ${err.message}`);
    document.getElementById("list").innerHTML = `
      <div class="empty">
        データ取得に失敗しました。<br>
        ${escapeHtml(err.message)}
      </div>
    `;
  }
}


/**
 * =========================
 * カテゴリチップ生成
 * =========================
 */
function generateCategoryChips() {
  const container = document.getElementById("filterArea");
  const categories = Array.from(
    new Set(state.items.map(item => item.category).filter(Boolean))
  ).sort();

  let html = "";
  html += `<button type="button" class="f-chip active" data-filter="all">すべて</button>`;
  html += `<button type="button" class="f-chip" data-filter="input">入力済み</button>`;

  for (let i = 0; i < categories.length; i++) {
    const c = categories[i];
    html += `<button type="button" class="f-chip" data-filter="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
  }

  container.innerHTML = html;
}


/**
 * =========================
 * フィルタ・検索適用
 * =========================
 */
function applyFilterAndRender() {
  const q = state.query;
  const filter = state.activeFilter;
  const result = [];

  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];

    if (filter === "input") {
      if (item.qty <= 0) continue;
    } else if (filter !== "all") {
      if (item.category !== filter) continue;
    }

    if (q && !item.searchTag.includes(q)) continue;
    result.push(item);
  }

  state.filteredItems = result;
  renderFilteredItems(result);
}


/**
 * =========================
 * 描画
 * =========================
 */
function renderFilteredItems(items) {
  const container = document.getElementById("list");
  const token = ++state.renderToken;

  container.innerHTML = "";

  if (items.length === 0) {
    container.innerHTML = `<div class="empty">該当する教材がありません。</div>`;
    updateMetaInfo();
    return;
  }

  let cursor = 0;

  const renderChunk = () => {
    if (token !== state.renderToken) return;

    const end = Math.min(cursor + RENDER_CHUNK_SIZE, items.length);
    let html = "";

    for (let i = cursor; i < end; i++) {
      html += renderItemHTML(items[i]);
    }

    container.insertAdjacentHTML("beforeend", html);
    cursor = end;

    if (cursor < items.length) {
      requestAnimationFrame(renderChunk);
    } else {
      updateMetaInfo();
    }
  };

  requestAnimationFrame(renderChunk);
}


function renderItemHTML(item) {
  return `
    <article class="item ${item.qty > 0 ? "has-qty" : ""}" data-id="${escapeHtml(item.id)}">
      <div class="item-main">
        <div class="item-badges">
          <span class="badge badge-cat">${escapeHtml(item.category)}</span>
          ${item.subject ? `<span class="badge badge-sub">${escapeHtml(item.subject)}</span>` : ""}
          ${item.publisher ? `<span class="badge badge-pub">${escapeHtml(item.publisher)}</span>` : ""}
        </div>

        <div class="item-name">${escapeHtml(item.name)}</div>
      </div>

      <div class="qty-box">
        <button type="button" class="qty-btn minus" aria-label="減らす">−</button>
        <div class="qty-num">${item.qty}</div>
        <button type="button" class="qty-btn plus" aria-label="増やす">＋</button>
      </div>
    </article>
  `;
}


/**
 * =========================
 * 数量操作
 * =========================
 */
function handleCounterClick(e) {
  const btn = e.target.closest("button");
  if (!btn) return;

  const card = e.target.closest(".item");
  if (!card) return;

  const id = card.dataset.id;
  const item = state.itemsById.get(id);
  if (!item) return;

  const oldQty = item.qty;
  let newQty = oldQty;

  if (btn.classList.contains("plus")) {
    newQty = oldQty + 1;
  } else if (btn.classList.contains("minus")) {
    newQty = Math.max(0, oldQty - 1);
  } else {
    return;
  }

  if (newQty === oldQty) return;

  item.qty = newQty;

  const qtyEl = card.querySelector(".qty-num");
  if (qtyEl) qtyEl.textContent = String(newQty);

  card.classList.toggle("has-qty", newQty > 0);

  applyStatsDelta(item.id, oldQty, newQty);

  if (state.activeFilter === "input" && newQty === 0) {
    applyFilterAndRender();
  }
}


/**
 * =========================
 * 統計更新
 * =========================
 */
function applyStatsDelta(id, oldQty, newQty) {
  state.totalQty += (newQty - oldQty);

  const originalQty = Number(state.originalQtyMap[id]) || 0;
  const wasDirty = oldQty !== originalQty;
  const isDirty = newQty !== originalQty;

  if (!wasDirty && isDirty) state.dirtyCount++;
  if (wasDirty && !isDirty) state.dirtyCount--;

  updateStatsUI();
}


function updateStatsUI() {
  document.getElementById("changeCount").textContent = String(state.dirtyCount);
  document.getElementById("totalQty").textContent = String(state.totalQty);

  const sendBtn = document.getElementById("sendBtn");
  sendBtn.disabled = state.isSyncing || state.dirtyCount === 0;
  sendBtn.classList.toggle("dirty", !state.isSyncing && state.dirtyCount > 0);
}


/**
 * =========================
 * メタ表示更新
 * =========================
 */
function updateMetaInfo() {
  const countEl = document.getElementById("visibleCount");
  const updatedEl = document.getElementById("updatedAt");

  if (countEl) {
    countEl.textContent = `${state.filteredItems.length.toLocaleString()}件表示 / 全${state.items.length.toLocaleString()}件`;
  }

  if (updatedEl) {
    updatedEl.textContent = state.lastUpdatedAt
      ? `最終保存: ${state.lastUpdatedAt}`
      : "最終保存: -";
  }
}


/**
 * =========================
 * 保存
 * =========================
 * 全件送信する
 */
async function sendData() {
  if (!state.roomKey || state.isSyncing) return;
  if (state.dirtyCount === 0) return;

  const ok = confirm(`${state.dirtyCount}件の変更を保存しますか？`);
  if (!ok) return;

  const btn = document.getElementById("sendBtn");

  try {
    state.isSyncing = true;
    updateStatsUI();

    btn.textContent = "保存中...";
    setStatus("保存中...");

    // 全件 [id, qty] で送る
    const payload = state.items.map(item => [item.id, item.qty]);

    const body = new URLSearchParams();
    body.append("room", state.roomKey);
    body.append("payload", JSON.stringify(payload));

    const res = await fetch(GAS_URL, {
      method: "POST",
      body
    });

    if (!res.ok) {
      throw new Error("通信に失敗しました。");
    }

    const json = await res.json();
    if (!json.success) {
      throw new Error(json.message || "保存に失敗しました。");
    }

    // 保存成功後、現数量をオリジナル化
    state.originalQtyMap = Object.create(null);
    let dirty = 0;

    for (let i = 0; i < state.items.length; i++) {
      const item = state.items[i];
      state.originalQtyMap[item.id] = item.qty;
      if (item.qty !== state.originalQtyMap[item.id]) dirty++;
    }

    state.dirtyCount = dirty;
    state.lastUpdatedAt = formatNowJa();

    updateStatsUI();
    updateMetaInfo();
    setStatus("保存完了");
    alert("保存完了しました。");

  } catch (err) {
    console.error(err);
    setStatus(`保存失敗: ${err.message}`);
    alert(`保存失敗: ${err.message}`);
  } finally {
    state.isSyncing = false;
    btn.textContent = "保存する";
    updateStatsUI();
  }
}


/**
 * =========================
 * ステータス
 * =========================
 */
function setStatus(msg) {
  const now = new Date().toLocaleTimeString("ja-JP");
  const el = document.getElementById("statusLine");
  if (el) {
    el.textContent = `[${now}] ${msg}`;
  }
}


/**
 * =========================
 * ユーティリティ
 * =========================
 */
function debounce(fn, wait) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

function formatNowJa() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    }[ch];
  });
}
