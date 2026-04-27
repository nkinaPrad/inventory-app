const INVENTORY_MANAGEMENT_CONFIG = {
  sheetName: "教材棚卸管理",
  cells: {
    year: "C2",
    startDate: "C3",
    baseDate: "C4",
    deadlineDate: "C5",
  },
  resultRootFolderName: "棚卸結果",
};

function readInventoryManagementSettings_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(
    INVENTORY_MANAGEMENT_CONFIG.sheetName,
  );
  if (!sheet) {
    throw new Error(
      "シートが見つかりません: " + INVENTORY_MANAGEMENT_CONFIG.sheetName,
    );
  }

  return {
    year: toInventoryStringOrEmpty_(
      sheet.getRange(INVENTORY_MANAGEMENT_CONFIG.cells.year).getValue(),
    ),
    startDate: requireManagementDateValue_(
      sheet,
      INVENTORY_MANAGEMENT_CONFIG.cells.startDate,
      "棚卸開始日",
    ),
    baseDate: requireManagementDateValue_(
      sheet,
      INVENTORY_MANAGEMENT_CONFIG.cells.baseDate,
      "棚卸基準日",
    ),
    deadlineDate: requireManagementDateValue_(
      sheet,
      INVENTORY_MANAGEMENT_CONFIG.cells.deadlineDate,
      "棚卸締切日",
    ),
  };
}

function requireManagementDateValue_(sheet, a1Notation, label) {
  const value = sheet.getRange(a1Notation).getValue();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(label + " が日付として設定されていません: " + a1Notation);
  }
  return value;
}

function getInventoryResultMonthFolderName_() {
  const settings = readInventoryManagementSettings_();
  return Utilities.formatDate(
    settings.baseDate,
    Session.getScriptTimeZone(),
    "yyyy.MM",
  );
}

function isTodayWithinInventoryPeriod_() {
  const settings = readInventoryManagementSettings_();
  const today = normalizeDateForComparison_(new Date());
  const startDate = normalizeDateForComparison_(settings.startDate);
  const deadlineDate = normalizeDateForComparison_(settings.deadlineDate);

  return today.getTime() >= startDate.getTime() &&
    today.getTime() <= deadlineDate.getTime();
}

function normalizeDateForComparison_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function buildInventoryResultFileName_(timestamp, sheetName, suffix) {
  const settings = readInventoryManagementSettings_();
  const yearPrefix = String(settings.year || "").trim();
  const baseName =
    (yearPrefix ? yearPrefix : "") + "棚卸結果_" + timestamp;
  const parts = [baseName];
  if (sheetName) {
    parts.push(sheetName);
  }
  if (suffix) {
    parts.push(suffix);
  }
  return parts.join("_");
}

function moveSpreadsheetToInventoryResultFolder_(fileId) {
  const sourceSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sourceFile = DriveApp.getFileById(sourceSpreadsheet.getId());
  const parentFolders = sourceFile.getParents();

  if (!parentFolders.hasNext()) {
    throw new Error("元スプレッドシートの親フォルダが見つかりません。");
  }

  const parentFolder = parentFolders.next();
  const resultRootFolder = findOrCreateInventoryChildFolder_(
    parentFolder,
    INVENTORY_MANAGEMENT_CONFIG.resultRootFolderName,
  );
  const monthFolder = findOrCreateInventoryChildFolder_(
    resultRootFolder,
    getInventoryResultMonthFolderName_(),
  );
  const targetFile = DriveApp.getFileById(fileId);

  monthFolder.addFile(targetFile);

  const parentIterator = targetFile.getParents();
  while (parentIterator.hasNext()) {
    const folder = parentIterator.next();
    if (folder.getId() !== monthFolder.getId()) {
      folder.removeFile(targetFile);
    }
  }
}
