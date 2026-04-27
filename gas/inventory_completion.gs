const INVENTORY_COMPLETION_CONFIG = {
  sheetName: "【校舎設定・棚卸状況】",
  inventoryCollection: "inventory",
  modalTitle: "棚卸完了状況",
  outputSheetName: "【棚卸完了状況】",
  headerAliases: {
    token: ["ドキュメントキー"],
    url: ["棚卸URL"],
    roomLabel: ["校舎名（roomLabel）", "校舎名"],
    roomKey: ["校舎キー（roomKey）", "校舎キー"],
    sheetName: ["出力先シート名"],
  },
  completedAtDisplayFormat: "yyyy/MM/dd HH:mm:ss",
  outputHeaders: [
    "校舎名",
    "棚卸完了",
    "棚卸完了日",
  ],
};

function openInventoryCompletionModal() {
  const template = HtmlService.createTemplateFromFile(
    "inventory_completion_dialog",
  );
  template.modalTitle = INVENTORY_COMPLETION_CONFIG.modalTitle;

  const html = template.evaluate().setWidth(860).setHeight(620);
  SpreadsheetApp.getUi().showModalDialog(
    html,
    INVENTORY_COMPLETION_CONFIG.modalTitle,
  );
}

function getInventoryCompletionEntriesForModal() {
  validateInventoryFirestoreConfig_();
  const sheet = getInventoryCompletionSheet_();
  const sheetData = getInventoryCompletionSheetData_(sheet);
  return buildInventoryCompletionEntries_(sheetData);
}

function saveInventoryCompletionEntriesFromModal(entries) {
  validateInventoryFirestoreConfig_();

  const requestedEntries = Array.isArray(entries) ? entries : [];
  let updatedCount = 0;
  let conflictCount = 0;

  requestedEntries.forEach((entry) => {
    const token = String(entry && entry.token ? entry.token : "").trim();
    if (!token) {
      return;
    }

    const desiredCompleted = !!(entry && entry.completed);
    const tokenData = readInventoryTokenData_(token);
    const currentCompletedAtIso = getCompletedAtIso_(tokenData);
    const originalCompletedAtIso = getEntryOriginalCompletedAtIso_(entry);
    const hasOriginalState = hasEntryOriginalCompletedState_(entry);

    if (
      hasOriginalState &&
      currentCompletedAtIso !== originalCompletedAtIso
    ) {
      conflictCount += 1;
      return;
    }

    const hasCompletedAt = !!tokenData.completedAt;
    if (!hasCompletedAt && desiredCompleted) {
      patchInventoryCompletion_(token, true);
      updatedCount += 1;
      return;
    }

    if (hasCompletedAt && !desiredCompleted) {
      patchInventoryCompletion_(token, false);
      updatedCount += 1;
    }
  });

  return {
    updatedCount: updatedCount,
    conflictCount: conflictCount,
    entries: getInventoryCompletionEntriesForModal(),
  };
}

function getInventoryCompletionSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
    INVENTORY_COMPLETION_CONFIG.sheetName,
  );
  if (!sheet) {
    throw new Error(
      "シートが見つかりません: " +
        INVENTORY_COMPLETION_CONFIG.sheetName,
    );
  }
  return sheet;
}

function getInventoryCompletionSheetData_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    throw new Error("棚卸状況シートにデータがありません。");
  }

  const headerRow = values[0];
  const headerIndexMap = buildInventoryHeaderIndexMap_(headerRow);
  ensureInventoryCompletionHeaders_(headerIndexMap);

  return {
    headerIndexMap: headerIndexMap,
    rows: values.slice(1),
  };
}

function ensureInventoryCompletionHeaders_(headerIndexMap) {
  findHeaderIndexByAliases_(
    headerIndexMap,
    INVENTORY_COMPLETION_CONFIG.headerAliases.roomLabel,
  );
}

function buildInventoryCompletionEntries_(sheetData) {
  const tokens = sheetData.rows
    .map((row) => getInventoryTokenFromRow_(row, sheetData.headerIndexMap))
    .filter((token) => token);
  const tokenDocumentsById = getInventoryFirestoreDocumentsByIds_(
    INVENTORY_COMPLETION_CONFIG.inventoryCollection,
    tokens,
  );

  return sheetData.rows
    .map((row) =>
      buildInventoryCompletionEntry_(
        row,
        sheetData.headerIndexMap,
        tokenDocumentsById,
      ),
    )
    .filter((entry) => entry.token);
}

