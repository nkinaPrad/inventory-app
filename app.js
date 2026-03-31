/**
 * ====================================================================
 * 教材在庫管理システム - フロントエンド・スクリプト
 * * 役割: 
 * 1. GAS(Google Apps Script)をバックエンドとして在庫データを同期
 * 2. 大量データの高速表示（チャンクレンダリング）
 * 3. 変更箇所のみを抽出して保存する「Dirtyチェック」機能
 * ====================================================================
 */

/**
 * =========================
 * 設定・定数
 * =========================
 */
// バックエンドとなるGASのWebアプリURL
const GAS_URL = "https://script.google.com/macros/s/AKfycbz0HdzSg-7ABwypga37Fb0sn7EYDb0CtJ7o83wXEEHjRAVKspAtqT1FNgHiGq89Sj5DrA/exec";

// 校舎キーと表示名のマッピング
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

const SEARCH_DEBOUNCE_MS = 120; // 検索入力時の負荷軽減（デバウンス）待機時間
const RENDER_CHUNK_SIZE = 80;   // 1フレームで描写するアイテム数（ブラウザのフリーズ防止）

/**
 * アプリケーションのグローバル状態（State）
 */
const state = {
  roomKey: "",             // URLパラメータから取得した校舎コード
  roomLabel: "",           // 表示用の校舎名
  items: [],               // 全教材データ（マスタ＋カスタム）
  itemsById: new Map(),    // ID検索を高速化するためのMap
  filteredItems: [],       // 検索やフィルタ適用後のリスト
  activeFilter: "all",     // 現在選択中のカテゴリフィルタ
  query: "",               // 検索窓の文字列
  isSyncing: false,        // 保存（通信）中フラグ
  totalQty: 0,             // 入力された合計在庫数
  dirtyCount: 0,           // 変更があった（未保存）アイテム数
  originalSnapshotMap: Object.create(null), // 読み込み時の状態を保持（変更検知用）
  renderToken: 0,          // 非同期レンダリングの競合を防ぐためのトークン
  lastUpdatedAt: "",       // 最終同期日時
  metaOpen: false          // 詳細パネルの開閉状態
};

/**
 * =========================
 * 起動処理
 * =========================
 */
