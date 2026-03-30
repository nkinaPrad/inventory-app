/**
 * 設定（URLをご自身の環境に合わせて修正してください）
 */
const GITHUB_JSON_URL = "https://raw.githubusercontent.com/nkinaPrad/inventory-app/main/data.json";
const GAS_URL = "https://script.google.com/macros/s/AKfycbzF7Bq_Pf0gzikbx4M2uJ5GDla3EQzuVXwucRqv3hPu509KpnyNXGeuy0QebQf1AlFRJA/exec";

let state = {
  roomKey: null,
  items: [],
  filteredItems: [],
  activeFilter: "all",
  query: "",
  originalQtyMap: {},
  isSyncing: false
};

// 起動時処理
document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(window.location.search);
  state.roomKey = params.get("room")?.toLowerCase();
  
  initUI();
  await loadAppData();
});

// UI初期化
function initUI() {
  const label = document.getElementById("roomLabel");
  if (state.roomKey) {
    label.textContent = state.roomKey.toUpperCase();
  } else {
    label.textContent = "閲覧モード（校舎未指定）";
    label.style.color = "#888";
    const sendBtn = document.getElementById("sendBtn");
    if (sendBtn) sendBtn.style.display = "none";
  }
  
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
 * データ取得
 */
async function loadAppData() {
  const startTime = performance.now();
  setStatus("データ同期中...");

  try {
    let masterRes, invRes;

    if (state.roomKey) {
      // 校舎指定がある場合
      const [mRes, iRes] = await Promise.all([
        fetch(GITHUB_JSON_URL).then(r => r.json()),
        fetch(`${GAS_URL}?room=${state.roomKey}`).then(r => r.json())
      ]);
      masterRes = mRes;
      invRes = iRes;
    } else {
      // 校舎指定がない場合
      masterRes = await fetch(GITHUB_JSON_URL).then(r => r.json());
      invRes = { success: true, inventory: {} };
    }

    const inventory = invRes.inventory || {};
    state.originalQtyMap = { ...inventory };

    // ★重要：ご提示いただいたJSONのキー名に厳密に合わせます
    state.items = masterRes.map(m => {
      const idStr = String(m.id || "");
      return {
        id: idStr,
        name: m.name || "名称不明",
        category: m.category || "未分類",
        subject: m.subject || "",
        publisher: m.publisher || "",
        qty: inventory[idStr] || 0,
        _searchTag: `${idStr} ${m.name} ${m.category} ${m.subject} ${m.publisher}`.toLowerCase()
      };
    });

    generateCategoryChips();
    applyFilterAndRender(true);

    const totalTime = ((performance.now() - startTime) / 1000).toFixed(2);
    setStatus(state.roomKey ? `完了: ${totalTime}秒` : "閲覧モードで起動");
  } catch (e) {
    setStatus("取得失敗: " + e.message);
    console.error(e);
  }
}

/**
 * フィルタ・検索適用
 */
function applyFilterAndRender(isInitial = false) {
  let list = state.items;
  
  if (state.activeFilter === "input") {
    list = list.filter(i => i.qty > 0);
  } else if (state.activeFilter !== "all") {
    list = list.filter(i => i.category === state.activeFilter);
  }

  if (state.query) {
    list = list.filter(i => i._searchTag.includes(state.query));
  }
  
  state.filteredItems = list;

  if (isInitial && list.length > 30) {
    renderItems(list.slice(0, 30), false);
    setTimeout(() => {
      renderItems(list.slice(30), true);
    }, 100);
  } else {
    renderItems(list, false);
  }
  updateStats();
}

/**
 * 描画処理
 */
function renderItems(items, isAppend) {
  const container = document.getElementById("list");
  if (!isAppend) container.innerHTML = "";
  
  if (items.length === 0 && !isAppend) {
    container.innerHTML = '<div class="empty">該当する教材がありません。</div>';
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
          <span class="chip cat">${escapeHtml(item.category)}</span>
          <span class="chip sub">${escapeHtml(item.subject)}</span>
          <span class="chip pub">${escapeHtml(item.publisher)}</span>
        </div>
        <div class="item-name">${escapeHtml(item.name)}</div>
        <div class="item-id">コード: ${escapeHtml(item.id)}</div>
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
  const sendBtn = document.getElementById("sendBtn");
  if (sendBtn) {
    sendBtn.disabled = changed.length === 0;
    sendBtn.classList.toggle("dirty", changed.length > 0);
  }
}

async function sendData() {
  if (!state.roomKey) return;
  const changed = state.items.filter(i => (state.originalQtyMap[i.id] || 0) !== i.qty);
  if (changed.length === 0 || !confirm(`${changed.length}件の変更を保存しますか？`)) return;

  state.isSyncing = true;
  const btn = document.getElementById("sendBtn");
  btn.disabled = true;
  btn.textContent = "送信中...";

  try {
    const body = new URLSearchParams();
    body.append("room", state.roomKey);
    body.append("changedItems", JSON.stringify(changed.map(i => ({ id: i.id, qty: i.qty }))));

    const res = await fetch(GAS_URL, { method: "POST", body }).then(r => r.json());
    if (!res.success) throw new Error(res.message);

    changed.forEach(i => state.originalQtyMap[i.id] = i.qty);
    updateStats();
    alert("保存完了しました。");
  } catch (e) {
    alert("保存失敗: " + e.message);
  } finally {
    state.isSyncing = false;
    btn.textContent = "送信する";
    updateStats();
  }
}

function setStatus(msg) {
  const now = new Date().toLocaleTimeString("ja-JP");
  const el = document.getElementById("statusLine");
  if (el) el.textContent = `[${now}] ${msg}`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, m => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[m]));
}
