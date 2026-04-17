# GAS

`gas` フォルダには、教材棚卸で使う Google Apps Script をまとめています。
Firestore の棚卸データ出力、教材マスタの `data.js` 生成、棚卸状況の確認、棚卸データ初期化を扱います。

## ファイル構成

- `inventory_export_to_sheet.gs`
  Firestore の `inventory/{token}/items` を校舎別シートとして出力します。
- `inventory_completion_status.gs`
  棚卸完了状況の取得・更新ロジックです。
- `inventory_completion_status_dialog.html`
  棚卸完了状況モーダルの UI です。
- `inventory_management_sheet.gs`
  棚卸期間と結果ファイル保存先年月の管理を行います。
- `inventory_reset.gs`
  棚卸データの初期化処理です。実行前に棚卸結果を自動出力します。
- `master_data_js_export.gs`
  `【教材マスタ】` シートから `data.js` を生成します。
- `inventory_completion_status_modal.html`
  旧モーダルファイルです。現在は `inventory_completion_status_dialog.html` を使用します。

## 必須設定

Apps Script の Script Properties に次を設定します。

- `FIRESTORE_CLIENT_EMAIL`
- `FIRESTORE_PRIVATE_KEY`
- `FIRESTORE_PROJECT_ID`

## 利用シート

- `【校舎設定・棚卸状況】`
  - `校舎キー（roomKey）`
  - `校舎名（roomLabel）`
  - `出力先シート名`
  - `ドキュメントキー`
  - `棚卸URL`
- `【教材マスタ】`
  - 商品コード、商品名、出版社などを保持します。
- `教材棚卸管理シート`
  - `C2`: 年度
  - `C3`: 棚卸開始日
  - `C4`: 棚卸基準日
  - `C5`: 棚卸締切日

## 主な実行関数

- `exportInventoryToSchoolSheets()`
  全校舎分の棚卸結果を出力します。
- `exportSingleSchoolSheet(token)`
  指定 token の校舎だけ出力します。
- `openInventoryCompletionStatusModal()`
  棚卸完了状況モーダルを開きます。
- `resetAllSchoolInventoryData()`
  棚卸データを初期化します。
- `exportMasterDataAsJsFile()`
  `data.js` を生成します。

## 補足

- 棚卸結果は `棚卸結果/YYYY.MM` 配下へ保存します。
- 棚卸期間中は `resetAllSchoolInventoryData()` を実行できません。
- 初期化前には `クリア時自動出力` というサフィックス付きで棚卸結果を保存します。

## 命名整理の提案

今後さらに整理するなら、次のように寄せると目的が伝わりやすくなります。

- `inventory_export_to_sheet.gs` → `inventory_export.gs`
- `inventory_management_sheet.gs` → `inventory_management.gs`
- `master_data_js_export.gs` → `master_data_export.gs`
- `inventory_completion_status_modal.html` は削除候補

今回は既存運用への影響を避けるため、実行中の関数名は大きく変えていません。