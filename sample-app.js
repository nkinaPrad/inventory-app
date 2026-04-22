(() => {
  const INITIAL_VISIBLE_COUNT = 30;
  const LOAD_MORE_COUNT = 30;

  const state = {
    items: [],
    itemsById: new Map(),
    filteredItems: [],
    activeCategoryFilter: "all",
    showOnlyInputted: false,
    query: "",
    visibleCount: INITIAL_VISIBLE_COUNT,
    dirtyCount: 0,
    totalQty: 0,
    originalSnapshotMap: Object.create(null),
  };

  document.addEventListener("DOMContentLoaded", () => {
    initSample();
    initUI();
    generateCategoryChips();
    applyFilterAndRender();
    updateStatsUI();
    setInfoMessage("サンプルページです。保存・送信は行われません。");
  });

  function initSample() {
    const masterData =
      typeof MASTER_DATA !== "undefined" && Array.isArray(MASTER_DATA)
        ? MASTER_DATA
        : [];

    state.items = [];
    state.itemsById = new Map();
    state.originalSnapshotMap = Object.create(null);
    state.activeCategoryFilter = "all";
    state.showOnlyInputted = false;
    state.query = "";
    state.visibleCount = INITIAL_VISIBLE_COUNT;

    masterData.forEach((raw) => {
      const item = normalizeItem({
        id: raw.id,
        category: raw.category,
        subject: raw.subject,
        name: raw.name,
        publisher: raw.publisher,
        edition: raw.edition,
        qty: 0,
        isCustom: false,
      });
      pushItem(item);
      state.originalSnapshotMap[item.id] = snapshotKey(item);
    });

    recalcStats();
  }

  function initUI() {
    const dirtyCountEl = document.getElementById("dirtyCount");
    const sendBtn = document.getElementById("sendBtn");
    const bottomActions = document.querySelector(".bottom-actions");

    if (dirtyCountEl && bottomActions) {
      const dirtyCountWrap = dirtyCountEl.parentElement;
      dirtyCountEl.classList.add("bottom-status");
      bottomActions.insertBefore(dirtyCountEl, sendBtn || null);
      if (dirtyCountWrap && dirtyCountWrap.childElementCount === 0) {
        dirtyCountWrap.remove();
      }
    }

    document.getElementById("searchInput")?.addEventListener("input", (event) => {
      state.query = normalizeText(event.target.value);
      state.visibleCount = INITIAL_VISIBLE_COUNT;
      syncSearchClearButton();
      applyFilterAndRender();
    });

    document.getElementById("searchClearBtn")?.addEventListener("click", () => {
      const input = document.getElementById("searchInput");
      if (!input) return;
      input.value = "";
      state.query = "";
      state.visibleCount = INITIAL_VISIBLE_COUNT;
      syncSearchClearButton();
      applyFilterAndRender();
      input.focus();
    });

    document.getElementById("filterArea")?.addEventListener("click", (event) => {
      const chip = event.target.closest(".f-chip[data-filter]");
      if (!chip) return;
      state.activeCategoryFilter = chip.dataset.filter || "all";
      state.visibleCount = INITIAL_VISIBLE_COUNT;
      generateCategoryChips();
      applyFilterAndRender();
    });

    document.getElementById("inputOnlyToggle")?.addEventListener("click", () => {
      state.showOnlyInputted = !state.showOnlyInputted;
      state.visibleCount = INITIAL_VISIBLE_COUNT;
      syncInputOnlyToggleUI();
      applyFilterAndRender();
    });

    document.getElementById("list")?.addEventListener("click", handleListClick);
    document.getElementById("list")?.addEventListener("input", handleQtyInput);
    document.getElementById("sendBtn")?.addEventListener("click", handleSampleSave);

    document
      .getElementById("toolMenuBtnAddCustom")
      ?.addEventListener("click", openCustomDialog);
    document
      .getElementById("toolMenuBtn")
      ?.addEventListener("click", () => openModal("toolMenuDialog"));
    document
      .getElementById("closeToolMenuBtn")
      ?.addEventListener("click", () => closeModal("toolMenuDialog"));
    document
      .getElementById("completeInventoryBtn")
      ?.addEventListener("click", handleSampleComplete);
    document
      .getElementById("viewInputtedListBtn")
      ?.addEventListener("click", openInputtedItemsDialog);

    ["exportCsvBtn", "exportJsonBtn", "importJsonBtn"].forEach((id) => {
      document.getElementById(id)?.addEventListener("click", () => {
        setInfoMessage("サンプルページのため、この操作は実行されません。");
      });
    });

    document
      .getElementById("closeInputtedItemsBtn")
      ?.addEventListener("click", () => closeModal("inputtedItemsDialog"));

    document
      .getElementById("closeCustomDialogBtn")
      ?.addEventListener("click", closeCustomDialog);
    document
      .getElementById("cancelCustomBtn")
      ?.addEventListener("click", closeCustomDialog);
    document
      .getElementById("customQtyMinus")
      ?.addEventListener("click", () => changeCustomQty(-1));
    document
      .getElementById("customQtyPlus")
      ?.addEventListener("click", () => changeCustomQty(1));
    document
      .getElementById("customItemForm")
      ?.addEventListener("submit", addCustomItem);
  }

  function handleListClick(event) {
    const loadMoreBtn = event.target.closest("#loadMoreBtn");
    if (loadMoreBtn) {
      state.visibleCount += LOAD_MORE_COUNT;
      renderFilteredItems();
      return;
    }

    const itemEl = event.target.closest(".item[data-id]");
    if (!itemEl) return;

    const item = state.itemsById.get(itemEl.dataset.id);
    if (!item) return;

    if (event.target.classList.contains("plus")) {
      item.qty += 1;
      markChanged();
    }

    if (event.target.classList.contains("minus")) {
      item.qty = Math.max(0, item.qty - 1);
      markChanged();
    }
  }

  function handleQtyInput(event) {
    if (!event.target.classList.contains("qty-input")) return;

    const itemEl = event.target.closest(".item[data-id]");
    const item = state.itemsById.get(itemEl?.dataset.id || "");
    if (!item) return;

    item.qty = sanitizeQty(event.target.value);
    markChanged();
  }

  function markChanged() {
    recalcStats();
    updateStatsUI();
    applyFilterAndRender();
  }

  function handleSampleSave() {
    setInfoMessage("サンプルページのため、保存は実行されません。");
    updateStatsUI();
  }

  function handleSampleComplete() {
    setInfoMessage("サンプルページのため、本部への送信は実行されません。");
    closeModal("toolMenuDialog");
  }

  function generateCategoryChips() {
    const container = document.getElementById("filterArea");
    if (!container) return;

    const categories = Array.from(
      new Set(
        state.items
          .filter((item) => !item.isCustom)
          .map((item) => item.category)
          .filter(Boolean),
      ),
    );
    const hasCustom = state.items.some((item) => item.isCustom);

    const buttons = [
      renderFilterChip("all", "すべて", "chip-all"),
      ...categories.map((category) => renderFilterChip(category, category)),
    ];

    if (hasCustom) {
      buttons.push(renderFilterChip("custom", "未登録教材", "chip-custom"));
    }

    container.innerHTML = `
      <div class="filter-section filter-section-category">
        <div class="filter-chip-row">${buttons.join("")}</div>
      </div>
    `;
  }

  function renderFilterChip(value, label, extraClass = "") {
    const activeClass = state.activeCategoryFilter === value ? " active" : "";
    return `
      <button
        type="button"
        class="f-chip ${extraClass}${activeClass}"
        data-filter="${escapeHtml(value)}"
      >${escapeHtml(label)}</button>
    `;
  }

  function applyFilterAndRender() {
    state.filteredItems = state.items.filter((item) => {
      if (state.query && !item.searchTag.includes(state.query)) return false;
      if (state.showOnlyInputted && item.qty <= 0) return false;
      if (state.activeCategoryFilter === "custom") return item.isCustom;
      if (item.isCustom) return false;
      if (state.activeCategoryFilter === "all") return true;
      return item.category === state.activeCategoryFilter;
    });

    renderFilteredItems();
  }

  function renderFilteredItems() {
    const container = document.getElementById("list");
    if (!container) return;

    if (state.filteredItems.length === 0) {
      container.innerHTML = `<div class="empty">${escapeHtml(getEmptyMessage())}</div>`;
      return;
    }

    const visibleItems = state.filteredItems.slice(0, state.visibleCount);
    let html = visibleItems.map(renderItemHTML).join("");

    if (state.filteredItems.length > state.visibleCount) {
      const remain = state.filteredItems.length - state.visibleCount;
      html += `
        <div class="empty" style="padding:24px 16px;">
          <button id="loadMoreBtn" type="button" class="btn-subtle">さらに表示（あと${remain}件）</button>
        </div>
      `;
    }

    container.innerHTML = html;
  }

  function renderItemHTML(item) {
    const hasQty = item.qty > 0;
    const topMeta = [item.publisher].filter(Boolean).join(" / ");

    return `
      <article class="item ${hasQty ? "has-qty" : ""} ${
        item.isCustom ? "custom-item" : ""
      }" data-id="${escapeHtml(item.id)}">
        <div class="item-main">
          <div class="item-topline">
            <div class="item-badges">
              ${
                item.isCustom
                  ? '<span class="badge badge-custom">未登録教材</span>'
                  : `<span class="badge badge-cat">${escapeHtml(item.category)}</span>`
              }
              ${
                item.subject
                  ? `<span class="badge badge-sub">${escapeHtml(item.subject)}</span>`
                  : ""
              }
            </div>
            ${
              topMeta
                ? `<div class="item-publisher-top">${escapeHtml(topMeta)}</div>`
                : ""
            }
          </div>
          <div class="item-name">${escapeHtml(getDisplayItemName(item))}</div>
        </div>

        <div class="qty-box">
          <button type="button" class="qty-btn minus" aria-label="減らす">-</button>
          <input
            type="number"
            inputmode="numeric"
            pattern="[0-9]*"
            min="0"
            step="1"
            class="qty-input num"
            value="${item.qty}"
            aria-label="${escapeHtml(item.name)} の数量"
          />
          <button type="button" class="qty-btn plus" aria-label="増やす">+</button>
        </div>
      </article>
    `;
  }

  function getEmptyMessage() {
    if (state.activeCategoryFilter === "custom") {
      return state.showOnlyInputted
        ? "入力済みの未登録教材はありません。"
        : "未登録教材はありません。";
    }
    if (state.showOnlyInputted) return "入力済みの教材はありません。";
    return "該当する教材がありません。";
  }

  function openCustomDialog() {
    const form = document.getElementById("customItemForm");
    form?.reset();
    document.getElementById("customQtyInput").value = "0";
    openModal("customItemDialog");
  }

  function closeCustomDialog() {
    closeModal("customItemDialog");
  }

  function addCustomItem(event) {
    event.preventDefault();

    const name = document.getElementById("customName")?.value.trim() || "";
    if (!name) return;

    const item = normalizeItem({
      id: `custom-${Date.now()}`,
      category: "未登録教材",
      subject: "",
      name,
      publisher: document.getElementById("customPublisher")?.value.trim() || "",
      edition: document.getElementById("customEdition")?.value.trim() || "",
      qty: sanitizeQty(document.getElementById("customQtyInput")?.value || "0"),
      isCustom: true,
    });

    pushItem(item);
    state.originalSnapshotMap[item.id] = "__NEW_ITEM__";
    state.activeCategoryFilter = "custom";
    state.visibleCount = INITIAL_VISIBLE_COUNT;
    generateCategoryChips();
    markChanged();
    closeCustomDialog();
  }

  function changeCustomQty(delta) {
    const input = document.getElementById("customQtyInput");
    if (!input) return;
    input.value = String(Math.max(0, sanitizeQty(input.value) + delta));
  }

  function openInputtedItemsDialog() {
    const items = state.items.filter((item) => item.qty > 0);
    const summary = document.getElementById("inputtedItemsSummary");
    const list = document.getElementById("inputtedItemsList");

    if (summary) {
      summary.textContent =
        items.length > 0
          ? `${items.length}件、合計${state.totalQty}冊が入力されています。`
          : "入力済みの教材はありません。";
    }

    if (list) {
      list.innerHTML =
        items.length > 0
          ? items.map(renderReviewItemHTML).join("")
          : '<div class="empty">入力済みの教材はありません。</div>';
    }

    closeModal("toolMenuDialog");
    openModal("inputtedItemsDialog");
  }

  function renderReviewItemHTML(item) {
    return `
      <article class="item ${item.isCustom ? "custom-item" : ""}">
        <div class="item-main">
          <div class="item-topline">
            <div class="item-badges">
              <span class="badge ${
                item.isCustom ? "badge-custom" : "badge-cat"
              }">${escapeHtml(item.isCustom ? "未登録教材" : item.category)}</span>
              ${
                item.subject
                  ? `<span class="badge badge-sub">${escapeHtml(item.subject)}</span>`
                  : ""
              }
            </div>
            <div class="item-publisher-top">${escapeHtml(item.publisher || "")}</div>
          </div>
          <div class="item-name">${escapeHtml(getDisplayItemName(item))}</div>
        </div>
        <div class="summary-value num">${item.qty}</div>
      </article>
    `;
  }

  function updateStatsUI() {
    const totalQtyEl = document.getElementById("totalQty");
    const dirtyCountEl = document.getElementById("dirtyCount");
    const sendBtn = document.getElementById("sendBtn");

    if (totalQtyEl) totalQtyEl.textContent = String(state.totalQty);

    if (dirtyCountEl) {
      dirtyCountEl.textContent =
        state.dirtyCount > 0 ? `${state.dirtyCount}件編集中` : "変更はありません";
    }

    if (sendBtn) {
      sendBtn.disabled = state.dirtyCount === 0;
      sendBtn.classList.toggle("dirty", state.dirtyCount > 0);
    }
  }

  function recalcStats() {
    state.totalQty = state.items.reduce((sum, item) => sum + item.qty, 0);
    state.dirtyCount = state.items.filter(
      (item) => snapshotKey(item) !== state.originalSnapshotMap[item.id],
    ).length;
  }

  function syncInputOnlyToggleUI() {
    const toggle = document.getElementById("inputOnlyToggle");
    if (!toggle) return;
    toggle.classList.toggle("active", state.showOnlyInputted);
    toggle.setAttribute("aria-pressed", String(state.showOnlyInputted));
  }

  function syncSearchClearButton() {
    const clearBtn = document.getElementById("searchClearBtn");
    if (clearBtn) clearBtn.hidden = !state.query;
  }

  function setInfoMessage(message) {
    const info = document.getElementById("infoMessage");
    if (info) info.textContent = message;
    const error = document.getElementById("errorMessage");
    if (error) {
      error.textContent = "";
      error.hidden = true;
    }
  }

  function openModal(id) {
    const modal = document.getElementById(id);
    if (modal?.showModal) {
      modal.showModal();
    }
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal?.open) {
      modal.close();
    }
  }

  function pushItem(item) {
    state.items.push(item);
    state.itemsById.set(item.id, item);
  }

  function normalizeItem(raw) {
    const item = {
      id: String(raw.id || "").trim(),
      category: String(raw.category || "").trim(),
      subject: String(raw.subject || "").trim(),
      name: String(raw.name || "").trim(),
      publisher: String(raw.publisher || "").trim(),
      edition: String(raw.edition || "").trim(),
      qty: sanitizeQty(raw.qty),
      isCustom: Boolean(raw.isCustom),
    };

    item.searchTag = normalizeText(
      [item.name, item.category, item.subject, item.publisher, item.edition].join(
        " ",
      ),
    );

    return item;
  }

  function getDisplayItemName(item) {
    return [item.name, item.edition].filter(Boolean).join(" / ");
  }

  function snapshotKey(item) {
    return JSON.stringify({
      name: item.name,
      publisher: item.publisher,
      edition: item.edition,
      qty: item.qty,
      isCustom: item.isCustom,
    });
  }

  function normalizeText(value) {
    return String(value || "").trim().toLowerCase();
  }

  function sanitizeQty(value) {
    const qty = Number.parseInt(value, 10);
    return Number.isFinite(qty) && qty > 0 ? qty : 0;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char];
    });
  }
})();
