/**
 * 設定（URLはご自身の環境に合わせて変更）
 */
const GITHUB_JSON_URL = "https://raw.githubusercontent.com/nkinaPrad/inventory-app/main/data.json";
const GAS_URL = "https://script.google.com/macros/s/AKfycbw5yPowePXxsCLHh8zydHPSUOwQfFRIZ-J49p-F_tnlLWwVpZM3i1jvlzt99_8VWT_VIw/exec";

// 拠点キーと表示名のマッピング
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

// パフォーマンス設定
const RENDER_CHUNK_SIZE = 60; // 1回に描画するアイテム数（ブラウザの負荷軽減）
const SEARCH_DEBOUNCE_MS = 120; // 検索時の入力待ち時間（連続実行の防止）

/**
 * アプリケーションの状態管理（State）
 */
const state = {
  roomKey: null,      // 現在の拠点（URLパラメータから取得）
  roomLabel: "",      // 拠点名
  items: [],          // 全アイテムデータ
  itemsById: new Map(), // ID検索用のMap
  filteredItems: [],  // フィルタ/検索適用後のアイテム
  activeFilter: "all",// 現在選択中のカテゴリフィルタ
  query: "",          // 検索ワード
  originalQtyMap: Object.create(null), // 保存時の差分計算用（初期在庫数）
  isSyncing: false,   // 通信中フラグ
  totalQty: 0,        // 合計在庫数
  dirtyCount: 0,      // 変更があったアイテムの数
  renderToken: 0      // 描画の競合防止用トークン
};

/**
 * アプリ起動時の処理
 */
document.addEventListener("DOMContentLoaded", async () => {
  // URLパラメータ (?room=xxx) から拠点を取得
  const params = new URLSearchParams(location.search);
  state.roomKey = (params.get("room") || "").trim().toLowerCase();
  state.roomLabel = ROOM_LABEL_MAP[state.roomKey] || "";

  initUI();         // UIイベントの設定
  await loadAppData(); // データの読み込み
});

/**
 * UI初期化・イベントリスナーの設定
 */
function initUI() {
  const roomLabelEl = document.getElementById("roomLabel");
  const sendBtn = document.getElementById("sendBtn");
  const searchInput = document.getElementById("searchInput");
  const filterArea = document.getElementById("filterArea");
  const list = document.getElementById("list");

  // 拠点情報の表示制御（拠点がない場合は閲覧モード）
  if (state.roomKey && state.roomLabel) {
    roomLabelEl.textContent = state.roomLabel;
  } else {
    roomLabelEl.textContent = "閲覧モード";
    roomLabelEl.classList.add("muted");
    sendBtn.style.display = "none";
  }

  // 検索入力（デバウンス処理付き）
  searchInput.addEventListener(
    "input",
    debounce((e) => {
      state.query = (e.target.value || "").trim().toLowerCase();
      applyFilterAndRender();
    }, SEARCH_DEBOUNCE_MS)
  );

  // カテゴリチップのクリックイベント
  filterArea.addEventListener("click", (e) => {
    const chip = e.target.closest(".f-chip");
    if (!chip) return;

    const nextFilter = chip.dataset.filter;
    if (nextFilter === state.activeFilter) return;

    // アクティブ表示の切り替え
    document.querySelectorAll(".f-chip").forEach(el => el.classList.remove("active"));
    chip.classList.add("active");

    state.activeFilter = nextFilter;
    applyFilterAndRender();
  });

  // リスト内の「＋」「－」ボタン（イベント委譲で効率化）
  list.addEventListener("click", handleCounterClick);

  // 送信ボタン
  sendBtn.addEventListener("click", sendData);
}

/**
 * マスタデータと在庫データの取得
 */
