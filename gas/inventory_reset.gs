/**
 * Firestore の棚卸データを初期化します。
 *
 * 対象:
 * - inventory/{token}/items 配下の全ドキュメント削除
 * - inventory/{token} の updatedAt / completedAt をクリア
 *
 * 前提:
 * - 設定シートに対象校舎の token が登録されていること
 * - Script Properties に Firestore 接続情報が設定されていること
 */

const INVENTORY_RESET_CONFIG = {
  inventoryCollection: "inventory",
};

function resetAllSchoolInventoryData(options) {
  validateInventoryExportBySettingsConfig_();

  const resetOptions = options || {};
  const ui = resetOptions.suppressAlert ? null : SpreadsheetApp.getUi();
  const managementSettings = readInventoryManagementSettings_();

  if (isTodayWithinInventoryPeriod_()) {
    const blockedMessage =
      "棚卸期間中は棚卸データを初期化できません。\n" +
      "棚卸開始日から棚卸締切日まではクリアを禁止しています。\n" +
      "棚卸開始日: " +
      Utilities.formatDate(
        managementSettings.startDate,
        Session.getScriptTimeZone(),
        "yyyy/MM/dd",
      ) +
      "\n棚卸締切日: " +
      Utilities.formatDate(
        managementSettings.deadlineDate,
        Session.getScriptTimeZone(),
        "yyyy/MM/dd",
      );

    if (!resetOptions.suppressAlert) {
      ui.alert(blockedMessage);
      return null;
    }

    throw new Error(blockedMessage);
  }

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const settings = readExportSettingsRows_(spreadsheet);
  const targetCount = settings.length;

  if (!resetOptions.suppressAlert && !resetOptions.skipConfirmation) {
    const confirmed = ui.alert(
      "棚卸データ初期化",
      targetCount +
        " 校舎分の item データを削除し、更新日・完了日をクリアします。\n" +
        "初期化前に棚卸結果を自動出力します。\n" +
        "この操作は元に戻せません。実行しますか？",
      ui.ButtonSet.OK_CANCEL,
    );

    if (confirmed !== ui.Button.OK) {
      ui.alert("棚卸データ初期化を中止しました。");
      return null;
    }
  }

  exportInventoryToSchoolSheets({
    fileNameSuffix: "クリア時自動出力",
    suppressAlert: !!resetOptions.suppressAlert,
  });

  let deletedItems = 0;
  const summaries = [];

  settings.forEach((setting) => {
    const result = resetSingleSchoolInventoryData_(setting);
    deletedItems += result.deletedItems;
    summaries.push(setting.sheetName + ": " + result.deletedItems + "件削除");
  });

  const resultMessage =
    "棚卸データ初期化が完了しました。\n対象校舎数: " +
    targetCount +
    "\n削除 item 数: " +
    deletedItems +
    "件\n\n" +
    summaries.join("\n");

  if (!resetOptions.suppressAlert) {
    ui.alert(resultMessage);
  }

  return {
    targetCount: targetCount,
    deletedItems: deletedItems,
    message: resultMessage,
  };
}

function resetSingleSchoolInventoryData_(setting) {
  const token = String(setting.token || "").trim();
  if (!token) {
    throw new Error("token が空の設定行が含まれています。");
  }

  const itemDocuments = listFirestoreDocumentsForSettings_(
    buildFirestoreDocumentsUrlForSettings_(
      INVENTORY_RESET_CONFIG.inventoryCollection + "/" + token + "/items",
    ),
  );

  itemDocuments.forEach((itemDocument) => {
    deleteFirestoreDocumentByNameForReset_(itemDocument.name);
  });

  clearInventoryTokenFieldsForReset_(token);

  return {
    deletedItems: itemDocuments.length,
  };
}

function deleteFirestoreDocumentByNameForReset_(documentName) {
  const documentPath = extractFirestoreDocumentPathForReset_(documentName);
  const response = UrlFetchApp.fetch(
    buildFirestoreDocumentsUrlForSettings_(documentPath),
    {
      method: "delete",
      headers: {
        Authorization: "Bearer " + getFirestoreAccessTokenForSettings_(),
      },
      muteHttpExceptions: true,
    },
  );

  const status = response.getResponseCode();
  if (status >= 200 && status < 300) {
    return;
  }

  throw new Error(
    "Firestore ドキュメント削除に失敗しました: " +
      status +
      " " +
      response.getContentText(),
  );
}

function clearInventoryTokenFieldsForReset_(token) {
  const tokenDocument = getFirestoreDocumentByPathForSettings_(
    INVENTORY_RESET_CONFIG.inventoryCollection,
    token,
  );
  if (!tokenDocument) {
    return;
  }

  const response = UrlFetchApp.fetch(
    buildFirestoreDocumentsUrlForSettings_(
      INVENTORY_RESET_CONFIG.inventoryCollection + "/" + encodeURIComponent(token),
    ) + "?updateMask.fieldPaths=updatedAt&updateMask.fieldPaths=completedAt",
    {
      method: "patch",
      contentType: "application/json",
      headers: {
        Authorization: "Bearer " + getFirestoreAccessTokenForSettings_(),
      },
      payload: JSON.stringify({
        fields: {
          updatedAt: {
            nullValue: null,
          },
          completedAt: {
            nullValue: null,
          },
        },
      }),
      muteHttpExceptions: true,
    },
  );

  const status = response.getResponseCode();
  if (status >= 200 && status < 300) {
    return;
  }

  throw new Error(
    "棚卸ドキュメントの初期化に失敗しました: " +
      status +
      " " +
      response.getContentText(),
  );
}

function extractFirestoreDocumentPathForReset_(documentName) {
  const marker = "/documents/";
  const index = String(documentName || "").indexOf(marker);
  if (index === -1) {
    throw new Error(
      "Firestore document name を解釈できません: " + documentName,
    );
  }
  return documentName.slice(index + marker.length);
}