/**
 * Firestore の在庫データを、このスプレッドシート内の各校舎シートへ出力します。
 *
 * 前提:
 * - 同じスプレッドシート内に `【校舎設定・棚卸状況】` シートがあること
 * - 同じスプレッドシート内に `【教材マスタ】` シートがあること
 * - Apps Script のスクリプト プロパティに以下が設定されていること
 *   - FIRESTORE_CLIENT_EMAIL
 *   - FIRESTORE_PRIVATE_KEY
 *   - FIRESTORE_PROJECT_ID
 */

const INVENTORY_EXPORT_CONFIG = {
  settingsSheetName: "【校舎設定・棚卸状況】",
  masterSheetName: "【教材マスタ】",
  inventoryCollection: "inventory",
  includeDisabledRooms: true,
  includeZeroQtyRows: false,
  outputHeaders: ["商品コード", "商品名", "出版社", "版・準拠", "部数"],
  settingsHeaders: {
    roomKey: "校舎キー（roomKey）",
    roomLabel: "校舎名（roomLabel）",
    sheetName: "出力先シート名",
    token: "ドキュメントキー",
  },
  masterHeaders: {
    code: "商品コード",
    name: "教材名",
    publisher: "出版社",
  },
};

/**
 * `【校舎設定・棚卸状況】` シートに定義されたすべての校舎シートへ在庫を出力します。
 */
function exportInventoryToSchoolSheets(options) {
  validateInventoryFirestoreConfig_();

  const exportOptions = options || {};
  const exportContext = buildInventoryExportContext_();
  const resultSpreadsheet = createInventoryExportSpreadsheet_(
    "",
    exportOptions.fileNameSuffix || "",
  );

  exportContext.settings.forEach((setting, index) => {
    const rows = buildInventoryRowsForSetting_(setting, exportContext.masterMap);

    if (index === 0) {
      resultSpreadsheet.getSheets()[0].setName(setting.sheetName);
    }

    writeInventoryRowsToSheet_(resultSpreadsheet, setting.sheetName, rows);
  });

  writeInventoryCompletionStatusSheet_(resultSpreadsheet);
  moveSpreadsheetToInventoryResultFolder_(resultSpreadsheet.getId());
  showInventoryExportCompletedAlert_(resultSpreadsheet, exportOptions);

  return resultSpreadsheet;
}

/**
 * 指定したドキュメントキー 1 件だけを出力します。
 */
function exportSingleSchoolSheet(token, options) {
  if (!token) {
    throw new Error("ドキュメントキーを指定してください。");
  }

  validateInventoryFirestoreConfig_();

  const exportOptions = options || {};
  const exportContext = buildInventoryExportContext_();
  const target = exportContext.settings.find(
    (row) => row.token === String(token).trim(),
  );

  if (!target) {
    throw new Error("【校舎設定・棚卸状況】シートに対象のドキュメントキーがありません。");
  }

  const rows = buildInventoryRowsForSetting_(target, exportContext.masterMap);
  const resultSpreadsheet = createInventoryExportSpreadsheet_(
    target.sheetName,
    exportOptions.fileNameSuffix || "",
  );

  resultSpreadsheet.getSheets()[0].setName(target.sheetName);
  writeInventoryRowsToSheet_(resultSpreadsheet, target.sheetName, rows);
  writeInventoryCompletionStatusSheet_(resultSpreadsheet);
  moveSpreadsheetToInventoryResultFolder_(resultSpreadsheet.getId());
  showInventoryExportCompletedAlert_(resultSpreadsheet, exportOptions);

  return resultSpreadsheet;
}

function buildInventoryExportContext_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  return {
    spreadsheet: spreadsheet,
    settings: readInventorySettingsRows_(spreadsheet),
    masterMap: readMasterDataByCode_(spreadsheet),
  };
}

function createInventoryExportSpreadsheet_(sheetName, fileNameSuffix) {
  const timestamp = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    "yyyyMMdd_HHmmss",
  );
  return SpreadsheetApp.create(
    buildInventoryResultFileName_(timestamp, sheetName, fileNameSuffix),
  );
}

function buildInventoryRowsForSetting_(setting, masterMap) {
  const inventory = readInventoryItems_(setting.token);
  return buildInventoryRows_(inventory, masterMap);
}

function showInventoryExportCompletedAlert_(resultSpreadsheet, exportOptions) {
  if (exportOptions.suppressAlert) {
    return;
  }

  SpreadsheetApp.getUi().alert(
    "棚卸結果スプレッドシートを作成しました: " + resultSpreadsheet.getName(),
  );
}