async function loadAppData() {
  const startedAt = performance.now();
  setStatus("データ同期中...");

  try {
    let masterData;
    let inventoryData = { success: true, inventory: {} };

    if (state.roomKey) {
      // 拠点指定がある場合：マスタと在庫を並列で取得
      const [masterRes, invRes] = await Promise.all([
        fetch(GITHUB_JSON_URL, { cache: "no-store" }),
        fetch(`${GAS_URL}?room=${encodeURIComponent(state.roomKey)}`, { cache: "no-store" })
      ]);

      if (!masterRes.ok) throw new Error("マスタデータの取得に失敗しました。");
      if (!invRes.ok) throw new Error("在庫データの取得に失敗しました。");

      masterData = await masterRes.json();
      inventoryData = await invRes.json();
    } else {
      // 拠点指定がない場合：マスタのみ取得
      const masterRes = await fetch(GITHUB_JSON_URL, { cache: "no-store" });
      if (!masterRes.ok) throw new Error("マスタデータの取得に失敗しました。");
      masterData = await masterRes.json();
    }

    if (!Array.isArray(masterData)) throw new Error("マスタデータの形式が不正です。");
    if (!inventoryData.success) throw new Error(inventoryData.message || "在庫データ取得に失敗しました。");

    const inventory = inventoryData.inventory || {};
    state.originalQtyMap = Object.assign(Object.create(null), inventory);
    state.items = [];
    state.itemsById.clear();
    state.totalQty = 0;
    state.dirtyCount = 0;

    // データの正規化と検索用タグの作成
    for (let i = 0; i < masterData.length; i++) {
      const m = masterData[i] || {};
      const id = String(m.id || "").trim();
      if (!id) continue;

      const qty = Number(inventory[id]) || 0;
      const item = {
        id: id,
        name: m.name || "名称不明",
        category: m.category || "未分類",
        subject: m.subject || "",
        publisher: m.publisher || "",
        qty: qty,
        // 高速検索用に複数の項目を結合した小文字の文字列を用意
        searchTag: `${id} ${m.name || ""} ${m.category || ""} ${m.subject || ""} ${m.publisher || ""}`.toLowerCase()
      };

      state.items.push(item);
      state.itemsById.set(id, item);
      state.totalQty += qty;
    }

    generateCategoryChips(); // カテゴリボタン作成
    updateStatsUI();         // 統計表示更新
    applyFilterAndRender();  // リスト描画

    const sec = ((performance.now() - startedAt) / 1000).toFixed(2);
    setStatus(state.roomKey ? `同期完了: ${sec}秒` : `閲覧モードで起動: ${sec}秒`);
  } catch (err) {
    console.error(err);
    setStatus(`取得失敗: ${err.message}`);
    document.getElementById("list").innerHTML =
      `<div class="empty">データ取得に失敗しました。<br>${escapeHtml(err.message)}</div>`;
  }
}

/**
 * データに基づいてカテゴリ選択チップを生成
 */
