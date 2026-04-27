# inventory-app

教材棚卸用の Web アプリです。

校舎ごとに発行した URL の `token` で対象校舎を判定し、Firestore に在庫数を保存します。主な利用端末は iPad mini ですが、スマホと PC からも同じ画面構成で利用できます。

## 概要

- 教材マスタは `data.js` としてフロントに配布します
- 校舎ごとの棚卸データは Firestore の `inventory/{token}` 配下に保存します
- URL の `token` で対象校舎と有効状態を判定します
- 棚卸完了後は `completedAt` が設定され、以後は編集不可になります
- 未登録教材は画面上から追加できます
- 自動保存と手動保存の両方に対応しています
- 集計、完了状況確認、リセット、`data.js` 出力補助は `gas/` 配下の Google Apps Script で行います

## ディレクトリ構成

- [index.html](/C:/github/inventory-app/index.html): フロント画面本体
- [app.js](/C:/github/inventory-app/app.js): 画面制御、検索、保存、棚卸完了処理
- [style.css](/C:/github/inventory-app/style.css): 画面スタイル
- [firebase.js](/C:/github/inventory-app/firebase.js): Firebase 初期化
- [data.js](/C:/github/inventory-app/data.js): 教材マスタ
- [invalid-url.html](/C:/github/inventory-app/invalid-url.html): 無効な URL 用の画面
- [firestore/firestore-schema.txt](/C:/github/inventory-app/firestore/firestore-schema.txt): Firestore のデータ構造メモ
- [firestore/rule.txt](/C:/github/inventory-app/firestore/rule.txt): Firestore Security Rules
- [gas/README.md](/C:/github/inventory-app/gas/README.md): Apps Script の運用メモ
- `images/`: UI 用画像

## Firestore データ構造

### `inventory/{token}`

- `enabled: boolean`: URL を有効にするか
- `roomKey: string`: 校舎キー
- `roomLabel: string`: 校舎表示名
- `updatedAt: timestamp | null`: 最終更新日時
- `completedAt: timestamp | null`: 棚卸完了日時

### `inventory/{token}/items/{itemId}`

- `name: string`
- `publisher: string`
- `edition: string`
- `qty: number`
- `isCustom: boolean`
- `updatedAt: timestamp`

通常教材は `data.js` の ID を使います。未登録教材は `custom_...` 形式の ID で保存されます。

## アクセス制御

- URL クエリの `token` を利用します
- 対応する Firestore ドキュメントが存在しない場合は無効 URL 画面へ遷移します
- `enabled != true` の token は閲覧不可、保存不可です
- `completedAt` が入った token は編集不可です

詳細ルールは [firestore/rule.txt](/C:/github/inventory-app/firestore/rule.txt) を参照してください。

## 基本的な利用フロー

1. URL から対象校舎の棚卸ページを開く
2. 教材を検索して在庫数を入力する
3. 必要に応じて未登録教材を追加する
4. 左下が `保存済み` になっていることを確認してページを閉じる
5. 校舎の作業完了後に `棚卸完了` を実行する

## 保存仕様

- 変更があると自動保存を行います
- `保存` ボタンで手動保存もできます
- 保存状態は画面左下に表示されます
- 競合があった場合は最新データを優先し、対象教材を画面に反映します
- 完了時は未保存データがあれば保存後に完了処理へ進みます

## 未登録教材

- 画面右上から未登録教材を追加できます
- 既存教材を引用して未登録教材を作成できます
- 未登録教材のみ削除可能です
- Firestore 上では `isCustom: true` で管理します

## GAS 連携

`gas/` 配下の Apps Script は、スプレッドシート運用と Firestore 管理を補助します。

- Firestore の棚卸データを校舎別シートへ出力
- 校舎ごとの棚卸完了状態の確認と更新
- 棚卸データのリセット
- 教材マスタから `data.js` を生成

詳細は [gas/README.md](/C:/github/inventory-app/gas/README.md) を参照してください。

## メンテナンス

### 教材マスタを更新する場合

- `data.js` を更新する
- スプレッドシートから生成する場合は `gas/master_data_export.gs` を使う
- 列構成を変えた場合は GAS 側の `headerMap` も確認する

### Firestore まわりを変更する場合

- スキーマ変更時は [firestore/firestore-schema.txt](/C:/github/inventory-app/firestore/firestore-schema.txt) を更新する
- ルール変更時は [firestore/rule.txt](/C:/github/inventory-app/firestore/rule.txt) も更新する
- `app.js` の保存ロジックと整合しているか確認する
- GAS の出力処理、完了状況更新、リセット処理への影響も確認する

### 運用前に確認すること

- 校舎ごとに token が正しく発行されているか
- `enabled` の設定が正しいか
- `【校舎設定・棚卸状況】` の `出力先シート名` と `ドキュメントキー` が重複していないか
- 棚卸完了後に `completedAt` が設定されるか
- 必要時に GAS から集計、完了状況確認、リセットができるか

## 備考

- ローカルに在庫キャッシュとログを保持します
- 個人情報は扱わない前提です
- セキュリティは URL token 前提の簡易運用です
