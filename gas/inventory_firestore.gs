const INVENTORY_FIRESTORE_CONFIG = {
  accessTokenCacheKey: "firestore_access_token_for_settings",
};

function listInventoryFirestoreDocuments_(url) {
  const documents = [];
  let nextPageToken = "";

  do {
    const requestUrl = nextPageToken
      ? url + "?pageToken=" + encodeURIComponent(nextPageToken)
      : url;
    const response = requestInventoryFirestoreApi_(requestUrl);
    const payload = JSON.parse(response.getContentText());

    if (payload.documents && payload.documents.length > 0) {
      payload.documents.forEach((document) => documents.push(document));
    }

    nextPageToken = payload.nextPageToken || "";
  } while (nextPageToken);

  return documents;
}

function getInventoryFirestoreDocument_(collectionName, documentId) {
  const url = buildInventoryFirestoreDocumentsUrl_(
    collectionName + "/" + encodeURIComponent(documentId),
  );
  const response = UrlFetchApp.fetch(url, {
    method: "get",
    headers: {
      Authorization: "Bearer " + getInventoryFirestoreAccessToken_(),
    },
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() === 404) {
    return null;
  }

  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error(
      "Firestore document fetch failed: " +
        response.getResponseCode() +
        " " +
        response.getContentText(),
    );
  }

  return JSON.parse(response.getContentText());
}

function getInventoryFirestoreDocumentsByIds_(collectionName, documentIds) {
  const uniqueDocumentIds = [];
  const seen = {};

  (documentIds || []).forEach((documentId) => {
    const normalizedId = String(documentId || "").trim();
    if (!normalizedId || seen[normalizedId]) {
      return;
    }
    seen[normalizedId] = true;
    uniqueDocumentIds.push(normalizedId);
  });

  if (uniqueDocumentIds.length === 0) {
    return {};
  }

  const response = requestInventoryFirestoreWithAuth_(
    buildInventoryFirestoreBatchGetUrl_(),
    {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        documents: uniqueDocumentIds.map((documentId) =>
          buildInventoryFirestoreDocumentResourceName_(
            collectionName + "/" + encodeURIComponent(documentId),
          ),
        ),
      }),
      failureMessage: "Firestore batchGet failed: ",
    },
  );
  const payload = JSON.parse(response.getContentText());
  const documentsById = {};

  payload.forEach((entry) => {
    if (!entry.found || !entry.found.name) {
      return;
    }

    documentsById[getInventoryLastPathSegment_(entry.found.name)] =
      entry.found;
  });

  return documentsById;
}

function requestInventoryFirestoreApi_(url) {
  return requestInventoryFirestoreWithAuth_(url, {
    method: "get",
    failureMessage: "Firestore API request failed: ",
  });
}

function getInventoryFirestoreAccessToken_() {
  const cache = CacheService.getScriptCache();
  const cachedToken = cache.get(INVENTORY_FIRESTORE_CONFIG.accessTokenCacheKey);
  if (cachedToken) {
    return cachedToken;
  }

  const properties = PropertiesService.getScriptProperties();
  const clientEmail = properties.getProperty("FIRESTORE_CLIENT_EMAIL");
  const privateKey = normalizeInventoryFirestorePrivateKey_(
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
    encodeInventoryFirestoreBase64UrlText_(JSON.stringify(jwtHeader)) +
    "." +
    encodeInventoryFirestoreBase64UrlText_(JSON.stringify(jwtClaimSet));
  const signatureBytes = Utilities.computeRsaSha256Signature(
    unsignedJwt,
    privateKey,
  );
  const signedJwt =
    unsignedJwt + "." + encodeInventoryFirestoreBase64UrlBytes_(signatureBytes);

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
      "Failed to fetch Firestore access token: " +
        tokenResponse.getResponseCode() +
        " " +
        tokenResponse.getContentText(),
    );
  }

  const tokenPayload = JSON.parse(tokenResponse.getContentText());
  const accessToken = tokenPayload.access_token;
  if (!accessToken) {
    throw new Error("Missing access_token in Firestore token response.");
  }

  cache.put(
    INVENTORY_FIRESTORE_CONFIG.accessTokenCacheKey,
    accessToken,
    3300,
  );
  return accessToken;
}

