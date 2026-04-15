# GAS

`gas` 配下には、現行版の保管用ファイルと、整理した利用用ファイルがあります。

## 利用用ファイル

- `inventory_export_to_sheet.gs`
  Firestore の `inventory/{token}/items` を Google スプレッドシートへ出力します。
- `master_data_js_export.gs`
  スプレッドシート上の教材マスタを `data.js` 形式で Drive へ出力します。

## 保管用ファイル

- `firestore_to_sheets.gs`
- `master_js_create.gs`

## Firestore 出力の前提

- Firestore を読めるサービスアカウントを用意する
- Apps Script の `Script Properties` に以下を設定する
  - `FIRESTORE_CLIENT_EMAIL`
  - `FIRESTORE_PRIVATE_KEY`
  - `FIRESTORE_PROJECT_ID`
- `inventory_export_to_sheet.gs` の `INVENTORY_EXPORT_CONFIG.spreadsheetId` を設定する

## Firestore 出力の使い方

- 全 token を出力: `exportFirestoreInventoryToSheet()`
- 1 token だけ出力: `exportSingleTokenToSheet("your-token")`

## 設定シート運用版の使い方

- 全校舎を出力: `exportInventoryToSchoolSheets()`
- 1校舎だけ出力: `exportSingleSchoolSheet("ドキュメントキー")`
- `【設定】` シートのヘッダ:
  - `校舎キー（roomKey）`
  - `校舎名（roomLabel）`
  - `出力先シート名`
  - `ドキュメントキー`
- `【教材マスタ】` シートの利用列:
  - `商品コード`
  - `商品名`
  - `出版社`

## Firestore 出力の補足

- このスクリプトは Web 画面とは独立して動きます
- Firestore REST API を使うため、フロントエンドの実装変更は不要です
- `includeZeroQtyRows` や `tokenWhitelist` を変えると出力対象を調整できます
- 標準教材は Firestore 側に `qty` などしか保存していないため、教材名や教科も出したい場合は `INVENTORY_MASTER_DATA_MAP` を埋めてください

## マスタ JS 出力の使い方

- スプレッドシートを開くとメニューが追加されます
- メニューの「データ出力」→「JSファイル出力」で `data.js` を更新します
- 出力先フォルダ ID や対象シート名は `MASTER_JS_EXPORT_CONFIG` で変更できます


## プロパティ

- 次のプロパティを設定済みです

- FIRESTORE_CLIENT_EMAIL
- FIRESTORE_PRIVATE_KEY
- FIRESTORE_PROJECT_ID
