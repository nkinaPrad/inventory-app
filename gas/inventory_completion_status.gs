const INVENTORY_COMPLETION_STATUS_CONFIG = {
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

function openInventoryCompletionStatusModal() {
  const template = HtmlService.createTemplateFromFile(
    "inventory_completion_status_dialog",
  );
  template.modalTitle = INVENTORY_COMPLETION_STATUS_CONFIG.modalTitle;

  const html = template.evaluate().setWidth(860).setHeight(620);
  SpreadsheetApp.getUi().showModalDialog(
    html,
    INVENTORY_COMPLETION_STATUS_CONFIG.modalTitle,
  );
}

function getInventoryCompletionStatusesForModal() {
  validateInventoryExportBySettingsConfig_();
  const sheet = getInventoryCompletionStatusSheet_();
  const sheetData = getInventoryCompletionSheetData_(sheet);
  return buildInventoryCompletionStatusEntries_(sheetData);
}

function updateInventoryCompletionStatusesFromModal(entries) {
  validateInventoryExportBySettingsConfig_();

  const requestedEntries = Array.isArray(entries) ? entries : [];
  let updatedCount = 0;

  requestedEntries.forEach((entry) => {
    const token = String(entry && entry.token ? entry.token : "").trim();
    if (!token) {
      return;
    }

    const desiredCompleted = !!(entry && entry.completed);
    const tokenData = readInventoryTokenDataByToken_(token);
    const hasCompletedAt = !!tokenData.completedAt;

    if (!hasCompletedAt && desiredCompleted) {
      patchInventoryCompletionStatus_(token, true);
      updatedCount += 1;
      return;
    }

    if (hasCompletedAt && !desiredCompleted) {
      patchInventoryCompletionStatus_(token, false);
      updatedCount += 1;
    }
  });

  return {
    updatedCount: updatedCount,
    entries: getInventoryCompletionStatusesForModal(),
  };
}

function getInventoryCompletionStatusSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
    INVENTORY_COMPLETION_STATUS_CONFIG.sheetName,
  );
  if (!sheet) {
    throw new Error(
      "シートが見つかりません: " +
        INVENTORY_COMPLETION_STATUS_CONFIG.sheetName,
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
  const headerIndexMap = buildHeaderIndexMap_(headerRow);
  ensureInventoryCompletionHeaders_(headerIndexMap);

  return {
    headerIndexMap: headerIndexMap,
    rows: values.slice(1),
  };
}

function ensureInventoryCompletionHeaders_(headerIndexMap) {
  findHeaderIndexByAliases_(
    headerIndexMap,
    INVENTORY_COMPLETION_STATUS_CONFIG.headerAliases.roomLabel,
  );
}

function buildInventoryCompletionStatusEntries_(sheetData) {
  return sheetData.rows
    .map((row) =>
      buildInventoryCompletionStatusEntry_(row, sheetData.headerIndexMap),
    )
    .filter((entry) => entry.token);
}

function buildInventoryCompletionStatusEntry_(row, headerIndexMap) {
  const token = getInventoryTokenFromRow_(row, headerIndexMap);
  const roomKey = toStringOrEmptyForSettings_(
    readCellValueByAliases_(
      row,
      headerIndexMap,
      INVENTORY_COMPLETION_STATUS_CONFIG.headerAliases.roomKey,
    ),
  );
  const roomLabel = toStringOrEmptyForSettings_(
    readCellValueByAliases_(
      row,
      headerIndexMap,
      INVENTORY_COMPLETION_STATUS_CONFIG.headerAliases.roomLabel,
    ),
  );
  const outputSheetName = toStringOrEmptyForSettings_(
    readCellValueByAliases_(
      row,
      headerIndexMap,
      INVENTORY_COMPLETION_STATUS_CONFIG.headerAliases.sheetName,
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

  const tokenData = readInventoryTokenDataByToken_(token);
  const completedAt = tokenData.completedAt || null;

  return {
    roomKey: roomKey,
    roomLabel: roomLabel,
    outputSheetName: outputSheetName,
    token: token,
    completed: !!completedAt,
    completedAt: formatCompletedAtForSheet_(completedAt),
    completedAtIso: completedAt || "",
  };
}

function writeInventoryCompletionStatusSheet_(spreadsheet) {
  const entries = getInventoryCompletionStatusesForModal();
  const rows = entries
    .map((entry) => [
      entry.roomLabel || entry.outputSheetName,
      entry.completed ? "完了" : "未完了",
      entry.completedAt,
    ])
    .sort((a, b) => String(a[1] || "").localeCompare(String(b[1] || ""), "ja"));

  const sheet =
    getOrCreateSheetByName_(
      spreadsheet,
      INVENTORY_COMPLETION_STATUS_CONFIG.outputSheetName,
    );

  sheet.clearContents();
  sheet
    .getRange(
      1,
      1,
      1,
      INVENTORY_COMPLETION_STATUS_CONFIG.outputHeaders.length,
    )
    .setValues([INVENTORY_COMPLETION_STATUS_CONFIG.outputHeaders]);

  if (rows.length > 0) {
    sheet
      .getRange(
        2,
        1,
        rows.length,
        INVENTORY_COMPLETION_STATUS_CONFIG.outputHeaders.length,
      )
      .setValues(rows);
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(
    1,
    INVENTORY_COMPLETION_STATUS_CONFIG.outputHeaders.length,
  );
}

function getInventoryTokenFromRow_(row, headerIndexMap) {
  const token = readCellValueByAliases_(
    row,
    headerIndexMap,
    INVENTORY_COMPLETION_STATUS_CONFIG.headerAliases.token,
  );
  if (String(token || "").trim()) {
    return String(token).trim();
  }

  const url = readCellValueByAliases_(
    row,
    headerIndexMap,
    INVENTORY_COMPLETION_STATUS_CONFIG.headerAliases.url,
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
    INVENTORY_COMPLETION_STATUS_CONFIG.completedAtDisplayFormat,
  );
}

function readInventoryTokenDataByToken_(token) {
  const tokenDocument = getFirestoreDocumentByPathForSettings_(
    INVENTORY_COMPLETION_STATUS_CONFIG.inventoryCollection,
    token,
  );
  return tokenDocument
    ? convertFirestoreFieldsToObjectForSettings_(tokenDocument.fields || {})
    : {};
}

function patchInventoryCompletionStatus_(token, isCompleted) {
  const documentPath =
    INVENTORY_COMPLETION_STATUS_CONFIG.inventoryCollection +
    "/" +
    encodeURIComponent(token);
  const now = new Date().toISOString();
  const payload = {
    fields: {
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
  };

  const response = UrlFetchApp.fetch(
    buildFirestoreDocumentsUrlForSettings_(documentPath) +
      "?updateMask.fieldPaths=updatedAt&updateMask.fieldPaths=completedAt",
    {
      method: "patch",
      contentType: "application/json",
      headers: {
        Authorization: "Bearer " + getFirestoreAccessTokenForSettings_(),
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    },
  );

  const status = response.getResponseCode();
  if (status >= 200 && status < 300) {
    return;
  }

  throw new Error(
    "棚卸完了状態の更新に失敗しました: " +
      status +
      " " +
      response.getContentText(),
  );
}
