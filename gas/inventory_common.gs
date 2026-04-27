const INVENTORY_SETTINGS_CONFIG = {
  sheetName: "【校舎設定・棚卸状況】",
  headers: {
    roomKey: "校舎キー（roomKey）",
    roomLabel: "校舎名（roomLabel）",
    sheetName: "出力先シート名",
    token: "ドキュメントキー",
  },
};

function buildInventoryHeaderIndexMap_(headerRow) {
  const map = {};
  headerRow.forEach((header, index) => {
    map[String(header).trim()] = index;
  });
  return map;
}

function readInventoryCellByHeaderName_(row, headerIndexMap, headerName) {
  if (!(headerName in headerIndexMap)) {
    throw new Error("Unknown header: " + headerName);
  }
  const value = row[headerIndexMap[headerName]];
  return value == null ? "" : String(value).trim();
}

function isInventoryNonEmptySheetRow_(row) {
  return row.some((cell) => String(cell).trim() !== "");
}

function normalizeInventorySpreadsheetItemCode_(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (text.includes("E+")) {
    return Number(value).toLocaleString("fullwide", {
      useGrouping: false,
    });
  }
  return text;
}

function toInventoryStringOrEmpty_(value) {
  return value == null ? "" : String(value);
}

function getInventoryLastPathSegment_(path) {
  const parts = String(path || "").split("/");
  return parts[parts.length - 1] || "";
}

function getOrCreateInventorySheet_(spreadsheet, sheetName) {
  return spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
}

function findOrCreateInventoryChildFolder_(parentFolder, folderName) {
  const folders = parentFolder.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return parentFolder.createFolder(folderName);
}

function writeInventorySheetWithHeaders_(spreadsheet, sheetName, headers, rows) {
  const sheet = getOrCreateInventorySheet_(spreadsheet, sheetName);

  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);

  return sheet;
}

function readInventorySettingsRows_(spreadsheet) {
  const sheet = getInventorySettingsSheet_(spreadsheet);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    throw new Error("設定シートにデータ行がありません。");
  }

  const headerIndexMap = buildInventoryHeaderIndexMap_(values[0]);
  const settings = values
    .slice(1)
    .filter((row) => isInventoryNonEmptySheetRow_(row))
    .map((row) => buildExportSettingRow_(row, headerIndexMap));

  if (settings.length === 0) {
    throw new Error("設定シートに有効な設定行がありません。");
  }

  validateInventorySettingsRows_(settings);

  return settings;
}

function getInventorySettingsSheet_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(INVENTORY_SETTINGS_CONFIG.sheetName);
  if (!sheet) {
    throw new Error(
      "シートが見つかりません: " + INVENTORY_SETTINGS_CONFIG.sheetName,
    );
  }
  return sheet;
}

function buildExportSettingRow_(row, headerIndexMap) {
  const setting = {
    roomKey: readInventoryCellByHeaderName_(
      row,
      headerIndexMap,
      INVENTORY_SETTINGS_CONFIG.headers.roomKey,
    ),
    roomLabel: readInventoryCellByHeaderName_(
      row,
      headerIndexMap,
      INVENTORY_SETTINGS_CONFIG.headers.roomLabel,
    ),
    sheetName: readInventoryCellByHeaderName_(
      row,
      headerIndexMap,
      INVENTORY_SETTINGS_CONFIG.headers.sheetName,
    ),
    token: readInventoryCellByHeaderName_(
      row,
      headerIndexMap,
      INVENTORY_SETTINGS_CONFIG.headers.token,
    ),
  };

  if (!setting.sheetName || !setting.token) {
    throw new Error(
      "設定シートに未設定の行があります。出力先シート名とドキュメントキーは必須です。",
    );
  }

  return setting;
}

function validateInventorySettingsRows_(settings) {
  const seenSheetNames = {};
  const seenTokens = {};

  settings.forEach((setting) => {
    const sheetName = String(setting.sheetName || "").trim();
    const token = String(setting.token || "").trim();

    if (sheetName) {
      if (seenSheetNames[sheetName]) {
        throw new Error("出力先シート名が重複しています: " + sheetName);
      }
      seenSheetNames[sheetName] = true;
    }

    if (token) {
      if (seenTokens[token]) {
        throw new Error("ドキュメントキーが重複しています: " + token);
      }
      seenTokens[token] = true;
    }
  });
}