document.addEventListener("DOMContentLoaded", async () => {
  // URLの "?room=takadanobaba" 等から校舎情報を取得
  const params = new URLSearchParams(location.search);
  state.roomKey = (params.get("room") || "").trim().toLowerCase();
  state.roomLabel = ROOM_LABEL_MAP[state.roomKey] || "";

  initUI();         // UIイベントの設定
  await loadAppData(); // データの取得と反映
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

  // 校舎情報の表示切り替え
  if (state.roomKey && state.roomLabel) {
    roomLabelEl.textContent = state.roomLabel;
  } else {
    // 校舎指定がない場合は保存不可の「閲覧モード」とする
    roomLabelEl.textContent = "閲覧モード";
    roomLabelEl.classList.add("muted");
    sendBtn.style.display = "none";
  }

  // 検索入力（デバウンス処理により入力停止後120msで実行）
  searchInput.addEventListener("input", debounce((e) => {
    state.query = String(e.target.value || "").trim().toLowerCase();
    applyFilterAndRender();
  }, SEARCH_DEBOUNCE_MS));

  // カテゴリチップのクリックイベント（委譲）
  filterArea.addEventListener("click", (e) => {
    const chip = e.target.closest(".f-chip");
    if (!chip) return;

    const next = chip.dataset.filter;
    if (!next || next === state.activeFilter) return;

    // アクティブな見た目の切り替え
    document.querySelectorAll(".f-chip").forEach(el => el.classList.remove("active"));
    chip.classList.add("active");

    state.activeFilter = next;
    applyFilterAndRender();
  });

  // リスト内の数量ボタン操作
  list.addEventListener("click", handleCounterClick);
  // 保存ボタン
  sendBtn.addEventListener("click", sendData);

  // ツールメニュー
  document.getElementById("toolMenuBtn").addEventListener("click", openToolMenu);
  document.getElementById("closeToolMenuBtn").addEventListener("click", closeToolMenu);
  document.getElementById("menuAddCustomBtn").addEventListener("click", () => {
    closeToolMenu();
    openCustomDialog();
  });
  
  // エクスポート・インポート
  document.getElementById("exportJsonBtn").addEventListener("click", exportJsonBackup);
  document.getElementById("exportCsvBtn").addEventListener("click", exportCsvBackup);
  document.getElementById("importJsonBtn").addEventListener("click", () => {
    closeToolMenu(); // 追加推奨
    document.getElementById("importFileInput").click();
  });
  document.getElementById("importFileInput").addEventListener("change", importJsonBackup);
  
  // マスタ外アイテム追加ダイアログ
  document.getElementById("cancelCustomBtn").addEventListener("click", closeCustomDialog);
  document.getElementById("customItemForm").addEventListener("submit", handleCustomItemSubmit);

  updateMetaInfo();
  updateMetaPanelUI();
}

/**
 * =========================
 * データ取得・同期
 * =========================
 */
async function loadAppData() {
  const started = performance.now();
  setStatus("データ同期中...");

  try {
    // 1. data.js（マスタデータ）が読み込まれているかチェック
    if (!Array.isArray(MASTER_DATA) || MASTER_DATA.length === 0) {
      throw new Error("data.js の読み込みに失敗しました。");
    }
    
    const masterData = MASTER_DATA;
    let invData = { success: true, inventory: {}, extraItems: [], updatedAt: "" };

    // 2. 校舎キーがあればGASから現在の在庫データを取得
    if (state.roomKey) {
      const invRes = await fetch(`${GAS_URL}?room=${encodeURIComponent(state.roomKey)}`, { cache: "no-store" });
      if (!invRes.ok) throw new Error("在庫データの取得に失敗しました。");
      invData = await invRes.json();
    }

    if (!invData.success) {
      throw new Error(invData.message || "在庫データ取得に失敗しました。");
    }

    // 3. 取得したデータをstateに展開
    buildStateFromServer(masterData, invData);

    // 4. 初期表示の構築
    generateCategoryChips();  // カテゴリボタン生成
    updateStatsUI();          // 統計（合計数など）更新
    applyFilterAndRender();   // リスト描画

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
    updateMetaInfo();
  }
}

/**
 * マスタデータとサーバー在庫データを統合してstateを構築
 */
function buildStateFromServer(masterData, invData) {
  const inventory = invData.inventory || {};
  const extraItems = Array.isArray(invData.extraItems) ? invData.extraItems : [];

  state.lastUpdatedAt = invData.updatedAt || "";
  state.items = [];
  state.itemsById = new Map();
  state.filteredItems = [];
  state.totalQty = 0;
  state.dirtyCount = 0;
  state.originalSnapshotMap = Object.create(null);

  // マスタデータの正規化と格納
  for (let i = 0; i < masterData.length; i++) {
    const m = masterData[i] || {};
    const id = String(m.id || "").trim();
    if (!id) continue;

    const item = normalizeItem({
      id,
      name: m.name || "名称不明",
      category: m.category || "未分類",
      subject: m.subject || "",
      publisher: m.publisher || "",
      edition: m.edition || "",
      qty: Number(inventory[id]) || 0, // サーバー側の数量を適用
      isCustom: false
    });

    pushItemToState(item);
  }

  // サーバーにのみ存在する「マスタ外」データの追加
  for (let i = 0; i < extraItems.length; i++) {
    const ex = normalizeItem({
      id: exOrDefault(extraItems[i]?.id, createCustomId_()),
      name: exOrDefault(extraItems[i]?.name, "名称未設定"),
      category: exOrDefault(extraItems[i]?.category, "未分類"),
      subject: exOrDefault(extraItems[i]?.subject, ""),
      publisher: exOrDefault(extraItems[i]?.publisher, ""),
      edition: exOrDefault(extraItems[i]?.edition, ""),
      qty: Number(extraItems[i]?.qty) || 0,
      isCustom: true
    });

    pushItemToState(ex);
  }
}

/**
 * 値が空の場合のフォールバック処理
 */
function exOrDefault(value, fallback) {
  const s = String(value == null ? "" : value).trim();
  return s || fallback;
}

/**
 * アイテムをstateに追加し、変更検知用のスナップショットを作成
 */
function pushItemToState(item) {
  if (!item.id) return;

  state.items.push(item);
  state.itemsById.set(item.id, item);
  // 初期状態をシリアライズして保持。これと比較して「変更あり」を判定する
  state.originalSnapshotMap[item.id] = snapshotKey(item);
  state.totalQty += item.qty;
}

/**
 * アイテムオブジェクトの型と検索用タグを生成
 */
function normalizeItem(src) {
  const item = {
    id: String(src.id || "").trim(),
    name: String(src.name || "名称不明").trim(),
    category: String(src.category || "未分類").trim(),
    subject: String(src.subject || "").trim(),
    publisher: String(src.publisher || "").trim(),
    edition: String(src.edition || "").trim(),
    qty: Math.max(0, Number(src.qty) || 0),
    isCustom: !!src.isCustom
  };

  // 検索ヒット率を上げるため、全項目を連結した小文字タグを作成
  item.searchTag = [
    item.id,
    item.name,
    item.category,
    item.subject,
    item.publisher,
    item.edition,
    item.isCustom ? "マスタ外" : ""
  ].join(" ").toLowerCase();

  return item;
}

/**
 * オブジェクトの状態を文字列化（同一判定用）
 */
function snapshotKey(item) {
  return JSON.stringify({
    name: item.name,
    category: item.category,
    subject: item.subject,
    publisher: item.publisher,
    edition: item.edition,
    qty: item.qty,
    isCustom: !!item.isCustom
  });
}

/**
 * 存在するカテゴリからフィルタボタン（チップ）を自動生成
 */
function generateCategoryChips() {
  const container = document.getElementById("filterArea");
  const categories = Array.from(
    new Set(state.items.map(item => item.category).filter(Boolean))
  ).sort();

  let html = "";
  html += `<button type="button" class="f-chip active" data-filter="all">すべて</button>`;
  html += `<button type="button" class="f-chip" data-filter="input">入力済み</button>`;
  html += `<button type="button" class="f-chip" data-filter="custom">マスタ外</button>`;

  for (let i = 0; i < categories.length; i++) {
    const c = categories[i];
    html += `<button type="button" class="f-chip" data-filter="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
  }

  container.innerHTML = html;
}

/**
 * 検索クエリとカテゴリフィルタを適用し、表示対象を決定する
 */
function applyFilterAndRender() {
  const q = state.query;
  const filter = state.activeFilter;
  const result = [];

  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];

    // 特殊フィルタ判定
    if (filter === "input") {
      if (item.qty <= 0) continue;
    } else if (filter === "custom") {
      if (!item.isCustom) continue;
    } else if (filter !== "all") {
      if (item.category !== filter) continue;
    }

    // 検索ワード判定
    if (q && !item.searchTag.includes(q)) continue;
    result.push(item);
  }

  // 表示順: カスタム品が上、次にカテゴリ順、最後に名称順
  result.sort(compareItems_);

  state.filteredItems = result;
  updateMetaInfo();
  renderFilteredItems(result);
}

function compareItems_(a, b) {
  if (a.isCustom !== b.isCustom) return a.isCustom ? -1 : 1;
  if (a.category !== b.category) return a.category.localeCompare(b.category, "ja");
  return a.name.localeCompare(b.name, "ja");
}

/**
 * 大量データの描画を分割して行う（UIスレッドを止めない工夫）
 */
function renderFilteredItems(items) {
  const container = document.getElementById("list");
  // 描画中に次の検索が行われた場合、古い描画を停止するためのトークン
  const token = ++state.renderToken;

  container.innerHTML = "";

  if (items.length === 0) {
    container.innerHTML = `<div class="empty">該当する教材がありません。</div>`;
    updateMetaInfo();
    return;
  }

  let cursor = 0;

  const renderChunk = () => {
    // 別のレンダリングが開始されていたら即座に中断
    if (token !== state.renderToken) return;

    const end = Math.min(cursor + RENDER_CHUNK_SIZE, items.length);
    let html = "";

    for (let i = cursor; i < end; i++) {
      html += renderItemHTML(items[i]);
    }

    container.insertAdjacentHTML("beforeend", html);
    cursor = end;

    // まだ残っていれば次のアニメーションフレームで描画
    if (cursor < items.length) {
      requestAnimationFrame(renderChunk);
    } else {
      updateMetaInfo();
    }
  };

  requestAnimationFrame(renderChunk);
}

/**
 * 教材カードのHTML生成
 */
function renderItemHTML(item) {
  const metaTexts = [];
  if (item.publisher) metaTexts.push(`出版社: ${item.publisher}`);
  if (item.edition) metaTexts.push(`版/準拠: ${item.edition}`);

  return `
    <article class="item ${item.qty > 0 ? "has-qty" : ""} ${item.isCustom ? "custom-item" : ""}" data-id="${escapeHtml(item.id)}">
      <div class="item-main">
        <div class="item-badges">
          <span class="badge badge-cat">${escapeHtml(item.category || "未分類")}</span>
          ${item.subject ? `<span class="badge badge-sub">${escapeHtml(item.subject)}</span>` : ""}
          ${item.publisher ? `<span class="badge badge-pub">${escapeHtml(item.publisher)}</span>` : ""}
          ${item.isCustom ? `<span class="badge badge-custom">マスタ外</span>` : ""}
        </div>

        <div class="item-name">${escapeHtml(item.name)}</div>
        <div class="item-meta-text">
          ${escapeHtml(item.id)}
          ${metaTexts.length ? ` / ${escapeHtml(metaTexts.join(" / "))}` : ""}
        </div>
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
 * 数量ボタン（＋/－）クリック時の処理
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

  // 状態更新
  item.qty = newQty;

  // DOMを直接書き換える（再レンダリングを避けて高速化）
  const qtyEl = card.querySelector(".qty-num");
  if (qtyEl) qtyEl.textContent = String(newQty);

  card.classList.toggle("has-qty", newQty > 0);

  // 変更検知と統計更新
  applyDirtyRecalcForItem(item);
  updateStatsUI();

  // 「入力済み」フィルタ中に0になったらリストから消去
  if (state.activeFilter === "input" && newQty === 0) {
    applyFilterAndRender();
  }
}

/**
 * アイテム単位での変更有無（Dirty）を判定
 */
function applyDirtyRecalcForItem(item) {
  const original = state.originalSnapshotMap[item.id] || "";
  const current = snapshotKey(item);

  const wasDirty = item.__dirty === true;
  const isDirty = current !== original;

  item.__dirty = isDirty;

  // 全体のDirtyカウントを増減
  if (!wasDirty && isDirty) state.dirtyCount++;
  if (wasDirty && !isDirty) state.dirtyCount--;

  recalcTotalQty();
}

/**
 * 全アイテムの変更状態を再計算（インポート時用）
 */
function recalcAllDirtyFlags() {
  let dirtyCount = 0;
  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    const isDirty = snapshotKey(item) !== (state.originalSnapshotMap[item.id] || "");
    item.__dirty = isDirty;
    if (isDirty) dirtyCount++;
  }
  state.dirtyCount = dirtyCount;
}

/**
 * 画面上の合計在庫数を計算
 */
function recalcTotalQty() {
  let total = 0;
  for (let i = 0; i < state.items.length; i++) {
    total += Number(state.items[i].qty) || 0;
  }
  state.totalQty = total;
}

/**
 * 変更件数や保存ボタンの活性・非活性を更新
 */
function updateStatsUI() {
  document.getElementById("changeCount").textContent = String(state.dirtyCount);
  document.getElementById("totalQty").textContent = String(state.totalQty);

  const sendBtn = document.getElementById("sendBtn");
  // 保存中は二重送信防止、変更がない場合はボタンを無効化
  sendBtn.disabled = state.isSyncing || state.dirtyCount === 0;
  sendBtn.classList.toggle("dirty", !state.isSyncing && state.dirtyCount > 0);
}

/**
 * 画面下部のメタ情報（件数・最終更新）の更新
 */
function updateMetaInfo() {
  const totalCountEl = document.getElementById("totalCount");
  const visibleCountEl = document.getElementById("visibleCount");
  const updatedEl = document.getElementById("updatedAt");

  if (totalCountEl) totalCountEl.textContent = `${state.items.length.toLocaleString()}件`;
  if (visibleCountEl) visibleCountEl.textContent = `${state.filteredItems.length.toLocaleString()}件`;
  if (updatedEl) updatedEl.textContent = state.lastUpdatedAt || "-";
}

/**
 * 詳細パネルの表示・非表示切り替え
 */
function toggleMetaPanel() {
  state.metaOpen = !state.metaOpen;
  updateMetaPanelUI();
}

function updateMetaPanelUI() {
  const panel = document.getElementById("metaPanel");
  const btn = document.getElementById("metaToggleBtn");
  panel.classList.toggle("open", state.metaOpen);
  btn.textContent = state.metaOpen ? "詳細を閉じる" : "詳細を表示";
}

/**
 * =========================
 * サーバー保存（GAS POST送信）
 * =========================
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

    // 送信用データの作成（全アイテムを送信する仕様）
    const payload = state.items.map(item => ({
      id: item.id,
      name: item.name,
      category: item.category,
      subject: item.subject,
      publisher: item.publisher,
      edition: item.edition,
      qty: item.qty,
      isCustom: !!item.isCustom
    }));

    const params = new URLSearchParams();
    params.append("room", state.roomKey);
    params.append("payload", JSON.stringify(payload));

    // GAS Web AppへPOST送信（no-cors モード）
    await fetch(GAS_URL, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });

    // 保存成功後、現在の状態を「初期状態」として再定義
    refreshOriginalSnapshotsAfterSave();
    state.lastUpdatedAt = formatNowJa();

    updateStatsUI();
    updateMetaInfo();
    setStatus("保存リクエスト送信完了");
    alert("保存リクエストを送信しました。\n（反映には数秒かかる場合があります）");

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
 * 保存後、比較用スナップショットを現在の値で更新する
 */
function refreshOriginalSnapshotsAfterSave() {
  state.originalSnapshotMap = Object.create(null);
  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    state.originalSnapshotMap[item.id] = snapshotKey(item);
    item.__dirty = false;
  }
  state.dirtyCount = 0;
}