/**
 * `【教材マスタ】` シートを読み取り、商品コードをキーにしたマップを返します。
 */
function readMasterDataByCode_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(
    INVENTORY_EXPORT_CONFIG.masterSheetName,
  );
  if (!sheet) {
    throw new Error("【教材マスタ】シートが見つかりません。");
  }

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return {};
  }

  const headerIndexMap = buildInventoryHeaderIndexMap_(values[0]);
  const masterMap = {};

  values
    .slice(1)
    .filter((row) => isInventoryNonEmptySheetRow_(row))
    .forEach((row) => {
      const itemCode = normalizeInventorySpreadsheetItemCode_(
        readInventoryCellByHeaderName_(
          row,
          headerIndexMap,
          INVENTORY_EXPORT_CONFIG.masterHeaders.code,
        ),
      );

      if (!itemCode) {
        return;
      }

      masterMap[itemCode] = {
        name: readInventoryCellByHeaderName_(
          row,
          headerIndexMap,
          INVENTORY_EXPORT_CONFIG.masterHeaders.name,
        ),
        publisher: readInventoryCellByHeaderName_(
          row,
          headerIndexMap,
          INVENTORY_EXPORT_CONFIG.masterHeaders.publisher,
        ),
      };
    });

  return masterMap;
}

/**
 * Firestore の `inventory/{token}` とその配下 `items` を取得します。
 */
function readInventoryItems_(token) {
  const tokenDocument = getInventoryFirestoreDocument_(
    INVENTORY_EXPORT_CONFIG.inventoryCollection,
    token,
  );
  const tokenData = tokenDocument
    ? convertInventoryFirestoreFieldsToObject_(tokenDocument.fields || {})
    : {};

  if (
    !INVENTORY_EXPORT_CONFIG.includeDisabledRooms &&
    tokenData.enabled !== true
  ) {
    return [];
  }

  const itemDocuments = listInventoryFirestoreDocuments_(
    buildInventoryFirestoreDocumentsUrl_(
      INVENTORY_EXPORT_CONFIG.inventoryCollection +
        "/" +
        encodeURIComponent(token) +
        "/items",
    ),
  );

  return itemDocuments.map((itemDocument) => ({
    id: getInventoryLastPathSegment_(itemDocument.name),
    data: convertInventoryFirestoreFieldsToObject_(
      itemDocument.fields || {},
    ),
  }));
}

/**
 * Firestore の在庫データと教材マスタから、出力用の行データを組み立てます。
 */
function buildInventoryRows_(inventory, masterMap) {
  return inventory
    .map((entry) => {
      const itemId = normalizeInventorySpreadsheetItemCode_(entry.id);
      const itemData = entry.data || {};
      const qty = Number(itemData.qty || 0);
      const isCustom = itemData.isCustom === true;
      const master = masterMap[itemId] || {};

      return [
        itemId,
        toInventoryStringOrEmpty_(isCustom ? itemData.name : master.name),
        toInventoryStringOrEmpty_(
          isCustom ? itemData.publisher : master.publisher,
        ),
        toInventoryStringOrEmpty_(itemData.edition),
        qty,
      ];
    })
    .filter((row) => {
      if (INVENTORY_EXPORT_CONFIG.includeZeroQtyRows) {
        return true;
      }
      return Number(row[4] || 0) > 0;
    })
    .sort((a, b) => {
      const codeA = String(a[0] || "");
      const codeB = String(b[0] || "");
      return codeA.localeCompare(codeB, "ja");
    });
}

/**
 * 各校舎シートへヘッダ付きで上書き出力します。
 */
function writeInventoryRowsToSheet_(spreadsheet, sheetName, rows) {
  const sheet = getOrCreateInventorySheet_(spreadsheet, sheetName);

  sheet.clearContents();
  sheet
    .getRange(
      1,
      1,
      1,
      INVENTORY_EXPORT_CONFIG.outputHeaders.length,
    )
    .setValues([INVENTORY_EXPORT_CONFIG.outputHeaders]);

  if (rows.length > 0) {
    sheet
      .getRange(
        2,
        1,
        rows.length,
        INVENTORY_EXPORT_CONFIG.outputHeaders.length,
      )
      .setValues(rows);
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(
    1,
    INVENTORY_EXPORT_CONFIG.outputHeaders.length,
  );
}
