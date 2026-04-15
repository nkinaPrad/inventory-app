/**
 * スプレッドシートの教材マスタを data.js 形式で Drive に出力します。
 *
 * 処理内容は従来版と同じで、次の流れです。
 * - メニューから実行
 * - 指定シートを読み取り
 * - 指定フォルダの data.js を更新、なければ新規作成
 */

const MASTER_JS_EXPORT_CONFIG = {
  menuItemLabel: "マスタデータ出力（JavaScript）",
  targetSheetName: "【教材マスタ】",
  outputFileName: "data.js",
  headerMap: {
    "マスタ区分": "category",
    "商品コード": "id",
    "科目": "subject",
    "商品名": "name",
    "出版社": "publisher",
  },
};

/**
 * スプレッドシートを開いたときにメニューを追加します。
 */
const INVENTORY_MENU_CONFIG = {
  menuItemLabel: "棚卸結果出力",
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("📝出力")
    .addItem(
      MASTER_JS_EXPORT_CONFIG.menuItemLabel,
      "exportMasterDataAsJsFile",
    )
    .addItem(
      INVENTORY_MENU_CONFIG.menuItemLabel,
      "exportInventoryToSchoolSheets",
    )
    .addToUi();
}

/**
 * シートの内容を `const MASTER_DATA = ...;` 形式の JS ファイルとして出力します。
 */
function exportMasterDataAsJsFile() {
  const ui = SpreadsheetApp.getUi();
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(
    MASTER_JS_EXPORT_CONFIG.targetSheetName,
  );

  if (!sheet) {
    ui.alert(
      "シート「" +
        MASTER_JS_EXPORT_CONFIG.targetSheetName +
        "」が見つかりません。",
    );
    return;
  }

  const folder = getOrCreateSiblingFolderForMasterData_("教材データ");
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

  upsertDriveFile_(folder, MASTER_JS_EXPORT_CONFIG.outputFileName, jsContent);
  return ui.alert("教材データ フォルダへ data.js を保存しました。");
  ui.alert("教材データ フォルダへ data.js を保存しました。");

  ui.alert(
    MASTER_JS_EXPORT_CONFIG.outputFileName +
      " を出力しました。アプリ側で読み込み設定を確認してください。",
  );
}

/**
 * 1 行分のデータを JS オブジェクトへ変換します。
 */
function buildMasterDataRecord_(headers, row) {
  const record = {};

  headers.forEach((header, index) => {
    const key =
      MASTER_JS_EXPORT_CONFIG.headerMap[header] || header;
    let value = row[index];

    if (key === "id") {
      value = normalizeItemId_(value);
    }

    record[key] = value;
  });

  return record;
}

function buildMasterDataJsContent_(records) {
  const body = records.map((record) => formatMasterDataRecord_(record)).join(",\n");
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
 * 商品コードを文字列として安定化します。
 * スプレッドシートで指数表記になった値も元の数字へ戻します。
 */
function normalizeItemId_(value) {
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
 * 元スプレッドシートと同じ親フォルダ配下の子フォルダを返します。
 * フォルダがなければ作成します。
 */
function getOrCreateSiblingFolderForMasterData_(folderName) {
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