/**
 * =========================
 * マスタ外教材の追加機能
 * =========================
 */
function openCustomDialog() {
  document.getElementById("customItemDialog").showModal();
}

function closeCustomDialog() {
  document.getElementById("customItemDialog").close();
}

/**
 * ダイアログのフォーム送信処理
 */
function handleCustomItemSubmit(e) {
  e.preventDefault();

  const name = document.getElementById("customName").value.trim();
  const category = document.getElementById("customCategory").value.trim() || "未分類";
  const subject = document.getElementById("customSubject").value.trim();
  const publisher = document.getElementById("customPublisher").value.trim();
  const edition = document.getElementById("customEdition").value.trim();
  const qty = Math.max(0, Number(document.getElementById("customQty").value) || 0);

  if (!name) {
    alert("教材名を入力してください。");
    return;
  }

  const item = normalizeItem({
    id: createCustomId_(),
    name,
    category,
    subject,
    publisher,
    edition,
    qty,
    isCustom: true
  });

  // リストの先頭に追加
  state.items.unshift(item);
  state.itemsById.set(item.id, item);
  state.originalSnapshotMap[item.id] = ""; // 初期状態は空なので即座にDirty判定される
  item.__dirty = true;
  state.dirtyCount++;

  recalcTotalQty();
  generateCategoryChips();
  updateStatsUI();
  applyFilterAndRender();

  document.getElementById("customItemForm").reset();
  document.getElementById("customQty").value = "1";
  closeCustomDialog();
  setStatus("マスタ外教材を追加しました。未保存の状態です。");
}

