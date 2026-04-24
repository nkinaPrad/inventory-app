/**
 * Firestore の在庫データを、このスプレッドシート内の各校舎シートへ出力します。
 *
 * 前提:
 * - 同じスプレッドシート内に `【設定】` シートがあること
 * - 同じスプレッドシート内に `【教材マスタ】` シートがあること
 * - Apps Script のスクリプト プロパティに以下が設定されていること
 *   - FIRESTORE_CLIENT_EMAIL
 *   - FIRESTORE_PRIVATE_KEY
 *   - FIRESTORE_PROJECT_ID
 */

const INVENTORY_EXPORT_BY_SETTINGS_CONFIG = {
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
 * `【設定】` シートに定義されたすべての校舎シートへ在庫を出力します。
 */
function exportInventoryToSchoolSheets(options) {
  validateInventoryExportBySettingsConfig_();

  const exportOptions = options || {};
  const exportContext = buildInventoryExportContext_();
  const resultSpreadsheet = createInventoryResultSpreadsheet_(
    "",
    exportOptions.fileNameSuffix || "",
  );

  exportContext.settings.forEach((setting, index) => {
    const inventory = readInventoryItemsByToken_(setting.token);
    const rows = buildSchoolSheetRows_(inventory, exportContext.masterMap);

    if (index === 0) {
      resultSpreadsheet.getSheets()[0].setName(setting.sheetName);
    }

    writeInventoryRowsToSchoolSheet_(resultSpreadsheet, setting.sheetName, rows);
  });

  writeInventoryCompletionStatusSheet_(resultSpreadsheet);
  moveSpreadsheetToInventoryResultFolder_(resultSpreadsheet.getId());
  if (!exportOptions.suppressAlert) {
    SpreadsheetApp.getUi().alert(
      "棚卸結果スプレッドシートを作成しました: " + resultSpreadsheet.getName(),
    );
  }

  return resultSpreadsheet;
}

/**
 * 指定したドキュメントキー 1 件だけを出力します。
 */
function exportSingleSchoolSheet(token, options) {
  if (!token) {
    throw new Error("ドキュメントキーを指定してください。");
  }

  validateInventoryExportBySettingsConfig_();

  const exportOptions = options || {};
  const exportContext = buildInventoryExportContext_();
  const target = exportContext.settings.find(
    (row) => row.token === String(token).trim(),
  );

  if (!target) {
    throw new Error("【設定】シートに対象のドキュメントキーがありません。");
  }

  const inventory = readInventoryItemsByToken_(target.token);
  const rows = buildSchoolSheetRows_(inventory, exportContext.masterMap);
  const resultSpreadsheet = createInventoryResultSpreadsheet_(
    target.sheetName,
    exportOptions.fileNameSuffix || "",
  );

  resultSpreadsheet.getSheets()[0].setName(target.sheetName);
  writeInventoryRowsToSchoolSheet_(resultSpreadsheet, target.sheetName, rows);
  writeInventoryCompletionStatusSheet_(resultSpreadsheet);
  moveSpreadsheetToInventoryResultFolder_(resultSpreadsheet.getId());

  if (!exportOptions.suppressAlert) {
    SpreadsheetApp.getUi().alert(
      "棚卸結果スプレッドシートを作成しました: " + resultSpreadsheet.getName(),
    );
  }

  return resultSpreadsheet;
}

function buildInventoryExportContext_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  return {
    spreadsheet: spreadsheet,
    settings: readExportSettingsRows_(spreadsheet),
    masterMap: readMasterDataByCode_(spreadsheet),
  };
}

function createInventoryResultSpreadsheet_(sheetName, fileNameSuffix) {
  const timestamp = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    "yyyyMMdd_HHmmss",
  );
  return SpreadsheetApp.create(
    buildInventoryResultFileName_(timestamp, sheetName, fileNameSuffix),
  );
}

/**
 * `【設定】` シートを読み取り、出力対象の一覧を返します。
 */
function readExportSettingsRows_(spreadsheet) {
  const sheet = getInventorySettingsSheet_(spreadsheet);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    throw new Error("設定シートにデータ行がありません。");
  }

  const headerIndexMap = buildHeaderIndexMap_(values[0]);
  const settings = values
    .slice(1)
    .filter((row) => isNonEmptySheetRow_(row))
    .map((row) => buildExportSettingRow_(row, headerIndexMap));

  if (settings.length === 0) {
    throw new Error("設定シートに有効な設定行がありません。");
  }

  return settings;
}

