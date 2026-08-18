# ESP FlashJS

**ESP32 の Flash を、JavaScript とブラウザから解析・編集する。**

[English README](./README.md) · [ドキュメント](./docs/README.ja.md)

[![npm](https://img.shields.io/npm/v/esp-flashjs)](https://www.npmjs.com/package/esp-flashjs)
[![CI](https://github.com/tanakamasayuki/esp-flashjs/actions/workflows/ci.yml/badge.svg)](https://github.com/tanakamasayuki/esp-flashjs/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/esp-flashjs)](./LICENSE)

### ▶ すぐ試す: **<https://tanakamasayuki.github.io/esp-flashjs/>**

Chrome か Edge で開いてボードを繋ぐだけです。インストールは要りません。デバイスがなくても、`.bin` を放り込めばオフラインで解析できます。
[サンプル](https://tanakamasayuki.github.io/esp-flashjs/examples/)

---

ESP32 のフラッシュメモリを JavaScript から読み出し・解析・編集・書き戻しするライブラリです。実行時依存はゼロ、ビルドも不要で、ブラウザと Node.js がそのまま解釈できる素の ESM です。

```js
import { parsePartitionTable } from 'https://cdn.jsdelivr.net/npm/esp-flashjs@0.1.0/dist/esp-flashjs.core.min.js';

const table = parsePartitionTable(bytes);
console.log(table.partitions);
```

---

## 3 つの考え方

**ライブラリファースト。** すべての parser と builder は UI なしで動きます。Web アプリは npm で配布しているのと同じ公開 API の利用者にすぎず、GUI からできてコードからできないことはありません。

**バイナリファースト。** 実機は必要ありません。`flash.bin` や `nvs.bin`、ファームウェアイメージをページに放り込めばオフラインで解析できます。デバイスから読んだデータとファイルから読んだデータは、同じコードを通ります。

**ビルドレス。** ソースは JSDoc で型を書いた ES2022 モジュールです。`dist/` のバンドルは利便性のためにあるだけで、何かがそれを必要としているわけではありません。

## 現状

Phase 1 を実装済みです。Transport、ブートローダプロトコル、チップ検出、stub ロード、Flash の read / write / erase / verify / dump、パーティションテーブル、ファームウェアイメージ、OTA データ、バイナリ差分と検索、そしてリファレンス Web アプリまで動きます。

[esp-flashjs@0.1.0](https://www.npmjs.com/package/esp-flashjs) として公開済みです。

NVS（parse / build / diff）と、SPIFFS・LittleFS・FAT の読み取りも実装済みです。いずれも**自前で生成したイメージではなく、ESP32 / ESP32-S3 / ESP32-P4 の実機から吸い出したフラッシュ**でテストしています。この区別がなぜ効いたかは [テスト fixture の作り方](./tools/fixture-device/README.ja.md) に書いてあります。UI からの NVS 編集とファイルシステムの再構築はこれからです。[ロードマップ](./docs/spec.ja.md#22-ロードマップ)を参照してください。

## インストール

```sh
npm install esp-flashjs
```

```js
// Web Serial を含む全機能
import { EspFlash, EspLoader, WebSerialTransport } from 'esp-flashjs';

// parser とバイナリユーティリティのみ。シリアル関連を含まず軽量で、Node.js でも動作
import { parsePartitionTable, analyzeBinary } from 'esp-flashjs/core';
```

npm のページ: <https://www.npmjs.com/package/esp-flashjs>

CDN からならインストールも不要です。

```html
<script type="module">
  import { analyzeBinary } from 'https://cdn.jsdelivr.net/npm/esp-flashjs@0.1.0/dist/esp-flashjs.min.js';
</script>
```

バージョンは必ず固定してください。バージョン未指定の CDN URL は、メジャー更新のときに他人のページを壊します。

## 使い方

### デバイスなしでファイルを解析する

```js
import { analyzeBinary, parsePartitionTable } from 'esp-flashjs/core';

const result = analyzeBinary(bytes);
console.log(result.type);        // 'partition-table' | 'esp-image' | 'otadata' | 'raw' | 'encrypted?'
console.log(result.confidence);  // 0.0 〜 1.0
console.log(result.regions);     // バイト範囲。Hex ビューのハイライトに使える
console.log(result.issues);      // 見つかった問題。安定した code で返る
```

解析は壊れたデータでも例外を投げません。問題は `issues` に積み、復元できた部分は返します。壊れたイメージこそ一番見たいものだからです。

### デバイスと通信する

```js
import { EspFlash, EspLoader, WebSerialTransport } from 'esp-flashjs';

// クリックハンドラの中で呼ぶ必要があります。
// ブラウザはユーザー操作の中でしかポート選択ダイアログを開きません。
const transport = await WebSerialTransport.request();
const loader = new EspLoader(transport);

await loader.connect();      // リセット → 同期 → チップ判定
await loader.loadStub();     // 失敗時は false。セッションはそのまま使える

const flash = new EspFlash(loader);
const info = await flash.getInfo();

const table = await flash.read(0x8000, 0xc00, {
  onProgress: ({ done, total }) => console.log(done, '/', total),
});

await loader.disconnect();
```

### 読み出しに stub は必須です

ESP32 の ROM ブートローダは `READ_FLASH` / `ERASE_FLASH` / `ERASE_REGION` を実装していません。Flash の読み出し、ダンプ、パーティションの読み出しと、その上に載る機能はすべて、flasher stub を RAM に転送してからでないと使えません。

`loadStub()` は失敗時に例外ではなく `false` を返します。書き込みは ROM でも可能なので、機能を落として動き続けられるようにするためです。この状態で `flash.read()` を呼ぶと、`code === 'REQUIRES_STUB'` の `UnsupportedOperationError` が飛びます。

### エラーは文章ではなくコードを持ちます

```js
try {
  await flash.read(0, 1024);
} catch (error) {
  if (error.code === 'REQUIRES_STUB') { /* … */ }
}
```

すべてのエラーは安定した `code` と `details` を持ちます。`message` は英語の開発者向け文字列です。**ライブラリはユーザー向けの文言を一切生成しません。** それはアプリケーションの責務であり、だからこそリファレンスアプリはライブラリに手を入れずに多言語化できています。

## 対応チップ

チップ定義は現行の ESP32 ファミリを網羅しています。ただし実機で確認できているかは別の話なので、表で区別しています。

| チップ | 検出方法 | 実機検証 |
| --- | --- | --- |
| ESP32 | magic レジスタ | 済 |
| ESP32-S2 | magic レジスタ | 未 |
| ESP32-S3 | chip id | 済 |
| ESP32-C2 | chip id | 未 |
| ESP32-C3 | chip id | 未 |
| ESP32-C5 | chip id | 未 |
| ESP32-C6 | chip id | 未 |
| ESP32-C61 | chip id | 未 |
| ESP32-H2 | chip id | 未 |
| ESP32-P4 | chip id | 済 |

「済」は、そのチップの実機を消去し、既知のパーティションテーブル・NVS・3種のファイルシステムを書き込み、読み戻してテスト fixture としてコミットした、という意味です。この3機種だけでも bootloader の位置が 0x1000 / 0x0 / 0x2000 と違っており、1機種では気づけない類の差です。

ESP8266 は対象外です。プロトコルは共通部分が多いものの、パーティションテーブルやイメージ形式が別物のためです。

## 対応ブラウザ

デバイスと通信するには Web Serial が必要で、セキュアコンテキストでのみ動作します。つまり Chrome・Edge などの Chromium 系**デスクトップ**ブラウザで、HTTPS または `http://localhost` から開いた場合です。

Firefox と Safari でも、ファイルの読み込みとオフライン解析は利用できます。アプリ側で判定し、接続関連の UI だけを無効化します。

## 安全機構

Flash への書き込みはボードを起動不能にしうるので、ライブラリとアプリの両方で対策しています。

- UI 上で、Read / Export / Analyze と Write / Erase を明確に分離しています。
- 書き込み前に対象領域をバックアップし、バックアップに失敗したら書き込みを中止します。
- 破壊的操作にはパーティションラベルの入力を要求します。チェックボックスでは不十分です。
- 境界違反や範囲外の操作は、それらしい値に丸めたり切り詰めたりせず、例外を投げます。
- 暗号化領域はそのように表示し、解析できたかのようには見せません。復号は対象外であり、実装もしません。

## 開発

```sh
npm install
npm run dev            # http://localhost:8080/web/

npm run check          # CI と同じ検査をまとめて（テスト・型・レイヤ・ロケール）
npm test               # node:test。実機不要
npm run test:watch     # 変更を検知して再実行
npm run test:coverage  # 現在 行カバレッジ 93.6%
npm run typecheck      # JSDoc の型を tsc で検査
npm run lint:layers    # 依存方向と import の健全性
npm run lint:locales   # 訳の欠落と placeholder の不整合

npm run build          # dist/
npm run build:site     # site/。Pages が配信するもの
npm run fetch-stub     # flasher stub を取り直す
```

npm への公開は手元のマシンから、コピペ 3 行で行います。[リリース手順](./docs/release.ja.md)を参照してください。

テストは `MockTransport` に対して走ります。これは `Uint8Array` を Flash に見立て、本物の SLIP プロトコルで応答する仮想デバイスです。プロトコル層を CI で検証できるのはこのおかげです。

ソースは素の JavaScript です。TypeScript は JSDoc の型検査と、リリース時の `.d.ts` 生成にしか使っておらず、トランスパイルは一切行いません。

テストの書き方、`MockTransport` で再現できること・できないこと、実機での手動テスト項目は[開発ガイド](./docs/development.ja.md)にまとめてあります。

## ドキュメント

全文書に英語版があります。一覧は [docs/README.ja.md](./docs/README.ja.md) にあります。

| 文書 | 内容 |
| --- | --- |
| [spec.ja.md](./docs/spec.ja.md) | 仕様書。設計判断、プロトコル、各フォーマット、安全機構 |
| [development.ja.md](./docs/development.ja.md) | 開発ガイド。セットアップ、テスト、実機チェックリスト |
| [analyzers.ja.md](./docs/analyzers.ja.md) | Analyzer プラグインの書き方 |
| [transports.ja.md](./docs/transports.ja.md) | Transport の書き方（Node.js・WebUSB など） |
| [ci.ja.md](./docs/ci.ja.md) | GitHub Actions 3 本の説明と必要な設定 |
| [release.ja.md](./docs/release.ja.md) | バージョニングとリリース手順 |
| [publishing.ja.md](./docs/publishing.ja.md) | npm / CDN / Pages の構成とその理由 |

## ライセンス

MIT。[LICENSE](./LICENSE) を参照してください。

同梱している flasher stub は [espressif/esp-flasher-stub](https://github.com/espressif/esp-flasher-stub) 由来で、Apache-2.0 OR MIT のデュアルライセンスです。[NOTICE](./NOTICE) を参照してください。

ESP FlashJS は Espressif Systems の公式プロジェクトではありません。