/**
 * 重複しにくいカスタムIDの生成
 */
function createCustomId_() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `CUSTOM-${Date.now()}-${rand}`;
}

/**
 * =========================
 * バックエンド連携・バックアップ
 * =========================
 */

/**
 * 現在の状態をJSONでダウンロード
 */
function exportJsonBackup() {
  const data = {
    exportedAt: formatNowJa(),
    roomKey: state.roomKey,
    roomLabel: state.roomLabel,
    lastUpdatedAt: state.lastUpdatedAt,
    items: state.items.map(item => ({
      id: item.id,
      name: item.name,
      category: item.category,
      subject: item.subject,
      publisher: item.publisher,
      edition: item.edition,
      qty: item.qty,
      isCustom: !!item.isCustom
    }))
  };

  downloadTextFile_(
    `${buildFileBaseName_()}_${formatNowFile_()}.json`,
    JSON.stringify(data, null, 2),
    "application/json"
  );
  setStatus("JSONバックアップを出力しました。");
}

/**
 * 現在の状態をCSVでダウンロード（Excel対応のBOM付きUTF-8）
 */
function exportCsvBackup() {
  const rows = [
    ["校舎", "出力日時", "ID", "教材名", "カテゴリ", "教科", "出版社", "版/準拠", "数量", "マスタ外"]
  ];
  const exportedAt = formatNowJa();

  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    rows.push([
      state.roomLabel,
      exportedAt,
      item.id,
      item.name,
      item.category,
      item.subject,
      item.publisher,
      item.edition,
      item.qty,
      item.isCustom ? "1" : "0"
    ]);
  }

  const csv = rows.map(row => row.map(csvEscape_).join(",")).join("\r\n");

  downloadTextFile_(
    `${buildFileBaseName_()}_${formatNowFile_()}.csv`,
    "\uFEFF" + csv, // Excel用BOM
    "text/csv;charset=utf-8"
  );
  setStatus("CSVバックアップを出力しました。");
}