function getInventorySettingsSheet_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(
    INVENTORY_EXPORT_BY_SETTINGS_CONFIG.settingsSheetName,
  );
  if (!sheet) {
    throw new Error(
      "シートが見つかりません: " +
        INVENTORY_EXPORT_BY_SETTINGS_CONFIG.settingsSheetName,
    );
  }
  return sheet;
}

function buildExportSettingRow_(row, headerIndexMap) {
  const setting = {
    roomKey: readCellByHeaderName_(
      row,
      headerIndexMap,
      INVENTORY_EXPORT_BY_SETTINGS_CONFIG.settingsHeaders.roomKey,
    ),
    roomLabel: readCellByHeaderName_(
      row,
      headerIndexMap,
      INVENTORY_EXPORT_BY_SETTINGS_CONFIG.settingsHeaders.roomLabel,
    ),
    sheetName: readCellByHeaderName_(
      row,
      headerIndexMap,
      INVENTORY_EXPORT_BY_SETTINGS_CONFIG.settingsHeaders.sheetName,
    ),
    token: readCellByHeaderName_(
      row,
      headerIndexMap,
      INVENTORY_EXPORT_BY_SETTINGS_CONFIG.settingsHeaders.token,
    ),
  };

  if (!setting.sheetName || !setting.token) {
    throw new Error(
      "設定シートに未設定の行があります。出力先シート名とドキュメントキーは必須です。",
    );
  }

  return setting;
}

/**
 * `【教材マスタ】` シートを読み取り、商品コードをキーにしたマップを返します。
 */
function readMasterDataByCode_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(
    INVENTORY_EXPORT_BY_SETTINGS_CONFIG.masterSheetName,
  );
  if (!sheet) {
    throw new Error("【教材マスタ】シートが見つかりません。");
  }

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return {};
  }

  const headerIndexMap = buildHeaderIndexMap_(values[0]);
  const masterMap = {};

  values
    .slice(1)
    .filter((row) => isNonEmptySheetRow_(row))
    .forEach((row) => {
      const itemCode = normalizeSpreadsheetItemCode_(
        readCellByHeaderName_(
          row,
          headerIndexMap,
          INVENTORY_EXPORT_BY_SETTINGS_CONFIG.masterHeaders.code,
        ),
      );

      if (!itemCode) {
        return;
      }

      masterMap[itemCode] = {
        name: readCellByHeaderName_(
          row,
          headerIndexMap,
          INVENTORY_EXPORT_BY_SETTINGS_CONFIG.masterHeaders.name,
        ),
        publisher: readCellByHeaderName_(
          row,
          headerIndexMap,
          INVENTORY_EXPORT_BY_SETTINGS_CONFIG.masterHeaders.publisher,
        ),
      };
    });

  return masterMap;
}

/**
 * Firestore の `inventory/{token}` とその配下 `items` を取得します。
 */
function readInventoryItemsByToken_(token) {
  const tokenDocument = getFirestoreDocumentByPathForSettings_(
    INVENTORY_EXPORT_BY_SETTINGS_CONFIG.inventoryCollection,
    token,
  );
  const tokenData = tokenDocument
    ? convertFirestoreFieldsToObjectForSettings_(tokenDocument.fields || {})
    : {};

  if (
    !INVENTORY_EXPORT_BY_SETTINGS_CONFIG.includeDisabledRooms &&
    tokenData.enabled !== true
  ) {
    return [];
  }

  const itemDocuments = listFirestoreDocumentsForSettings_(
    buildFirestoreDocumentsUrlForSettings_(
      INVENTORY_EXPORT_BY_SETTINGS_CONFIG.inventoryCollection +
        "/" +
        token +
        "/items",
    ),
  );

  return itemDocuments.map((itemDocument) => ({
    id: getLastPathSegmentForSettings_(itemDocument.name),
    data: convertFirestoreFieldsToObjectForSettings_(
      itemDocument.fields || {},
    ),
  }));
}

/**
 * Firestore の在庫データと教材マスタから、出力用の行データを組み立てます。
 */
