/**
 * 定数設定
 */
const APP_ID = "AKfycbwngbo2pCFZxAz5jJ9FjloOgjIixpt_SM1ZxTcs0-Bph2lXF1sqKgG8c86Fyq1_ZGLNdA";
const GAS_URL = `https://script.google.com/macros/s/${APP_ID}/exec`;
const MASTER_CSV_URL = "https://raw.githubusercontent.com/nkinaPrad/inventory-app/main/master.csv";
const STORAGE_PREFIX = "inventory_cache_";

const ROOM_MAP = {
  "takadanobaba": "高田馬場", "sugamo": "巣鴨", "nishinippori": "西日暮里",
  "ohji": "王子", "itabashi": "板橋", "minamisenju": "南千住",
  "kiba": "木場", "gakuin": "学院"
};

/**
 * 状態管理
 */
let state = {
  roomKey: null,
  items: [],
  filteredItems: [],
  visibleItems: [],
  query: "",
  activeFilter: "all", 
  displayLimit: 50,
  isSyncing: false,
  originalQtyMap: {}
};

document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  state.roomKey = params.get("room")?.toLowerCase();

  if (!state.roomKey || !ROOM_MAP[state.roomKey]) {
    showGuide();
    return;
  }

  initUI();
  loadCache();
  fetchLatestData();
});