function buildInventoryCompletionEntry_(row, headerIndexMap, tokenDocumentsById) {
  const token = getInventoryTokenFromRow_(row, headerIndexMap);
  const roomKey = toInventoryStringOrEmpty_(
    readCellValueByAliases_(
      row,
      headerIndexMap,
      INVENTORY_COMPLETION_CONFIG.headerAliases.roomKey,
    ),
  );
  const roomLabel = toInventoryStringOrEmpty_(
    readCellValueByAliases_(
      row,
      headerIndexMap,
      INVENTORY_COMPLETION_CONFIG.headerAliases.roomLabel,
    ),
  );
  const outputSheetName = toInventoryStringOrEmpty_(
    readCellValueByAliases_(
      row,
      headerIndexMap,
      INVENTORY_COMPLETION_CONFIG.headerAliases.sheetName,
    ),
  );

  if (!token) {
    return {
      roomKey: roomKey,
      roomLabel: roomLabel,
      outputSheetName: outputSheetName,
      token: "",
      completed: false,
      completedAt: "",
      completedAtIso: "",
    };
  }

  const tokenDocument = tokenDocumentsById[token] || null;
  const tokenData = tokenDocument
    ? convertInventoryFirestoreFieldsToObject_(tokenDocument.fields || {})
    : {};
  const completedAt = tokenData.completedAt || null;

  return {
    roomKey: roomKey,
    roomLabel: roomLabel,
    outputSheetName: outputSheetName,
    token: token,
    completed: !!completedAt,
    originalCompleted: !!completedAt,
    completedAt: formatCompletedAtForSheet_(completedAt),
    completedAtIso: completedAt || "",
    originalCompletedAtIso: completedAt || "",
  };
}

function writeInventoryCompletionStatusSheet_(spreadsheet) {
  const entries = getInventoryCompletionEntriesForModal();
  const rows = entries
    .map((entry) => [
      entry.roomLabel || entry.outputSheetName,
      entry.completed ? "完了" : "未完了",
      entry.completedAt,
    ])
    .sort((a, b) => String(a[1] || "").localeCompare(String(b[1] || ""), "ja"));

  writeInventorySheetWithHeaders_(
    spreadsheet,
    INVENTORY_COMPLETION_CONFIG.outputSheetName,
    INVENTORY_COMPLETION_CONFIG.outputHeaders,
    rows,
  );
}

function getInventoryTokenFromRow_(row, headerIndexMap) {
  const token = readCellValueByAliases_(
    row,
    headerIndexMap,
    INVENTORY_COMPLETION_CONFIG.headerAliases.token,
  );
  if (String(token || "").trim()) {
    return String(token).trim();
  }

  const url = readCellValueByAliases_(
    row,
    headerIndexMap,
    INVENTORY_COMPLETION_CONFIG.headerAliases.url,
  );
  return extractTokenFromInventoryUrl_(url);
}

function extractTokenFromInventoryUrl_(url) {
  const text = String(url || "").trim();
  if (!text) {
    return "";
  }

  const tokenMatch = text.match(/[?&]token=([^&]+)/);
  if (!tokenMatch) {
    return "";
  }

  try {
    return decodeURIComponent(tokenMatch[1]);
  } catch (error) {
    return tokenMatch[1];
  }
}

function readCellValueByAliases_(row, headerIndexMap, aliases) {
  const columnIndex = findHeaderIndexByAliases_(headerIndexMap, aliases, true);
  if (columnIndex === -1) {
    return "";
  }
  return row[columnIndex];
}

function hasEntryOriginalCompletedState_(entry) {
  return (
    !!entry &&
    Object.prototype.hasOwnProperty.call(entry, "originalCompletedAtIso")
  );
}

function getEntryOriginalCompletedAtIso_(entry) {
  return String(
    entry && entry.originalCompletedAtIso ? entry.originalCompletedAtIso : "",
  ).trim();
}

function getCompletedAtIso_(tokenData) {
  return tokenData && tokenData.completedAt
    ? String(tokenData.completedAt)
    : "";
}

function findHeaderIndexByAliases_(headerIndexMap, aliases, allowMissing) {
  for (let i = 0; i < aliases.length; i += 1) {
    const alias = aliases[i];
    if (alias in headerIndexMap) {
      return headerIndexMap[alias];
    }
  }

  if (allowMissing) {
    return -1;
  }

  throw new Error("必要な列が見つかりません: " + aliases.join(" / "));
}

function formatCompletedAtForSheet_(completedAt) {
  if (!completedAt) {
    return "";
  }

  return Utilities.formatDate(
    new Date(completedAt),
    Session.getScriptTimeZone(),
    INVENTORY_COMPLETION_CONFIG.completedAtDisplayFormat,
  );
}

function readInventoryTokenData_(token) {
  const tokenDocument = getInventoryFirestoreDocument_(
    INVENTORY_COMPLETION_CONFIG.inventoryCollection,
    token,
  );
  return tokenDocument
    ? convertInventoryFirestoreFieldsToObject_(tokenDocument.fields || {})
    : {};
}

function patchInventoryCompletion_(token, isCompleted) {
  const documentPath =
    INVENTORY_COMPLETION_CONFIG.inventoryCollection +
    "/" +
    encodeURIComponent(token);
  const now = new Date().toISOString();
  updateInventoryFirestoreDocumentFields_(
    documentPath,
    {
      updatedAt: {
        timestampValue: now,
      },
      completedAt: isCompleted
        ? {
            timestampValue: now,
          }
        : {
            nullValue: null,
          },
    },
    ["updatedAt", "completedAt"],
    "棚卸完了状態の更新に失敗しました: ",
  );
}
