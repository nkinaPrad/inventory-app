/**
 * 定数・設定
 */
const GAS_URL = "https://script.google.com/macros/s/AKfycbxkoURHI0M-TivL8u8GfholmM7ozyqz1BkTxHq3K_y0z3EJl9o7PqMlCnI1c8DsRgvlbA/exec";
const ROOM_MAP = {
  "takadanobaba": "高田馬場", "sugamo": "巣鴨", "nishinippori": "西日暮里",
  "ohji": "王子", "itabashi": "板橋", "minamisenju": "南千住",
  "kiba": "木場", "gakuin": "学院"
};

let state = {
  roomKey: null, items: [], filteredItems: [], visibleItems: [],
  query: "", activeFilter: "all", displayLimit: 50, isSyncing: false, originalQtyMap: {}
};

document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  state.roomKey = params.get("room")?.toLowerCase();
  if (!state.roomKey || !ROOM_MAP[state.roomKey]) { showGuide(); return; }
  initUI();
  fetchLatestData();
});

// 送信忘れ防止
window.addEventListener('beforeunload', (e) => {
  const changed = state.items.filter(item => (state.originalQtyMap[item.id] || 0) !== item.qty);
  if (changed.length > 0) { e.preventDefault(); e.returnValue = ''; }
});

function initUI() {
  document.getElementById("roomLabel").textContent = ROOM_MAP[state.roomKey];
  document.getElementById("toolbarContainer").classList.remove("hidden");
  document.getElementById("bottomBar").classList.remove("hidden");
  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.query = e.target.value.trim().toLowerCase();
    state.displayLimit = 50; applyFilterAndRender();
  });
  document.getElementById("filterArea").addEventListener("click", (e) => {
    const chip = e.target.closest(".f-chip");
    if (!chip) return;
    document.querySelectorAll(".f-chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    state.activeFilter = chip.dataset.filter;
    state.displayLimit = 50; applyFilterAndRender();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  document.getElementById("list").addEventListener("click", handleCounter);
  document.getElementById("sendBtn").addEventListener("click", sendData);
  document.getElementById("loadMoreBtn").addEventListener("click", () => {
    state.displayLimit += 50; applyFilterAndRender();
  });
}

async function fetchLatestData() {
  if (state.isSyncing) return;
  state.isSyncing = true;
  
  // 計測開始
  const startTime = performance.now();
  setStatus("同期中...");

  try {
    // 1. 通信時間の計測
    const fetchStart = performance.now();
    const response = await fetch(`${GAS_URL}?room=${state.roomKey}`);
    const fetchEnd = performance.now();
    const fetchDuration = ((fetchEnd - fetchStart) / 1000).toFixed(2); // 秒単位

    const res = await response.json();
    if (!res.success) throw new Error(res.message);

    // 2. データ加工・描画時間の計測
    const renderStart = performance.now();
    
    state.items = res.items.map(m => ({
      ...m, _searchTag: `${m.id} ${m.name} ${m.category}`.toLowerCase()
    }));

    state.originalQtyMap = {};
    res.items.forEach(i => { if(i.qty > 0) state.originalQtyMap[i.id] = i.qty; });

    generateCategoryChips();
    applyFilterAndRender();
    
    const renderEnd = performance.now();
    const renderDuration = ((renderEnd - renderStart) / 1000).toFixed(2);
    const totalDuration = ((renderEnd - startTime) / 1000).toFixed(2);

    // 詳細な計測結果を表示
    setStatus(`完了: 合計${totalDuration}s (通信:${fetchDuration}s / 描画:${renderDuration}s)`);
    
    console.log(`[Performance] Total: ${totalDuration}s, Fetch: ${fetchDuration}s, Render: ${renderDuration}s`);

  } catch (e) {
    setStatus("取得エラー: " + e.message);
    console.error(e);
  } finally {
    state.isSyncing = false;
  }
}

function generateCategoryChips() {
  const categories = [...new Set(state.items.map(item => item.category))].filter(Boolean).sort();
  const container = document.getElementById("filterArea");
  const base = `<div class="f-chip ${state.activeFilter==='all'?'active':''}" data-filter="all">すべて</div>
                <div class="f-chip ${state.activeFilter==='input'?'active':''}" data-filter="input">入力済</div>`;
  container.innerHTML = base + categories.map(c => `<div class="f-chip ${state.activeFilter===c?'active':''}" data-filter="${escapeHtml(c)}">${escapeHtml(c)}</div>`).join("");
}

function applyFilterAndRender() {
  let list = state.items;
  if (state.activeFilter === "input") list = list.filter(item => item.qty > 0);
  else if (state.activeFilter !== "all") list = list.filter(item => item.category === state.activeFilter);
  if (state.query) list = list.filter(item => item._searchTag.includes(state.query));
  state.filteredItems = list;
  state.visibleItems = list.slice(0, state.displayLimit);
  renderList(); updateStats();
}

function renderList() {
  const container = document.getElementById("list");
  if (state.visibleItems.length === 0) {
    container.innerHTML = `<div class="empty">教材が見つかりません</div>`;
    document.getElementById("loadMoreWrap").classList.add("hidden");
    return;
  }
  container.innerHTML = state.visibleItems.map((item, idx) => `
    <div class="item ${item.qty > 0 ? 'has-qty' : ''}" data-id="${item.id}">
      <div class="item-info">
        <div class="item-top">
          <span class="chip subject">${escapeHtml(item.category)}</span>
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
  document.getElementById("loadMoreWrap").classList.toggle("hidden", state.filteredItems.length <= state.displayLimit);
}

function updateStats() {
  const changed = state.items.filter(item => (state.originalQtyMap[item.id] || 0) !== item.qty);
  const total = state.items.reduce((sum, item) => sum + item.qty, 0);
  document.getElementById("changeCount").textContent = changed.length;
  document.getElementById("totalQty").textContent = total;
  document.getElementById("sendBtn").classList.toggle("dirty", changed.length > 0);
}

function handleCounter(e) {
  const btn = e.target.closest("button"); if (!btn) return;
  const idx = parseInt(btn.dataset.idx);
  const item = state.visibleItems[idx];
  if (btn.classList.contains("plus")) item.qty++;
  else if (btn.classList.contains("minus")) item.qty = Math.max(0, item.qty - 1);
  const card = btn.closest(".item");
  card.querySelector(".qty").textContent = item.qty;
  card.classList.toggle("has-qty", item.qty > 0);
  updateStats();
}

async function sendData() {
  const changed = state.items.filter(item => (state.originalQtyMap[item.id] || 0) !== item.qty);
  if (changed.length === 0 || !confirm(`${changed.length}件の変更を保存しますか？`)) return;
  state.isSyncing = true;
  const btn = document.getElementById("sendBtn");
  btn.disabled = true; btn.textContent = "送信中...";
  try {
    const body = new URLSearchParams();
    body.append("room", state.roomKey);
    body.append("changedItems", JSON.stringify(changed.map(i => ({id:i.id, qty:i.qty}))));
    const res = await fetch(GAS_URL, { method: "POST", body }).then(r => r.json());
    if (!res.success) throw new Error(res.message);
    changed.forEach(i => state.originalQtyMap[i.id] = i.qty);
    updateStats(); alert("送信完了！");
  } catch (e) {
    alert("送信失敗: " + e.message);
  } finally {
    state.isSyncing = false; btn.disabled = false; btn.textContent = "送信する";
  }
}

function setStatus(msg) {
  const now = new Date().toLocaleTimeString("ja-JP");
  document.getElementById("statusLine").textContent = `[${now}] ${msg}`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, m => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[m]));
}

function showGuide() {
  const guide = document.getElementById("guide"); guide.classList.remove("hidden");
  const links = document.getElementById("roomLinks");
  Object.entries(ROOM_MAP).forEach(([key, name]) => {
    const a = document.createElement("a");
    a.href = `?room=${key}`; a.textContent = name;
    a.style = "display:block; padding:18px; margin:12px; background:#e8f0fe; color:#1a73e8; text-decoration:none; border-radius:12px; font-weight:800; text-align:center;";
    links.appendChild(a);
  });
}