function initUI() {
  document.getElementById("roomLabel").textContent = ROOM_MAP[state.roomKey];
  document.getElementById("toolbarContainer").classList.remove("hidden");
  document.getElementById("bottomBar").classList.remove("hidden");

  // 検索入力
  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.query = e.target.value.trim().toLowerCase();
    state.displayLimit = 50;
    applyFilterAndRender();
  });

  // フィルタチップの切り替え
  document.getElementById("filterArea").addEventListener("click", (e) => {
    const chip = e.target.closest(".f-chip");
    if (!chip) return;
    document.querySelectorAll(".f-chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    state.activeFilter = chip.dataset.filter;
    state.displayLimit = 50;
    applyFilterAndRender();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // リスト内のボタン操作
  document.getElementById("list").addEventListener("click", handleCounter);
  
  // 送信・再取得
  document.getElementById("sendBtn").addEventListener("click", sendData);
  document.getElementById("reloadBtn").addEventListener("click", () => {
    if(confirm("最新データを取得します。入力中の内容は上書きされますがよろしいですか？")) fetchLatestData();
  });

  // もっと見る
  document.getElementById("loadMoreBtn").addEventListener("click", () => {
    state.displayLimit += 50;
    applyFilterAndRender();
  });
}

/**
 * 描画・フィルタリング
 */
function applyFilterAndRender() {
  let list = state.items;

  // フィルタ適用
  if (state.activeFilter === "input") {
    list = list.filter(item => item.qty > 0);
  } else if (state.activeFilter !== "all") {
    list = list.filter(item => item.subject === state.activeFilter);
  }

  // 検索適用
  if (state.query) {
    list = list.filter(item => item._searchTag.includes(state.query));
  }

  state.filteredItems = list;
  state.visibleItems = list.slice(0, state.displayLimit);
  
  renderList();
  updateStats();
}

function renderList() {
  const container = document.getElementById("list");
  if (state.visibleItems.length === 0) {
    container.innerHTML = `<div class="empty">該当する教材が見つかりません</div>`;
    document.getElementById("loadMoreWrap").classList.add("hidden");
    return;
  }

  container.innerHTML = state.visibleItems.map((item, idx) => `
    <div class="item ${item.qty > 0 ? 'has-qty' : ''}" data-id="${item.id}">
      <div class="item-info">
        <div class="item-top">
          <span class="chip subject">${escapeHtml(item.subject)}</span>
          <span class="chip">${escapeHtml(item.id)}</span>
        </div>
        <div class="item-name">${escapeHtml(item.name)}</div>
      </div>
      <div class="counter">
        <button type="button" class="minus" data-idx="${idx}">－</button>
        <div class="qty">${item.qty}</div>
        <button type="button" class="plus" data-idx="${idx}">＋</button>
      </div>
    </div>
  `).join("");

  const hasMore = state.filteredItems.length > state.displayLimit;
  document.getElementById("loadMoreWrap").classList.toggle("hidden", !hasMore);
}

function updateStats() {
  const changed = state.items.filter(item => (state.originalQtyMap[item.id] || 0) !== item.qty);
  const totalQty = state.items.reduce((sum, item) => sum + item.qty, 0);
  
  document.getElementById("changeCount").textContent = changed.length;
  document.getElementById("totalQty").textContent = totalQty;
  
  const sendBtn = document.getElementById("sendBtn");
  sendBtn.classList.toggle("dirty", changed.length > 0);
}

function generateSubjectChips() {
  const subjects = [...new Set(state.items.map(item => item.subject))].filter(Boolean).sort();
  const container = document.getElementById("filterArea");
  const baseChips = `<div class="f-chip ${state.activeFilter==='all'?'active':''}" data-filter="all">すべて</div>
                     <div class="f-chip ${state.activeFilter==='input'?'active':''}" data-filter="input">入力済のみ</div>`;
  container.innerHTML = baseChips + subjects.map(s => 
    `<div class="f-chip ${state.activeFilter===s?'active':''}" data-filter="${escapeHtml(s)}">${escapeHtml(s)}</div>`
  ).join("");
}

/**
 * ユーザーアクション
 */
function handleCounter(e) {
  const btn = e.target.closest("button");
  if (!btn) return;

  const idx = parseInt(btn.dataset.idx);
  const item = state.visibleItems[idx];
  if (!item) return;

  if (btn.classList.contains("plus")) item.qty++;
  else if (btn.classList.contains("minus")) item.qty = Math.max(0, item.qty - 1);

  // 部分DOM更新
  const card = btn.closest(".item");
  card.querySelector(".qty").textContent = item.qty;
  card.classList.toggle("has-qty", item.qty > 0);
  
  updateStats();
  saveCache();
}

/**
 * 同期処理
 */
async function fetchLatestData() {
  if (state.isSyncing) return;
  state.isSyncing = true;
  setStatus("最新データを取得中...");

  try {
    const [masterRes, inventoryRes] = await Promise.all([
      fetchMasterCsv_(),
      fetch(`${GAS_URL}?room=${state.roomKey}`).then(r => r.json())
    ]);

    if (!inventoryRes.success) throw new Error(inventoryRes.message);

    const invMap = {};
    inventoryRes.items.forEach(i => invMap[i.id] = i.qty);

    state.items = masterRes.map(m => ({
      ...m,
      qty: invMap[m.id] || 0,
      _searchTag: `${m.id} ${m.name} ${m.subject} ${m.publisher}`.toLowerCase()
    }));

    state.originalQtyMap = {...invMap};
    generateSubjectChips();
    applyFilterAndRender();
    setStatus("同期完了");
  } catch (e) {
    setStatus("取得エラー: " + e.message);
    console.error(e);
  } finally {
    state.isSyncing = false;
  }
}

async function sendData() {
  const changed = state.items.filter(item => (state.originalQtyMap[item.id] || 0) !== item.qty);
  if (changed.length === 0) return alert("送信する変更がありません");

  if (!confirm(`${changed.length}件の変更を保存します。よろしいですか？`)) return;

  state.isSyncing = true;
  const btn = document.getElementById("sendBtn");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "送信中...";

  try {
    const body = new URLSearchParams();
    body.append("room", state.roomKey);
    body.append("changedItems", JSON.stringify(changed.map(i => ({id:i.id, qty:i.qty}))));

    const res = await fetch(GAS_URL, { method: "POST", body }).then(r => r.json());
    if (!res.success) throw new Error(res.message);

    // 送信成功後、現在の値を「オリジナル」として保存
    changed.forEach(i => state.originalQtyMap[i.id] = i.qty);
    updateStats();
    setStatus("送信が正常に完了しました");
    alert("送信完了！");
  } catch (e) {
    alert("送信に失敗しました: " + e.message);
  } finally {
    state.isSyncing = false;
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

/**
 * ユーティリティ
 */
async function fetchMasterCsv_() {
  const res = await fetch(`${MASTER_CSV_URL}?t=${Date.now()}`);
  const buffer = await res.arrayBuffer();
  return parseCsv_(new TextDecoder("shift-jis").decode(buffer));
}

function parseCsv_(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return [];
  const header = lines[0].split(",").map(s => s.replace(/"/g, "").trim());
  const col = {
    id: header.indexOf("商品コード"),
    name: header.indexOf("商品名"),
    subject: header.indexOf("科目"),
    publisher: header.indexOf("出版社")
  };

  return lines.slice(1).map(line => {
    const cells = line.split(",").map(s => s.replace(/"/g, "").trim());
    return {
      id: cells[col.id],
      name: cells[col.name],
      subject: cells[col.subject],
      publisher: cells[col.publisher]
    };
  }).filter(i => i.id);
}

function saveCache() {
  localStorage.setItem(STORAGE_PREFIX + state.roomKey, JSON.stringify({
    items: state.items,
    ts: Date.now()
  }));
}

function loadCache() {
  const cached = localStorage.getItem(STORAGE_PREFIX + state.roomKey);
  if (!cached) return;
  const data = JSON.parse(cached);
  state.items = data.items;
  // 読み込み時点での変更をチェックするためstats更新
  applyFilterAndRender();
}

function setStatus(msg) {
  const now = new Date().toLocaleTimeString("ja-JP", {hour: '2-digit', minute:'2-digit', second:'2-digit'});
  document.getElementById("statusLine").textContent = `[${now}] ${msg}`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, m => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[m]));
}

function showGuide() {
  const guide = document.getElementById("guide");
  guide.classList.remove("hidden");
  const links = document.getElementById("roomLinks");
  Object.entries(ROOM_MAP).forEach(([key, name]) => {
    const a = document.createElement("a");
    a.href = `?room=${key}`;
    a.textContent = name;
    a.style = "display:block; padding:18px; margin:12px; background:#e8f0fe; color:#1a73e8; text-decoration:none; border-radius:12px; font-weight:800; text-align:center; font-size:16px;";
    links.appendChild(a);
  });
}