function generateCategoryChips() {
  const filterArea = document.getElementById("filterArea");
  // 重複を除去してソートしたカテゴリリストを作成
  const categories = Array.from(new Set(state.items.map(item => item.category).filter(Boolean))).sort();

  let html = '';
  html += `<button type="button" class="f-chip active" data-filter="all">すべて</button>`;
  html += `<button type="button" class="f-chip" data-filter="input">入力済</button>`;

  for (let i = 0; i < categories.length; i++) {
    const c = categories[i];
    html += `<button type="button" class="f-chip" data-filter="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
  }

  filterArea.innerHTML = html;
}

/**
 * 現在の検索条件とカテゴリフィルタに基づいてデータを抽出
 */
function applyFilterAndRender() {
  const q = state.query;
  const filter = state.activeFilter;
  const result = [];

  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];

    // カテゴリフィルタ判定
    if (filter === "input") {
      if (item.qty <= 0) continue;
    } else if (filter !== "all") {
      if (item.category !== filter) continue;
    }

    // 検索ワード判定
    if (q && !item.searchTag.includes(q)) continue;

    result.push(item);
  }

  state.filteredItems = result;
  renderFilteredItems(result);
}

/**
 * フィルタリングされたアイテムを非同期（チャンク形式）で描画
 * 大量データでもブラウザがフリーズしないように分割して処理
 */
function renderFilteredItems(items) {
  const container = document.getElementById("list");
  const token = ++state.renderToken; // 描画中に別の描画が始まったら中断するためのトークン

  container.innerHTML = "";

  if (items.length === 0) {
    container.innerHTML = `<div class="empty">該当する教材がありません。</div>`;
    return;
  }

  let cursor = 0;

  const renderChunk = () => {
    // 別の描画処理が開始されていたら、この描画を中止
    if (token !== state.renderToken) return;

    const end = Math.min(cursor + RENDER_CHUNK_SIZE, items.length);
    let html = "";

    for (let i = cursor; i < end; i++) {
      html += renderItemHTML(items[i]);
    }

    // 末尾に追加（高速）
    container.insertAdjacentHTML("beforeend", html);
    cursor = end;

    // まだアイテムが残っていれば次のフレームで描画
    if (cursor < items.length) {
      requestAnimationFrame(renderChunk);
    }
  };

  requestAnimationFrame(renderChunk);
}

/**
 * 1つ1つのアイテムカードのHTMLを生成
 */
function renderItemHTML(item) {
  return `
    <article class="item ${item.qty > 0 ? "has-qty" : ""}" data-id="${escapeHtml(item.id)}">
      <div class="item-info">
        <div class="item-top">
          <span class="chip cat">${escapeHtml(item.category)}</span>
          ${item.subject ? `<span class="chip sub">${escapeHtml(item.subject)}</span>` : ""}
          ${item.publisher ? `<span class="chip pub">${escapeHtml(item.publisher)}</span>` : ""}
        </div>
        <div class="item-name">${escapeHtml(item.name)}</div>
        <div class="item-id">コード: ${escapeHtml(item.id)}</div>
      </div>
      <div class="counter">
        <button type="button" class="counter-btn minus" aria-label="減らす">－</button>
        <div class="qty">${item.qty}</div>
        <button type="button" class="counter-btn plus" aria-label="増やす">＋</button>
      </div>
    </article>
  `;
}

/**
 * カウンターボタン（＋－）のクリック処理
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

  // 数量の増減
  if (btn.classList.contains("plus")) {
    newQty = oldQty + 1;
  } else if (btn.classList.contains("minus")) {
    newQty = oldQty > 0 ? oldQty - 1 : 0;
  } else {
    return;
  }

  if (newQty === oldQty) return;

  item.qty = newQty;

  // UIの即時更新
  const qtyEl = card.querySelector(".qty");
  if (qtyEl) qtyEl.textContent = String(newQty);
  card.classList.toggle("has-qty", newQty > 0);

  // 統計情報（合計数や変更件数）の更新
  applyStatsDelta(item.id, oldQty, newQty);

  // 「入力済」フィルタ中は 0 になったアイテムを消すために再描画
  if (state.activeFilter === "input" && newQty === 0) {
    applyFilterAndRender();
  }
}

/**
 * 在庫変動時の数値計算（メモリ上の値のみ）
 */
function applyStatsDelta(id, oldQty, newQty) {
  state.totalQty += (newQty - oldQty);

  const originalQty = Number(state.originalQtyMap[id]) || 0;
  const wasDirty = oldQty !== originalQty; // 元の在庫数と違っていたか
  const isDirty = newQty !== originalQty;  // 現在、元の在庫数と違うか

  // 変更ありフラグ（保存ボタンの有効化判定に使用）
  if (!wasDirty && isDirty) state.dirtyCount++;
  if (wasDirty && !isDirty) state.dirtyCount--;

  updateStatsUI();
}

/**
 * ヘッダー等の統計UI（変更件数、合計部数）を更新
 */
function updateStatsUI() {
  document.getElementById("changeCount").textContent = String(state.dirtyCount);
  document.getElementById("totalQty").textContent = String(state.totalQty);

  const sendBtn = document.getElementById("sendBtn");
  if (!sendBtn) return;

  // 変更がある時だけボタンを活性化
  sendBtn.disabled = state.dirtyCount === 0 || state.isSyncing;
  sendBtn.classList.toggle("dirty", state.dirtyCount > 0 && !state.isSyncing);
}

/**
 * 変更されたデータをGASにPOST送信して保存
 */
async function sendData() {
  if (!state.roomKey || state.isSyncing) return;
  if (state.dirtyCount === 0) return;

  // 変更があったアイテムのみを抽出
  const changed = [];
  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    const originalQty = Number(state.originalQtyMap[item.id]) || 0;
    if (item.qty !== originalQty) {
      changed.push({ id: item.id, qty: item.qty });
    }
  }

  if (changed.length === 0) return;

  const ok = confirm(`${changed.length}件の変更を保存しますか？`);
  if (!ok) return;

  const btn = document.getElementById("sendBtn");

  try {
    state.isSyncing = true;
    btn.disabled = true;
    btn.textContent = "送信中...";
    setStatus("保存中...");

    // GASが受け取れるように URLSearchParams 形式に変換
    const body = new URLSearchParams();
    body.append("room", state.roomKey);
    body.append("changedItems", JSON.stringify(changed));

    const res = await fetch(GAS_URL, {
      method: "POST",
      body: body
    });

    if (!res.ok) throw new Error("通信に失敗しました。");

    const json = await res.json();
    if (!json.success) throw new Error(json.message || "保存に失敗しました。");

    // 保存成功後：現在の値を「初期在庫」として上書き
    for (let i = 0; i < changed.length; i++) {
      state.originalQtyMap[changed[i].id] = changed[i].qty;
    }

    // 変更件数（dirtyCount）を 0 にリセット
    state.dirtyCount = 0;

    updateStatsUI();
    setStatus("保存完了");
    alert("保存完了しました。");
  } catch (err) {
    console.error(err);
    setStatus(`保存失敗: ${err.message}`);
    alert(`保存失敗: ${err.message}`);
  } finally {
    state.isSyncing = false;
    btn.textContent = "送信する";
    updateStatsUI();
  }
}

/**
 * 画面下部のステータスラインを更新
 */
function setStatus(msg) {
  const now = new Date().toLocaleTimeString("ja-JP");
  const el = document.getElementById("statusLine");
  if (el) {
    el.textContent = `[${now}] ${msg}`;
  }
}

/**
 * 連続実行を抑制する関数（検索窓の入力負荷軽減）
 */
function debounce(fn, wait) {
  let timer = null;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

/**
 * HTMLインジェクション（XSS攻撃）を防ぐためのエスケープ処理
 */
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function(ch) {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[ch];
  });
}
