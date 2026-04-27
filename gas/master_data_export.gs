/**
 * スプレッドシート上の教材マスタを `data.js` として Drive に出力します。
 */

const MASTER_DATA_EXPORT_CONFIG = {
  targetSheetName: "【教材マスタ】",
  outputFileName: "data.js",
  outputFolderName: "教材データ",
  headerMap: {
    マスタ区分: "category",
    商品コード: "id",
    科目: "subject",
    教材名: "name",
    出版社: "publisher",
  },
};

/**
 * シートの内容を `const MASTER_DATA = ...;` 形式の JS ファイルとして出力します。
 */
function exportMasterDataAsJsFile() {
  const ui = SpreadsheetApp.getUi();
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(
    MASTER_DATA_EXPORT_CONFIG.targetSheetName,
  );

  if (!sheet) {
    ui.alert(
      "シート「" + MASTER_DATA_EXPORT_CONFIG.targetSheetName + "」が見つかりません。",
    );
    return;
  }

  const folder = getOrCreateMasterDataFolder_(
    MASTER_DATA_EXPORT_CONFIG.outputFolderName,
  );
  const values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    ui.alert("データがありません。");
    return;
  }

  const headers = values[0];
  const rows = values.slice(1);
  const records = rows
    .filter((row) => row.some((cell) => cell !== ""))
    .map((row) => buildMasterDataRecord_(headers, row));

  const jsContent = buildMasterDataJsContent_(records);

  upsertDriveFile_(folder, MASTER_DATA_EXPORT_CONFIG.outputFileName, jsContent);
  ui.alert("教材データ フォルダへ data.js を保存しました。");
}

/**
 * 1 行分のデータを JS オブジェクトへ変換します。
 */
function buildMasterDataRecord_(headers, row) {
  const record = {};

  headers.forEach((header, index) => {
    const key = MASTER_DATA_EXPORT_CONFIG.headerMap[header] || header;
    let value = row[index];

    if (key === "id") {
      value = normalizeMasterItemId_(value);
    }

    record[key] = value;
  });

  return record;
}

function buildMasterDataJsContent_(records) {
  const body = records
    .map((record) => formatMasterDataRecord_(record))
    .join(",\n");
  return "const MASTER_DATA = [\n" + body + "\n];";
}

function formatMasterDataRecord_(record) {
  const propertyOrder = ["category", "id", "subject", "name", "publisher"];
  const lines = propertyOrder
    .filter((key) => Object.prototype.hasOwnProperty.call(record, key))
    .map((key) => `    ${key}: ${formatJsString_(record[key])},`);

  return "  {\n" + lines.join("\n") + "\n  }";
}

function formatJsString_(value) {
  const text = value == null ? "" : String(value);
  return `"${escapeJsString_(text)}"`;
}

function escapeJsString_(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

/**
 * 商品コードを文字列として正規化します。
 * スプレッドシートで指数表記になった値も元の整数へ戻します。
 */
function normalizeMasterItemId_(value) {
  const text = String(value);

  if (text.includes("E+")) {
    return Number(value).toLocaleString("fullwide", {
      useGrouping: false,
    });
  }

  return text;
}

/**
 * 同名ファイルがあれば更新し、なければ新規作成します。
 */
function upsertDriveFile_(folder, fileName, content) {
  const files = folder.getFilesByName(fileName);

  if (files.hasNext()) {
    files.next().setContent(content);
    return;
  }

  folder.createFile(fileName, content, MimeType.PLAIN_TEXT);
}

/**
 * 元スプレッドシートと同じ親フォルダ配下の指定フォルダを取得します。
 * フォルダがなければ新規作成します。
 */
function getOrCreateMasterDataFolder_(folderName) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const spreadsheetFile = DriveApp.getFileById(spreadsheet.getId());
  const parentFolders = spreadsheetFile.getParents();

  if (!parentFolders.hasNext()) {
    throw new Error("元スプレッドシートの親フォルダが見つかりません。");
  }

  const parentFolder = parentFolders.next();
  const folders = parentFolder.getFoldersByName(folderName);

  if (folders.hasNext()) {
    return folders.next();
  }

  return parentFolder.createFolder(folderName);
}

function normalizeItemId_(value) {
  return normalizeMasterItemId_(value);
}

function getOrCreateSiblingFolderForMasterData_(folderName) {
  return getOrCreateMasterDataFolder_(folderName);
}
