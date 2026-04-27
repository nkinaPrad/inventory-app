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
  progressPropertyKey: "INVENTORY_RESET_PROGRESS",
};

function resetAllSchoolInventoryData(options) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error("別の棚卸データ初期化処理が実行中です。しばらく待ってから再実行してください。");
  }

  try {
    return resetAllSchoolInventoryDataLocked_(options);
  } finally {
    lock.releaseLock();
  }
}

function resetAllSchoolInventoryDataLocked_(options) {
  validateInventoryFirestoreConfig_();

  const resetOptions = options || {};
  const ui = resetOptions.suppressAlert ? null : SpreadsheetApp.getUi();
  const progress = loadInventoryResetProgress_();
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let settings = null;
  let deletedItems = progress ? Number(progress.deletedItems || 0) : 0;
  let summaries = [];
  let startIndex = progress ? Number(progress.nextIndex || 0) : 0;

  if (progress) {
    if (!resetOptions.suppressAlert) {
      ui.alert(
        "前回の棚卸データ初期化を続きから再開します。\n" +
          "再開位置: " +
          (startIndex + 1) +
          " / " +
          (progress.targetCount || "不明") +
          " 校舎目",
      );
    }
  }

  const managementSettings = readInventoryManagementSettings_();

  if (isTodayWithinInventoryPeriod_()) {
    const blockedMessage = buildInventoryResetBlockedMessage_(
      managementSettings,
    );

    if (!resetOptions.suppressAlert) {
      ui.alert(blockedMessage);
      return null;
    }

    throw new Error(blockedMessage);
  }

  settings = readInventorySettingsRows_(spreadsheet);
  const targetCount = settings.length;

  if (!progress && !resetOptions.suppressAlert && !resetOptions.skipConfirmation) {
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

  if (!progress) {
    exportInventoryToSchoolSheets({
      fileNameSuffix: "クリア時自動出力",
      suppressAlert: !!resetOptions.suppressAlert,
    });
    saveInventoryResetProgressSnapshot_(
      buildInventoryResetProgress_(
        spreadsheet,
        settings,
        0,
        0,
        new Date().toISOString(),
      ),
    );
  }

  try {
    for (let index = startIndex; index < settings.length; index += 1) {
      const setting = settings[index];
      const result = resetSingleSchoolInventoryData_(setting);
      deletedItems += result.deletedItems;
      summaries.push(setting.sheetName + ": " + result.deletedItems + "件削除");
      saveInventoryResetProgressSnapshot_(
        buildInventoryResetProgress_(
          spreadsheet,
          settings,
          index + 1,
          deletedItems,
          progress && progress.startedAt
            ? progress.startedAt
            : new Date().toISOString(),
        ),
      );
    }
  } catch (error) {
    const failureMessage = buildInventoryResetFailureMessage_(
      targetCount,
      startIndex + summaries.length,
      deletedItems,
      error,
    );

    if (!resetOptions.suppressAlert) {
      ui.alert(failureMessage);
      return {
        targetCount: targetCount,
        deletedItems: deletedItems,
        message: failureMessage,
        interrupted: true,
      };
    }

    throw error;
  }

  clearInventoryResetProgress_();

  const resultMessage = buildInventoryResetResultMessage_(
    targetCount,
    deletedItems,
    summaries,
  );

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

  const itemDocuments = listInventoryFirestoreDocuments_(
    buildInventoryFirestoreDocumentsUrl_(
      INVENTORY_RESET_CONFIG.inventoryCollection +
        "/" +
        encodeURIComponent(token) +
        "/items",
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
    buildInventoryFirestoreDocumentsUrl_(documentPath),
    {
      method: "delete",
      headers: {
        Authorization: "Bearer " + getInventoryFirestoreAccessToken_(),
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
  const tokenDocument = getInventoryFirestoreDocument_(
    INVENTORY_RESET_CONFIG.inventoryCollection,
    token,
  );
  if (!tokenDocument) {
    return;
  }

  const response = UrlFetchApp.fetch(
    buildInventoryFirestoreDocumentsUrl_(
      INVENTORY_RESET_CONFIG.inventoryCollection + "/" + encodeURIComponent(token),
    ) + "?updateMask.fieldPaths=updatedAt&updateMask.fieldPaths=completedAt",
    {
      method: "patch",
      contentType: "application/json",
      headers: {
        Authorization: "Bearer " + getInventoryFirestoreAccessToken_(),
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

function buildInventoryResetBlockedMessage_(managementSettings) {
  return (
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
    )
  );
}

function buildInventoryResetProgress_(
  spreadsheet,
  settings,
  nextIndex,
  deletedItems,
  startedAt,
) {
  return {
    spreadsheetId: spreadsheet.getId(),
    targetCount: settings.length,
    nextIndex: nextIndex,
    deletedItems: deletedItems,
    startedAt: startedAt,
  };
}

function buildInventoryResetFailureMessage_(
  targetCount,
  completedCount,
  deletedItems,
  error,
) {
  return (
    "棚卸データ初期化の途中で停止しました。\n" +
    "ここまでの進捗を保持しているため、再実行すると続きから再開できます。\n\n" +
    "対象校舎数: " +
    targetCount +
    "\n完了校舎数: " +
    completedCount +
    "\n削除 item 数: " +
    deletedItems +
    "件\n\n" +
    "停止理由: " +
    (error && error.message ? error.message : error)
  );
}

function buildInventoryResetResultMessage_(targetCount, deletedItems, summaries) {
  const details = summaries.length > 0
    ? "\n\n" + summaries.join("\n")
    : "";

  return (
    "棚卸データ初期化が完了しました。\n対象校舎数: " +
    targetCount +
    "\n削除 item 数: " +
    deletedItems +
    "件" +
    details
  );
}

function loadInventoryResetProgress_() {
  const raw = PropertiesService.getScriptProperties().getProperty(
    INVENTORY_RESET_CONFIG.progressPropertyKey,
  );
  if (!raw) {
    return null;
  }

  const progress = JSON.parse(raw);
  const currentSpreadsheetId = SpreadsheetApp.getActiveSpreadsheet().getId();
  if (progress.spreadsheetId !== currentSpreadsheetId) {
    return null;
  }

  if (Number(progress.nextIndex || 0) < 0) {
    return null;
  }

  return progress;
}

function saveInventoryResetProgress_(progress) {
  PropertiesService.getScriptProperties().setProperty(
    INVENTORY_RESET_CONFIG.progressPropertyKey,
    JSON.stringify(progress),
  );
}

function clearInventoryResetProgress_() {
  PropertiesService.getScriptProperties().deleteProperty(
    INVENTORY_RESET_CONFIG.progressPropertyKey,
  );
}

function saveInventoryResetProgressSnapshot_(progress) {
  saveInventoryResetProgress_(progress);
}
