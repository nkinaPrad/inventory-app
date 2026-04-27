# GAS

教材棚卸で使う Google Apps Script をまとめています。

Firestore の棚卸データ出力、棚卸完了状況の確認と更新、棚卸データ初期化、教材マスタの `data.js` 生成を扱います。

## ファイル構成

- `inventory_common.gs`: シート読み書き、設定行読み込み、共通ユーティリティ
- `inventory_firestore.gs`: Firestore REST API、アクセストークン取得、Firestore value 変換
- `inventory_export.gs`: Firestore の `inventory/{token}/items` を校舎別シートとして出力
- `inventory_completion.gs`: 棚卸完了状況の取得と更新
- `inventory_completion_dialog.html`: 棚卸完了状況モーダルの UI
- `inventory_management.gs`: 棚卸期間、結果ファイル名、保存先フォルダの管理
- `inventory_reset.gs`: 棚卸データの初期化と途中再開
- `master_data_export.gs`: `【教材マスタ】` シートから `data.js` を生成

## 必須設定

Apps Script の Script Properties に次を設定します。

- `FIRESTORE_CLIENT_EMAIL`
- `FIRESTORE_PRIVATE_KEY`
- `FIRESTORE_PROJECT_ID`

`FIRESTORE_PRIVATE_KEY` は `\n` を含む文字列でも扱えるようにしています。

## 利用シート

### `【校舎設定・棚卸状況】`

必要な列:

- `校舎キー（roomKey）`
- `校舎名（roomLabel）`
- `出力先シート名`
- `ドキュメントキー`
- `棚卸URL`

`出力先シート名` と `ドキュメントキー` は重複不可です。重複がある場合、出力やリセットの前にエラーになります。

### `【教材マスタ】`

棚卸結果出力では次の列を使います。

- `商品コード`
- `教材名`
- `出版社`

`master_data_export.gs` では、追加で次の列も `data.js` に出力します。

- `マスタ区分`
- `科目`

### `教材棚卸管理`

- `C2`: 年度
- `C3`: 棚卸開始日
- `C4`: 棚卸基準日
- `C5`: 棚卸締切日

`C4` の棚卸基準日は、棚卸結果の保存先フォルダ `棚卸結果/YYYY.MM` の年月に使います。

## 主な実行関数

- `exportInventoryToSchoolSheets()`: 全校舎分の棚卸結果を新しいスプレッドシートへ出力
- `exportSingleSchoolSheet(token)`: 指定 token の校舎だけを出力
- `openInventoryCompletionModal()`: 棚卸完了状況モーダルを開く
- `resetAllSchoolInventoryData()`: 棚卸データを初期化
- `exportMasterDataAsJsFile()`: `data.js` を生成

## 出力と保存先

- 棚卸結果スプレッドシートは、元スプレッドシートと同じ親フォルダ配下の `棚卸結果/YYYY.MM` に保存します
- `YYYY.MM` は `教材棚卸管理` シートの `C4` の棚卸基準日を使います
- `data.js` は、元スプレッドシートと同じ親フォルダ配下の `教材データ` フォルダに保存します

## 完了状況モーダル

- `【校舎設定・棚卸状況】` の `ドキュメントキー` または `棚卸URL` から対象校舎を判定します
- Firestore の親ドキュメントは `batchGet` でまとめて取得します
- 保存時は、画面上で変更した校舎だけを更新します
- モーダルを開いている間に別の担当者が同じ校舎を更新した場合、その校舎は競合としてスキップします
- 更新後は最新状態を再取得して画面に反映します

## リセット処理

`resetAllSchoolInventoryData()` は Firestore の本番データを直接変更します。

- 棚卸期間中は実行できません
- 実行前に `クリア時自動出力` サフィックス付きで棚卸結果を自動出力します
- `LockService` で同時実行を防ぎます
- 各校舎の `inventory/{token}/items` を削除します
- 親ドキュメントの `updatedAt` と `completedAt` を `null` に戻します
- 途中で停止した場合は Script Properties に進捗を保持し、再実行で続きから再開します
- 正常終了時は進捗情報を削除します

進捗には `spreadsheetId`, `targetCount`, `nextIndex`, `deletedItems`, `startedAt` のような最小限の情報だけを保存します。

## 運用上の注意

- `token` は実運用では英数字のみを前提にしています
- 完了状況更新とリセットは Firestore の本番データを直接操作するため、実行権限は必要最小限にしてください
- 一括リセット前に、棚卸結果の自動出力が成功することを確認してください
- 大量データで実行時間制限に近づく場合でも、リセットは再実行で継続できます

## メンテナンス

- シート名やヘッダ名を変更した場合は、Apps Script 側の定数も合わせて更新する
- Firestore のスキーマ変更時は、出力処理、完了状況更新、リセット処理を確認する
- `data.js` の列構成を変えた場合は `master_data_export.gs` の `headerMap` を確認する
- `.gs` / `.html` / `.md` は UTF-8 で保存する