function buildInventoryFirestoreDocumentsUrl_(documentPath) {
  return (
    "https://firestore.googleapis.com/v1/" +
    buildInventoryFirestoreDocumentResourceName_(documentPath)
  );
}

function buildInventoryFirestoreBatchGetUrl_() {
  return (
    "https://firestore.googleapis.com/v1/" +
    buildInventoryFirestoreDatabaseResourceName_() +
    "/documents:batchGet"
  );
}

function buildInventoryFirestoreDatabaseResourceName_() {
  const projectId = getInventoryFirestoreRequiredScriptProperty_(
    "FIRESTORE_PROJECT_ID",
  );
  return (
    "projects/" +
    encodeURIComponent(projectId) +
    "/databases/(default)"
  );
}

function buildInventoryFirestoreDocumentResourceName_(documentPath) {
  return (
    buildInventoryFirestoreDatabaseResourceName_() +
    "/documents/" +
    documentPath
  );
}

function validateInventoryFirestoreConfig_() {
  getInventoryFirestoreRequiredScriptProperty_("FIRESTORE_CLIENT_EMAIL");
  getInventoryFirestoreRequiredScriptProperty_("FIRESTORE_PRIVATE_KEY");
  getInventoryFirestoreRequiredScriptProperty_("FIRESTORE_PROJECT_ID");
}

function getInventoryFirestoreRequiredScriptProperty_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) {
    throw new Error("Missing Script Property: " + key);
  }
  return value;
}

function normalizeInventoryFirestorePrivateKey_(privateKey) {
  return String(privateKey || "").replace(/\\n/g, "\n");
}

function encodeInventoryFirestoreBase64UrlText_(text) {
  return encodeInventoryFirestoreBase64UrlBytes_(
    Utilities.newBlob(text).getBytes(),
  );
}

function encodeInventoryFirestoreBase64UrlBytes_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, "");
}

function convertInventoryFirestoreFieldsToObject_(fields) {
  const result = {};
  Object.keys(fields).forEach((key) => {
    result[key] = convertInventoryFirestoreValueToJs_(fields[key]);
  });
  return result;
}

function convertInventoryFirestoreValueToJs_(value) {
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
    return convertInventoryFirestoreFieldsToObject_(
      value.mapValue.fields || {},
    );
  }
  if ("arrayValue" in value) {
    const values = value.arrayValue.values || [];
    return values.map((entry) => convertInventoryFirestoreValueToJs_(entry));
  }
  return null;
}

function requestInventoryFirestoreWithAuth_(url, options) {
  const requestOptions = options || {};
  const response = UrlFetchApp.fetch(url, {
    method: requestOptions.method || "get",
    contentType: requestOptions.contentType,
    headers: {
      Authorization: "Bearer " + getInventoryFirestoreAccessToken_(),
    },
    payload: requestOptions.payload,
    muteHttpExceptions: true,
  });

  return ensureInventoryFirestoreSuccessResponse_(
    response,
    requestOptions.failureMessage || "Firestore request failed: ",
  );
}

function ensureInventoryFirestoreSuccessResponse_(response, failureMessage) {
  const status = response.getResponseCode();
  if (status >= 200 && status < 300) {
    return response;
  }

  throw new Error(
    failureMessage + status + " " + response.getContentText(),
  );
}

function updateInventoryFirestoreDocumentFields_(
  documentPath,
  fieldPayload,
  updateMaskFieldPaths,
  failureMessage,
) {
  const query = (updateMaskFieldPaths || [])
    .map((fieldPath) => "updateMask.fieldPaths=" + encodeURIComponent(fieldPath))
    .join("&");
  const url = buildInventoryFirestoreDocumentsUrl_(documentPath) +
    (query ? "?" + query : "");

  return requestInventoryFirestoreWithAuth_(url, {
    method: "patch",
    contentType: "application/json",
    payload: JSON.stringify({
      fields: fieldPayload,
    }),
    failureMessage: failureMessage,
  });
}

function deleteInventoryFirestoreDocumentByPath_(documentPath, failureMessage) {
  return requestInventoryFirestoreWithAuth_(
    buildInventoryFirestoreDocumentsUrl_(documentPath),
    {
      method: "delete",
      failureMessage: failureMessage,
    },
  );
}