function buildSchoolSheetRows_(inventory, masterMap) {
  return inventory
    .map((entry) => {
      const itemId = normalizeSpreadsheetItemCode_(entry.id);
      const itemData = entry.data || {};
      const qty = Number(itemData.qty || 0);
      const isCustom = itemData.isCustom === true;
      const master = masterMap[itemId] || {};

      return [
        itemId,
        toStringOrEmptyForSettings_(isCustom ? itemData.name : master.name),
        toStringOrEmptyForSettings_(
          isCustom ? itemData.publisher : master.publisher,
        ),
        toStringOrEmptyForSettings_(itemData.edition),
        qty,
      ];
    })
    .filter((row) => {
      if (INVENTORY_EXPORT_BY_SETTINGS_CONFIG.includeZeroQtyRows) {
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
function writeInventoryRowsToSchoolSheet_(spreadsheet, sheetName, rows) {
  const sheet = getOrCreateSheetByName_(spreadsheet, sheetName);

  sheet.clearContents();
  sheet
    .getRange(
      1,
      1,
      1,
      INVENTORY_EXPORT_BY_SETTINGS_CONFIG.outputHeaders.length,
    )
    .setValues([INVENTORY_EXPORT_BY_SETTINGS_CONFIG.outputHeaders]);

  if (rows.length > 0) {
    sheet
      .getRange(
        2,
        1,
        rows.length,
        INVENTORY_EXPORT_BY_SETTINGS_CONFIG.outputHeaders.length,
      )
      .setValues(rows);
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(
    1,
    INVENTORY_EXPORT_BY_SETTINGS_CONFIG.outputHeaders.length,
  );
}

/**
 * Firestore REST API の documents 一覧を最後まで取得します。
 */
function listFirestoreDocumentsForSettings_(url) {
  const documents = [];
  let nextPageToken = "";

  do {
    const requestUrl = nextPageToken
      ? url + "?pageToken=" + encodeURIComponent(nextPageToken)
      : url;
    const response = requestFirestoreApiForSettings_(requestUrl);
    const payload = JSON.parse(response.getContentText());

    if (payload.documents && payload.documents.length > 0) {
      payload.documents.forEach((document) => documents.push(document));
    }

    nextPageToken = payload.nextPageToken || "";
  } while (nextPageToken);

  return documents;
}

/**
 * Firestore の単一ドキュメントを取得します。存在しない場合は null を返します。
 */
function getFirestoreDocumentByPathForSettings_(collectionName, documentId) {
  const url = buildFirestoreDocumentsUrlForSettings_(
    collectionName + "/" + encodeURIComponent(documentId),
  );
  const response = UrlFetchApp.fetch(url, {
    method: "get",
    headers: {
      Authorization: "Bearer " + getFirestoreAccessTokenForSettings_(),
    },
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() === 404) {
    return null;
  }

  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error(
      "Firestore ドキュメント取得に失敗しました: " +
        response.getResponseCode() +
        " " +
        response.getContentText(),
    );
  }

  return JSON.parse(response.getContentText());
}

/**
 * Firestore REST API へ GET リクエストを送ります。
 */
function requestFirestoreApiForSettings_(url) {
  const response = UrlFetchApp.fetch(url, {
    method: "get",
    headers: {
      Authorization: "Bearer " + getFirestoreAccessTokenForSettings_(),
    },
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  if (status >= 200 && status < 300) {
    return response;
  }

  throw new Error(
    "Firestore API の呼び出しに失敗しました: " +
      status +
      " " +
      response.getContentText(),
  );
}

/**
 * サービスアカウントの JWT を使ってアクセストークンを取得します。
 */
function getFirestoreAccessTokenForSettings_() {
  const cache = CacheService.getScriptCache();
  const cachedToken = cache.get("firestore_access_token_for_settings");
  if (cachedToken) {
    return cachedToken;
  }

  const properties = PropertiesService.getScriptProperties();
  const clientEmail = properties.getProperty("FIRESTORE_CLIENT_EMAIL");
  const privateKey = normalizePrivateKeyForSettings_(
    properties.getProperty("FIRESTORE_PRIVATE_KEY"),
  );
  const now = Math.floor(Date.now() / 1000);

  const jwtHeader = { alg: "RS256", typ: "JWT" };
  const jwtClaimSet = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const unsignedJwt =
    encodeBase64UrlTextForSettings_(JSON.stringify(jwtHeader)) +
    "." +
    encodeBase64UrlTextForSettings_(JSON.stringify(jwtClaimSet));
  const signatureBytes = Utilities.computeRsaSha256Signature(
    unsignedJwt,
    privateKey,
  );
  const signedJwt =
    unsignedJwt + "." + encodeBase64UrlBytesForSettings_(signatureBytes);

  const tokenResponse = UrlFetchApp.fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "post",
      payload: {
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signedJwt,
      },
      muteHttpExceptions: true,
    },
  );

  if (
    tokenResponse.getResponseCode() < 200 ||
    tokenResponse.getResponseCode() >= 300
  ) {
    throw new Error(
      "アクセストークンの取得に失敗しました: " +
        tokenResponse.getResponseCode() +
        " " +
        tokenResponse.getContentText(),
    );
  }

  const tokenPayload = JSON.parse(tokenResponse.getContentText());
  const accessToken = tokenPayload.access_token;
  if (!accessToken) {
    throw new Error("access_token を取得できませんでした。");
  }

  cache.put("firestore_access_token_for_settings", accessToken, 3300);
  return accessToken;
}

/**
 * Firestore documents API の URL を組み立てます。
 */
function buildFirestoreDocumentsUrlForSettings_(documentPath) {
  const projectId = getRequiredScriptPropertyForSettings_(
    "FIRESTORE_PROJECT_ID",
  );
  return (
    "https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(projectId) +
    "/databases/(default)/documents/" +
    documentPath
  );
}

/**
 * 実行前に必須設定を検証します。
 */
function validateInventoryExportBySettingsConfig_() {
  getRequiredScriptPropertyForSettings_("FIRESTORE_CLIENT_EMAIL");
  getRequiredScriptPropertyForSettings_("FIRESTORE_PRIVATE_KEY");
  getRequiredScriptPropertyForSettings_("FIRESTORE_PROJECT_ID");
}

/**
 * 必須のスクリプトプロパティを取得します。
 */
function getRequiredScriptPropertyForSettings_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) {
    throw new Error("スクリプト プロパティの " + key + " が未設定です。");
  }
  return value;
}

/**
 * ヘッダ名から列番号マップを作ります。
 */
function buildHeaderIndexMap_(headerRow) {
  const map = {};
  headerRow.forEach((header, index) => {
    map[String(header).trim()] = index;
  });
  return map;
}

/**
 * 指定ヘッダの値をセル配列から読み取ります。
 */
function readCellByHeaderName_(row, headerIndexMap, headerName) {
  if (!(headerName in headerIndexMap)) {
    throw new Error("必要なヘッダがありません: " + headerName);
  }
  const value = row[headerIndexMap[headerName]];
  return value == null ? "" : String(value).trim();
}

function isNonEmptySheetRow_(row) {
  return row.some((cell) => String(cell).trim() !== "");
}

/**
 * 秘密鍵文字列内の "\\n" を改行へ戻します。
 */
function normalizePrivateKeyForSettings_(privateKey) {
  return String(privateKey || "").replace(/\\n/g, "\n");
}

/**
 * 文字列を Base64URL 形式へ変換します。
 */
function encodeBase64UrlTextForSettings_(text) {
  return encodeBase64UrlBytesForSettings_(Utilities.newBlob(text).getBytes());
}

/**
 * バイト列を Base64URL 形式へ変換します。
 */
function encodeBase64UrlBytesForSettings_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, "");
}

/**
 * Firestore の fields を通常の JavaScript オブジェクトへ変換します。
 */
function convertFirestoreFieldsToObjectForSettings_(fields) {
  const result = {};
  Object.keys(fields).forEach((key) => {
    result[key] = convertFirestoreValueToJsForSettings_(fields[key]);
  });
  return result;
}

/**
 * Firestore の value を JavaScript の値へ変換します。
 */
function convertFirestoreValueToJsForSettings_(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if ("stringValue" in value) {
    return value.stringValue;
  }
  if ("integerValue" in value) {
    return Number(value.integerValue);
  }
  if ("doubleValue" in value) {
    return Number(value.doubleValue);
  }
  if ("booleanValue" in value) {
    return value.booleanValue;
  }
  if ("timestampValue" in value) {
    return value.timestampValue;
  }
  if ("nullValue" in value) {
    return null;
  }
  if ("mapValue" in value) {
    return convertFirestoreFieldsToObjectForSettings_(
      value.mapValue.fields || {},
    );
  }
  if ("arrayValue" in value) {
    const values = value.arrayValue.values || [];
    return values.map((entry) => convertFirestoreValueToJsForSettings_(entry));
  }
  return null;
}

/**
 * 商品コードを文字列として安定化します。
 */
function normalizeSpreadsheetItemCode_(value) {
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

/**
 * null / undefined を空文字へそろえます。
 */
function toStringOrEmptyForSettings_(value) {
  return value == null ? "" : String(value);
}

/**
 * パス文字列の最後のセグメントを返します。
 */
function getLastPathSegmentForSettings_(path) {
  const parts = String(path || "").split("/");
  return parts[parts.length - 1] || "";
}

function getOrCreateSheetByName_(spreadsheet, sheetName) {
  return spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
}

/**
 * 親フォルダ配下の子フォルダを探し、なければ作成します。
 */
function findOrCreateChildFolderForInventory_(parentFolder, folderName) {
  const folders = parentFolder.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return parentFolder.createFolder(folderName);
}
