/**
 * 設定（URLを環境に合わせて修正してください）
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
  
  if (!state.roomKey) {
    alert("URLに ?room=校舎名 を指定してください。");
    return;
  }

  initUI();
  await loadAppData();
});

// UI初期化
function initUI() {
  document.getElementById("roomLabel").textContent = state.roomKey.toUpperCase();
  
  // 検索イベント
  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.query = e.target.value.trim().toLowerCase();
    applyFilterAndRender();
  });

  // フィルタチップクリック
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
 * データ取得（GitHubマスタ + GAS在庫の並列取得）
 */
async function loadAppData() {
  const startTime = performance.now();
  setStatus("データ同期中...");

  try {
    const [masterRes, invRes] = await Promise.all([
      fetch(GITHUB_JSON_URL).then(r => r.json()),
      fetch(`${GAS_URL}?room=${state.roomKey}`).then(r => r.json())
    ]);

    if (!invRes.success) throw new Error(invRes.message);

    const inventory = invRes.inventory || {};
    state.originalQtyMap = { ...inventory };

    // 日本語キーでのマッピング
    state.items = masterRes.map(m => {
      const id = String(m["商品コード"] || "");
      return {
        id: id,
        name: m["商品名"] || "名称不明",
        category: m["マスタ区分"] || "未分類",
        subject: m["科目"] || "",
        publisher: m["出版社"] || "",
        qty: inventory[id] || 0,
        _searchTag: `${id} ${m["商品名"]} ${m["マスタ区分"]} ${m["科目"]} ${m["出版社"]}`.toLowerCase()
      };
    });

    generateCategoryChips();
    applyFilterAndRender(true); // 初回描画（分割ロジック適用）

    const totalTime = ((performance.now() - startTime) / 1000).toFixed(2);
    setStatus(`完了: ${totalTime}秒`);
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

  // 分割描画ロジック
  if (isInitial && list.length > 30) {
    renderItems(list.slice(0, 30), false); // 先に30件
    setTimeout(() => {
      renderItems(list.slice(30), true);  // 0.1秒後に残りを追加
    }, 100);
  } else {
    renderItems(list, false);
  }
  updateStats();
}

/**
 * DOM描画（DocumentFragmentで高速化）
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
          ${item.category ? `<span class="chip cat">${escapeHtml(item.category)}</span>` : ''}
          ${item.subject ? `<span class="chip sub">${escapeHtml(item.subject)}</span>` : ''}
          ${item.publisher ? `<span class="chip pub">${escapeHtml(item.publisher)}</span>` : ''}
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

/**
 * カテゴリチップ生成
 */
function generateCategoryChips() {
  const categories = [...new Set(state.items.map(i => i.category))].filter(Boolean).sort();
  const container = document.getElementById("filterArea");
  container.innerHTML = `
    <div class="f-chip active" data-filter="all">すべて</div>
    <div class="f-chip" data-filter="input">入力済</div>
    ${categories.map(c => `<div class="f-chip" data-filter="${escapeHtml(c)}">${escapeHtml(c)}</div>`).join("")}
  `;
}

/**
 * カウンター操作
 */
function handleCounter(e) {
  const btn = e.target.closest("button");
  if (!btn) return;
  
  const card = btn.closest(".item");
  const id = card.dataset.id;
  const item = state.items.find(i => i.id === id);

  if (btn.classList.contains("plus")) {
    item.qty++;
  } else if (btn.classList.contains("minus")) {
    item.qty = Math.max(0, item.qty - 1);
  }

  card.querySelector(".qty").textContent = item.qty;
  card.classList.toggle("has-qty", item.qty > 0);
  updateStats();
}

/**
 * 統計情報の更新
 */
function updateStats() {
  const changed = state.items.filter(i => (state.originalQtyMap[i.id] || 0) !== i.qty);
  const total = state.items.reduce((sum, i) => sum + i.qty, 0);
  
  document.getElementById("changeCount").textContent = changed.length;
  document.getElementById("totalQty").textContent = total;
  
  const sendBtn = document.getElementById("sendBtn");
  sendBtn.disabled = changed.length === 0;
  sendBtn.classList.toggle("dirty", changed.length > 0);
}

/**
 * GASへデータ送信
 */
async function sendData() {
  const changed = state.items.filter(i => (state.originalQtyMap[i.id] || 0) !== i.qty);
  if (changed.length === 0) return;

  if (!confirm(`${changed.length}件の変更を保存しますか？`)) return;

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

    // 成功したらオリジナルを更新
    changed.forEach(i => state.originalQtyMap[i.id] = i.qty);
    updateStats();
    alert("保存完了しました。");
  } catch (e) {
    alert("エラー: " + e.message);
  } finally {
    state.isSyncing = false;
    btn.textContent = "送信する";
    updateStats();
  }
}

function setStatus(msg) {
  const now = new Date().toLocaleTimeString("ja-JP");
  document.getElementById("statusLine").textContent = `[${now}] ${msg}`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, m => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[m]));
}
