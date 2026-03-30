/**
 * 設定
 */
const GITHUB_JSON_URL = "https://raw.githubusercontent.com/nkinaPrad/inventory-app/main/data.json";
const GAS_URL = "https://script.google.com/macros/s/AKfycbwO7-t2qMX6u38tjSbe-IKQpjoAxD7MQeKNJTPUaZUyT48I7Gmt7NQ9TTPNiEXSOG9Y/exec";

let state = {
  roomKey: null,
  items: [],
  filteredItems: [],
  activeFilter: "all",
  query: "",
  originalQtyMap: {},
  isSyncing: false
};

document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(window.location.search);
  state.roomKey = params.get("room")?.toLowerCase();
  if (!state.roomKey) return;

  initUI();
  await loadAppData();
});

function initUI() {
  document.getElementById("roomLabel").textContent = state.roomKey.toUpperCase();
  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.query = e.target.value.trim().toLowerCase();
    applyFilterAndRender();
  });
  document.getElementById("filterArea").addEventListener("click", (e) => {
    const chip = e.target.closest(".f-chip");
    if (!chip) return;
    document.querySelectorAll(".f-chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    state.activeFilter = chip.dataset.filter;
    applyFilterAndRender();
  });
  document.getElementById("sendBtn").addEventListener("click", sendData);
  document.getElementById("list").addEventListener("click", handleCounter);
}

/**
 * データの並列取得と描画
 */
async function loadAppData() {
  const startTime = performance.now();
  setStatus("同期中...");

  try {
    // GitHubのマスタJSONとGASの在庫データを並列で取得（最速）
    const [masterRes, invRes] = await Promise.all([
      fetch(GITHUB_JSON_URL).then(r => r.json()),
      fetch(`${GAS_URL}?room=${state.roomKey}`).then(r => r.json())
    ]);

    const inventory = invRes.inventory || {};
    state.originalQtyMap = { ...inventory };

    // データの結合
    state.items = masterRes.map(m => ({
      id: String(m.id),
      name: m.nm,
      category: m.cat || "未分類",
      qty: inventory[String(m.id)] || 0,
      _searchTag: `${m.id} ${m.nm} ${m.cat}`.toLowerCase()
    }));

    generateCategoryChips();
    applyFilterAndRender(true); // 初回描画（分割描画を有効に）

    const totalTime = ((performance.now() - startTime) / 1000).toFixed(2);
    setStatus(`同期完了 (${totalTime}s)`);
  } catch (e) {
    setStatus("エラー: " + e.message);
  }
}

function applyFilterAndRender(isInitial = false) {
  let list = state.items;
  if (state.activeFilter === "input") list = list.filter(i => i.qty > 0);
  else if (state.activeFilter !== "all") list = list.filter(i => i.category === state.activeFilter);
  if (state.query) list = list.filter(i => i._searchTag.includes(state.query));
  
  state.filteredItems = list;

  if (isInitial && list.length > 30) {
    // 最初の30件を即時描画
    renderItems(list.slice(0, 30), false);
    // 残りを遅延描画
    setTimeout(() => {
      renderItems(list.slice(30), true);
    }, 100);
  } else {
    renderItems(list, false);
  }
  updateStats();
}

function renderItems(items, isAppend) {
  const container = document.getElementById("list");
  if (!isAppend) container.innerHTML = "";
  
  if (items.length === 0 && !isAppend) {
    container.innerHTML = '<div class="empty">教材が見つかりません</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach(item => {
    const div = document.createElement("div");
    div.className = `item ${item.qty > 0 ? 'has-qty' : ''}`;
    div.dataset.id = item.id;
    div.innerHTML = `
      <div class="item-info">
        <div class="item-top">
          <span class="chip subject">${escapeHtml(item.category)}</span>
          <span class="chip">${escapeHtml(item.id)}</span>
        </div>
        <div class="item-name">${escapeHtml(item.name)}</div>
      </div>
      <div class="counter">
        <button type="button" class="minus">－</button>
        <div class="qty">${item.qty}</div>
        <button type="button" class="plus">＋</button>
      </div>
    `;
    fragment.appendChild(div);
  });
  container.appendChild(fragment);
}

function generateCategoryChips() {
  const categories = [...new Set(state.items.map(i => i.category))].filter(Boolean).sort();
  const container = document.getElementById("filterArea");
  container.innerHTML = `
    <div class="f-chip active" data-filter="all">すべて</div>
    <div class="f-chip" data-filter="input">入力済</div>
    ${categories.map(c => `<div class="f-chip" data-filter="${escapeHtml(c)}">${escapeHtml(c)}</div>`).join("")}
  `;
}

function handleCounter(e) {
  const btn = e.target.closest("button");
  if (!btn) return;
  const card = btn.closest(".item");
  const id = card.dataset.id;
  const item = state.items.find(i => i.id === id);

  if (btn.classList.contains("plus")) item.qty++;
  else if (btn.classList.contains("minus")) item.qty = Math.max(0, item.qty - 1);

  card.querySelector(".qty").textContent = item.qty;
  card.classList.toggle("has-qty", item.qty > 0);
  updateStats();
}

function updateStats() {
  const changed = state.items.filter(i => (state.originalQtyMap[i.id] || 0) !== i.qty);
  const total = state.items.reduce((sum, i) => sum + i.qty, 0);
  document.getElementById("changeCount").textContent = changed.length;
  document.getElementById("totalQty").textContent = total;
  document.getElementById("sendBtn").classList.toggle("dirty", changed.length > 0);
}

async function sendData() {
  const changed = state.items.filter(i => (state.originalQtyMap[i.id] || 0) !== i.qty);
  if (changed.length === 0) return;

  state.isSyncing = true;
  const btn = document.getElementById("sendBtn");
  btn.disabled = true;
  btn.textContent = "送信中...";

  try {
    const body = new URLSearchParams();
    body.append("room", state.roomKey);
    body.append("changedItems", JSON.stringify(changed.map(i => ({id:i.id, qty:i.qty}))));

    const res = await fetch(GAS_URL, { method: "POST", body }).then(r => r.json());
    if (!res.success) throw new Error(res.message);

    changed.forEach(i => state.originalQtyMap[i.id] = i.qty);
    updateStats();
    alert("保存しました。");
  } catch (e) {
    alert("エラー: " + e.message);
  } finally {
    state.isSyncing = false;
    btn.disabled = false;
    btn.textContent = "送信する";
  }
}

function setStatus(msg) {
  const now = new Date().toLocaleTimeString("ja-JP");
  document.getElementById("statusLine").textContent = `[${now}] ${msg}`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, m => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[m]));
}