/**
 * ファイルダウンロードの共通処理
 */
function downloadTextFile_(filename, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildFileBaseName_() {
  return `inventory_${state.roomKey || "viewer"}`;
}

/**
 * ファイル名用のタイムスタンプ生成 (YYYYMMDD_HHMMSS)
 */
function formatNowFile_() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

/**
 * CSV値のエスケープ（カンマやダブルクォートへの対応）
 */
function csvEscape_(value) {
  const s = String(value == null ? "" : value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * バックアップJSONを読み込んで画面に反映
 */
function importJsonBackup(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const reader = new FileReader();

  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result || "{}"));
      if (!Array.isArray(data.items)) {
        throw new Error("items 配列が見つかりません。");
      }

      // インポートデータの展開
      const nextItems = data.items.map(item => normalizeItem(item));
      state.items = nextItems;
      state.itemsById = new Map();
      for (let i = 0; i < nextItems.length; i++) {
        state.itemsById.set(nextItems[i].id, nextItems[i]);
      }

      // UIと状態の同期
      recalcAllDirtyFlags();
      recalcTotalQty();
      generateCategoryChips();
      applyFilterAndRender();
      updateStatsUI();

      setStatus("JSONバックアップを読み込みました。保存前のため未反映です。");
      alert("JSONを取り込みました。\nこの時点ではまだサーバー保存されていません。");

    } catch (err) {
      console.error(err);
      alert(`JSON取込に失敗しました: ${err.message}`);
      setStatus(`JSON取込失敗: ${err.message}`);
    } finally {
      e.target.value = ""; // 同じファイルを再度選択できるようにクリア
    }
  };

  reader.onerror = () => {
    alert("ファイルの読み込みに失敗しました。");
    e.target.value = "";
  };

  reader.readAsText(file, "utf-8");
}

/**
 * 画面上のステータス行を更新
 */
function setStatus(msg) {
  const now = new Date().toLocaleTimeString("ja-JP");
  const el = document.getElementById("statusLine");
  if (el) {
    el.textContent = `[${now}] ${msg}`;
  }
}

/**
 * 連続実行を抑制する関数
 */
function debounce(fn, wait) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

/**
 * 表示用の日付フォーマット (YYYY/MM/DD HH:mm:ss)
 */
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

/**
 * HTMLの特殊文字をエスケープ（XSS対策）
 */
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
