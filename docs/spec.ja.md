# ESP FlashJS 仕様書 v1.0

[English](./spec.md) · **日本語**

- 対象読者: 本リポジトリの実装者
- ステータス: Phase 1 実装済み。本書は実装に合わせて更新してある
- 最終更新: 2026-08-14

関連文書: [development.ja.md](./development.ja.md)（開発・テスト） / [ci.ja.md](./ci.ja.md)（GitHub Actions） / [release.ja.md](./release.ja.md)（リリース手順） / [publishing.ja.md](./publishing.ja.md)（配布方法）

---

## 1. 概要

**ESP FlashJS** は、ESP32 シリーズのフラッシュメモリを JavaScript から読み取り・解析・編集・書き戻しできる汎用ライブラリである。

中心は UI に依存しないコアライブラリであり、ブラウザ上で Web Serial API を用いる Web アプリケーションを公式リファレンス実装として提供する。Web アプリは GitHub Pages で公開する。

キャッチコピー:

> JavaScript toolkit for ESP32 flash analysis, editing and programming.
> ESP32 の Flash を、JavaScript とブラウザから解析・編集する。

### 1.1 主な用途

- ESP32 デバイスからの Flash 読み出し・書き込み・ダンプ取得
- ESP Partition Table の解析と、Partition 単位での抽出・更新
- NVS の解析、key / namespace / value の表示・編集、再構築と書き戻し
- SPIFFS / LittleFS 等のデータ領域の解析
- ESP firmware image の解析
- バイナリファイル単体でのオフライン解析と、解析結果を利用した編集

### 1.2 設計の三本柱

1. **Library First** — すべての解析・生成機能は UI なしで呼び出せる。GUI は API の consumer にすぎない。Web アプリから使える機能は、原則として外部アプリケーションからも同じ API で利用できる。
2. **Binary First** — デバイスに接続していなくても、`flash.bin` / `partition.bin` / `nvs.bin` などをファイルとして読み込んで解析できる。デバイスから読み出したデータとファイルから読み込んだデータは、可能な限り同一 API で処理する。
3. **Buildless-friendly** — ソースは素の ESM であり、ビルドせずそのまま `import` できる。配布用の minify 版は用意するが、それはあくまで利便のためであり、ライブラリを使う前提条件ではない。

### 1.3 最終ゴール

```text
Device → Flash → Partition → Data Structure → Edit → Rebuild → Write Back
```

この一連の処理を、UI に依存しない JavaScript API として提供する。そのリファレンス実装として ESP FlashJS Web を提供し、ESP32 の Flash 構造をブラウザから視覚的に調査・編集できる環境を実現する。

---

## 2. スコープ

### 2.1 対象

| 領域 | 内容 |
| --- | --- |
| Transport | 通信の抽象化。Web Serial 実装を提供 |
| Protocol | ESP ROM / stub loader のシリアルプロトコル |
| Flash | read / write / erase / verify / dump |
| Partition | Partition Table 解析・生成、Partition 単位の操作 |
| Image | ESP firmware image 解析 |
| NVS | 解析・編集・再構築・Diff |
| Filesystem | SPIFFS 解析（Phase 3）、LittleFS（Phase 4） |
| Binary | 形式自動判定、Hex View 用データ供給、Binary Diff |
| Web | 上記すべてを GUI から利用できるリファレンス実装 |

### 2.2 非対象（明示的にやらないこと）

- Flash Encryption / Secure Boot の復号・回避。暗号化領域は「暗号化されている」と表示するのみ（[19. 暗号化領域](#19-暗号化領域)）。
- ESP-IDF プロジェクトのビルド。
- **ESP8266 のサポート。** プロトコルには共通部分が多いが、Partition Table が存在しないなどフォーマット体系が別物であるため対象外とする。将来の検討事項。
- Node.js CLI ツールの提供。Core は Node.js でも動作するが、CLI は本仕様の範囲外。

### 2.3 対象チップ

現行の主要チップを全て対象とする。stub JSON は全チップ分を同梱する（合計 132KB。バンドルには埋め込まず実行時 fetch するため、解析しか使わない利用者には転送されない）。

```text
ESP32  /  ESP32-S2  /  ESP32-S3
ESP32-C2 (ESP8684)  /  ESP32-C3  /  ESP32-C5  /  ESP32-C6  /  ESP32-C61
ESP32-H2  /  ESP32-P4
```

チップ対応の実体は「チップ定義テーブルへの 1 エントリ追加」と「stub JSON の配置」だけなので、実装量は対象数にほとんど比例しない。したがって網羅を優先する。

ただし**実機検証は入手できたボードに限られる**。各チップの検証状況は README に表で明示し、未検証のチップは「未検証」と正直に記載する。動作を保証したかのように書いてはならない。

### 2.4 対象ブラウザ

Web Serial API を実装するブラウザ（Chrome / Edge / Opera 系のデスクトップ版）。

Firefox / Safari では **Binary モード（ファイル読み込みによるオフライン解析）のみ** 利用可能とし、デバイス接続 UI は「このブラウザは Web Serial に非対応」と明示して無効化する。機能全体をブロックしてはならない。

---

## 3. 主要な設計判断

実装中に「なぜこうなっているのか」を再検討せずに済むよう、判断とその理由を記録する。

| # | 判断 | 理由 |
| --- | --- | --- |
| 1 | **TypeScript ではなく素の JavaScript (ESM) で書く。型は JSDoc で表現する** | プロジェクト方針。ソースは `.js` のままで、`tsc` はトランスパイラではなく型検査ツールとしてのみ使う |
| 2 | **UI フレームワークを使わない。Custom Elements と自作の極小 store で構成する** | ランタイム依存ゼロを保ち、ビルドなしで動く状態を維持するため |
| 3 | **npm は単一パッケージ `esp-flashjs`。ディレクトリでモジュール分割する** | ビルド構成上、パッケージを分けても利用者側の利得がない。`exports` のサブパスを維持すれば、後から分割公開へ移行できる |
| 4 | **ソースは細かく分割し、配布時に `dist` へ束ねる** | 開発時の保守性と、利用者から見た「1 ファイルで使える」体験を両立させる |
| 5 | **Flash Read / Erase Region は stub loader のロードを前提とする** | ESP32 の ROM loader は `READ_FLASH(0xd2)` / `ERASE_FLASH(0xd0)` / `ERASE_REGION(0xd1)` を持たない。Dump・Partition Read・NVS 解析がすべてこれに依存するため、Phase 1 の必須要件とする（[6.4](#64-stub-loader)） |
| 6 | **stub JSON はバンドルに埋め込まず、実行時に fetch する** | 全チップ分を埋め込むと本体が数百 KB 肥大し、オフライン解析しかしない利用者にも負担させることになる。チップ追加も JSON を置くだけで済む |
| 7 | **Transport は Reader/Writer ベースの非同期 I/O とし、タイムアウトと `AbortSignal` を持つ** | 実際のシリアル通信では「長さ指定の read」が成立しない。SLIP はフレーム区切りで長さが事前に確定しないため |
| 8 | **Filesystem の再構築は Phase 4 とし、Phase 3 は SPIFFS の読み取り専用解析にとどめる** | SPIFFS 再構築は互換性リスクが高く、MVP に含めると Phase 1/2 が遅れる |
| 9 | **UI は多言語対応とし、`navigator.languages` から自動判定する** | ESP32 の利用者層は国際的であり、後から i18n を導入すると全文言の洗い出しが必要になる。最初から辞書を外出しする |

---

## 4. アーキテクチャ

### 4.1 レイヤ構造

依存は上から下への一方向のみ。逆流を禁止する。

```text
┌─────────────────────────────────────────────┐
│  web/            Web リファレンス実装         │  DOM / Web Serial / File API
├─────────────────────────────────────────────┤
│  src/index.js    公開 API (barrel)           │
├───────────────┬───────────────┬─────────────┤
│  device/      │  format/      │  binary/    │
│  flash 操作    │  解析・生成    │  汎用処理    │
│  ・EspFlash   │  ・partition  │  ・Reader   │
│  ・chip 情報   │  ・image      │  ・Writer   │
│               │  ・nvs        │  ・diff     │
│               │  ・spiffs     │  ・crc/md5  │
├───────────────┼───────────────┴─────────────┤
│  protocol/    │  SLIP・コマンド・stub loader   │
├───────────────┴─────────────────────────────┤
│  transport/   │  Transport 抽象 + 実装        │
└─────────────────────────────────────────────┘
```

**厳守するルール:**

- `format/` と `binary/` は `transport/` `protocol/` `device/` に依存してはならない。`Uint8Array` を入力し、`Uint8Array` またはプレーンオブジェクトを出力する純粋関数群である。
- `src/` 配下のいかなるファイルも `document` / `window` / `navigator` を参照してはならない。唯一の例外は `transport/web-serial.js`（`navigator.serial` を使用）で、これは明示的に分離されたエントリポイントとする。
- `web/` のロジックを `src/` に持ち込まない。

### 4.2 リポジトリ構成

```text
esp-flashjs/
├── README.md                 # 英語
├── README.ja.md              # 日本語
├── LICENSE                   # MIT
├── NOTICE                    # 同梱する第三者成果物（flasher stub）の帰属表示
├── package.json
├── tsconfig.json             # 型検査と .d.ts 生成のためだけに置く
├── .gitignore                # node_modules / dist / types / site
│
├── src/                      # ライブラリ本体（ビルド不要の ESM）
│   ├── index.js              # 公開 API barrel（デバイス依存を含む全部）
│   ├── core.js               # デバイス非依存のみの barrel（Node / オフライン用）
│   │
│   ├── transport/
│   │   ├── transport.js      # 抽象基底 + JSDoc typedef
│   │   └── web-serial.js     # WebSerialTransport
│   │
│   ├── testing/
│   │   └── mock-transport.js # 仮想デバイス。Transport だがプロトコルを話すため
│   │                         # transport/ ではなくここに置く（4.3 参照）
│   │
│   ├── protocol/
│   │   ├── slip.js           # SLIP エンコード / デコード
│   │   ├── commands.js       # コマンド定数と packet の組み立て / 解釈
│   │   ├── loader.js         # EspLoader
│   │   ├── chips.js          # チップ定義テーブル
│   │   ├── stub-loader.js    # stub JSON の取得と RAM へのロード
│   │   └── stub/             # チップ別 stub JSON（Apache-2.0 OR MIT）
│   │       ├── esp32.json
│   │       ├── esp32s3.json
│   │       └── ...
│   │
│   ├── device/
│   │   ├── esp-flash.js      # EspFlash
│   │   └── device-info.js
│   │
│   ├── format/
│   │   ├── registry.js       # Analyzer プラグイン登録
│   │   ├── partition.js
│   │   ├── image.js
│   │   ├── otadata.js
│   │   ├── spiffs.js         # Phase 3
│   │   └── nvs/
│   │       ├── parse.js
│   │       ├── build.js
│   │       ├── store.js
│   │       └── diff.js
│   │
│   ├── binary/
│   │   ├── reader.js / writer.js
│   │   ├── diff.js / search.js / hash.js
│   │
│   └── util/
│       ├── errors.js / events.js / hex.js
│
├── web/                      # リファレンス Web アプリ
│   ├── index.html            # アプリのエントリ
│   ├── esp-flashjs.js        # ★ 唯一の外向き参照（4.4 参照）
│   ├── app.js                # 起動・配線
│   ├── store.js              # 極小の状態管理
│   ├── actions.js            # ユースケース（Core API 呼び出しの集約）
│   ├── i18n.js               # 言語判定と辞書ロード
│   ├── locales/
│   │   ├── en.json / ja.json / zh-Hans.json / zh-Hant.json
│   ├── components/           # Custom Elements
│   │   ├── esp-device-panel.js
│   │   ├── esp-flash-map.js
│   │   ├── esp-file-list.js
│   │   ├── esp-inspector.js
│   │   ├── esp-hex-viewer.js
│   │   ├── esp-confirm-dialog.js
│   │   └── esp-log.js
│   │                         # Phase 2 で esp-nvs-tree / esp-nvs-editor,
│   │                         # Phase 3 で esp-diff-view を追加予定
│   └── styles/
│       └── app.css
│
├── examples/                 # 単機能の最小サンプル（各 1 HTML ファイル）
│   ├── index.html            # サンプル一覧
│   ├── analyze-binary.html   # デバイス不要
│   ├── partition-parser.html # デバイス不要
│   └── flash-read.html       # Web Serial
│
├── docs/                     # 英語版と日本語版（.ja.md）を併置
│   ├── README.md             # 索引
│   ├── spec.md               # 本書
│   ├── development.md
│   ├── ci.md
│   ├── release.md
│   └── publishing.md
│
├── test/
│   ├── helpers.js            # fixture ビルダー
│   ├── binary.test.js        # util/ と binary/
│   ├── format.test.js        # format/
│   ├── protocol.test.js      # protocol/ と device/（MockTransport 経由）
│   └── web.test.js           # web/ の DOM 非依存部分
│
├── scripts/
│   ├── build.js              # esbuild → dist/
│   ├── build-site.js         # → site/（GitHub Pages 用）
│   ├── fetch-stub.js         # stub JSON をリリースから取得
│   ├── check-layers.js       # 依存方向と import の健全性（CI）
│   ├── check-locales.js      # ロケールのキー欠落と placeholder 不整合（CI）
│   └── serve.js              # ローカル開発用 HTTP サーバ（依存ゼロ）
│
├── scripts/
│   └── sync-version.js       # npm version から VERSION 定数へ同期
│
└── .github/workflows/
    ├── ci.yml                # 検査 + ビルド
    ├── pages.yml             # GitHub Pages デプロイ
    └── release.yml           # npm publish
```

**生成物（すべて `.gitignore`）:**

```text
dist/                         # npm / CDN 配布物
├── esp-flashjs.js            # full, ESM, 非圧縮
├── esp-flashjs.min.js        # full, ESM, 圧縮
├── esp-flashjs.core.js       # デバイス非依存のみ
├── esp-flashjs.core.min.js
└── stub/*.json               # fetch 対象。バンドルには埋め込まない

types/                        # .d.ts（リリース時のみ生成）
site/                         # GitHub Pages へアップロードする成果物
```

### 4.3 各ディレクトリの責務

境界を越えた依存は禁止する。

| ディレクトリ | 責務 | 依存してよい先 |
| --- | --- | --- |
| `src/util/` | 汎用ヘルパ（エラー、hex 整形、イベント） | なし |
| `src/binary/` | バイト列の読み書き・差分・検索・ハッシュ | `util/` |
| `src/format/` | 各フォーマットの parse / build。**純粋関数のみ** | `binary/`, `util/` |
| `src/transport/` | I/O 抽象と実装 | `util/` |
| `src/protocol/` | SLIP・コマンド・チップ定義・stub | `transport/`, `binary/`, `util/` |
| `src/device/` | Flash 操作のユースケース | `protocol/`, `binary/`, `format/`, `util/` |
| `src/testing/` | 仮想デバイス | `protocol/`, `transport/`, `binary/`, `format/`, `util/` |
| `web/` | UI。Core API の consumer | `./esp-flashjs.js` のみを通じて `src/` |
| `examples/` | 最小サンプル | `../src/`。`web/` には依存しない |

`format/` と `binary/` が `transport/` `protocol/` `device/` を import していないことは、`scripts/check-layers.js` が CI で静的に検証する。同スクリプトは拡張子なしの import と、`web-serial.js` 以外での DOM グローバル参照も検出する。

**`testing/` を分けた理由:** `MockTransport` は `Transport` を実装するが、コマンドに応答するにはプロトコルを解釈しなければならない。`transport/` に置くと依存が逆流するため、protocol より上の層として独立させている。

### 4.4 モジュール解決とパス

ビルドツールに依存せず、ブラウザのネイティブ ESM だけで解決できる状態を保つ。

- `import` の指定子は**必ず相対パスで、拡張子付き**。`./slip.js`（○）、`./slip`（×）、`slip.js`（×＝bare specifier 扱いになる）。
- ディレクトリの `index.js` への暗黙解決は**存在しない**。`./format/nvs/parse.js` と明記する。
- `src/` 配下から `web/` を参照してはならない。逆方向のみ。
- ファイル相対でリソースを参照する場合（stub JSON）は `new URL('./stub/esp32.json', import.meta.url)` を使う。これで npm / CDN / Pages のいずれから読み込まれても解決できる。

**`web/esp-flashjs.js` の役割（重要）:**

`web/` から `src/` への参照は、この 1 ファイルだけに集約する。

```js
// web/esp-flashjs.js — リポジトリ内での唯一の内容
export * from '../src/index.js';
```

`web/` 配下の他のファイルは、必ず `./esp-flashjs.js` または `../esp-flashjs.js`（`components/` から）を経由して Core を参照する。**`web/` 内のファイルが `../src/` を直接書いてはならない。**

こうしておくと、`build-site.js` が `site/` を組み立てる際、`web/` の中身をサイトルートへ配置しても、**書き換えが必要なのはこの 1 ファイルだけ**になる（[docs/publishing.ja.md](./publishing.ja.md) 2.2 参照）。`web/` 内部の相対参照はすべて兄弟関係なので、配置場所が変わっても壊れない。

### 4.5 コーディング規約

| 項目 | 規約 |
| --- | --- |
| 言語 | ECMAScript 2022 以上、ESM のみ。CommonJS は提供しない |
| トランスパイル | **行わない。** ブラウザ・Node.js がネイティブに解釈できる構文のみ使用する。`dist` の生成は esbuild による bundle と minify のみで、構文変換は伴わない |
| 型 | JSDoc で記述する。`@typedef` は各モジュール先頭に置く。全ファイル先頭に `// @ts-check` を付与し、CI の `tsc --noEmit --checkJs` を通すことを必須とする |
| 実行時依存 | **ゼロ。** devDependencies は esbuild と typescript のみ |
| 数値 | Flash アドレス・サイズは `Number`（16MB は安全に表現可能）。NVS の U64/I64 のみ `BigInt` |
| バイト列 | 常に `Uint8Array`。`ArrayBuffer` や `Buffer` を API 境界に出さない |
| エンディアン | ESP のフォーマットはすべてリトルエンディアン。`ByteReader` は LE を既定とする |
| 命名 | クラスは PascalCase、関数は camelCase、定数は SCREAMING_SNAKE_CASE |
| 非同期 | Promise / async。長時間処理は `AbortSignal` と `onProgress` を受け取る |
| 副作用 | モジュールのトップレベルで I/O・グローバル登録を行わない（`registry.js` の既定 analyzer 登録を除く） |
| 文言 | `src/` にユーザー向け表示文言を置かない。エラーは安定した `code` を持ち、翻訳は `web/locales/` が担う |

---

## 5. Transport 層

### 5.1 インターフェース

```js
/**
 * @typedef {object} Transport
 * @property {() => Promise<void>} open
 * @property {() => Promise<void>} close
 * @property {() => boolean} isOpen
 * @property {(data: Uint8Array) => Promise<void>} write
 * @property {(opts?: {timeoutMs?: number, signal?: AbortSignal}) => Promise<Uint8Array>} read
 *   受信済みのバイトを 1 チャンク返す。タイムアウト時は TransportTimeoutError を投げる
 * @property {(baudRate: number) => Promise<void>} [setBaudRate]
 * @property {(signals: {dtr?: boolean, rts?: boolean}) => Promise<void>} [setSignals]
 *   ブートローダ突入に必要。未対応なら undefined
 * @property {() => Promise<void>} [flushInput]
 */
```

`read()` が長さ指定でないのは、SLIP のフレーム区切りが `0xC0` であり長さが事前に確定しないため。フレーム組み立ては `protocol/slip.js` が受け持つ。

`setSignals` を持たない Transport では自動ブートローダ突入ができない。この場合、UI は「BOOT ボタンを押しながら EN を押してください」という手動手順を案内する。

### 5.2 WebSerialTransport

```js
new WebSerialTransport(port, { baudRate = 115200 })
WebSerialTransport.request(filters?)  // -> Promise<WebSerialTransport>  navigator.serial.requestPort() のラッパ
WebSerialTransport.list()             // -> Promise<WebSerialTransport[]> 既許可ポート
```

- `navigator.serial.requestPort()` は**ユーザージェスチャ内**でのみ呼べる。`open()` とは分離する。
- ボーレート変更は `port.close()` → `port.open({baudRate})` で行う。CHANGE_BAUDRATE 送信後 35ms 程度待ってから再オープンする。
- ページ離脱時に `port.close()` を試みる（`beforeunload`）。

### 5.3 MockTransport

fixture の Flash イメージを与えると、実機のように SLIP コマンドへ応答する。実機なしで CI を回すために**必須**とする。

---

## 6. Protocol 層

### 6.1 SLIP フレーミング

- フレームは `0xC0` で開始・終了する。
- フレーム内では `0xC0` → `0xDB 0xDC`、`0xDB` → `0xDB 0xDD` にエスケープする。
- エスケープはチェックサム計算の**後**に行う。

```js
slipEncode(payload)  // -> Uint8Array
class SlipDecoder { push(chunk): Uint8Array[] }
```

### 6.2 パケット形式

要求（8 バイトヘッダ + データ）:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Direction = `0x00` |
| 1 | 1 | Command |
| 2 | 2 | Data length (LE) |
| 4 | 4 | Checksum (LE) — データ系コマンドのみ有効 |
| 8 | n | Data |

応答:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Direction = `0x01` |
| 1 | 1 | Command（要求のエコー） |
| 2 | 2 | Data length (LE) |
| 4 | 4 | Value（READ_REG の戻り値） |
| 8 | n | Data + status bytes |

**ステータスバイトの位置（重要）**

応答のペイロードは `[data][status(2)][reserved(2)]` の並びである。`data` は**そのコマンドが返すと定義されている長さ**であり、末尾の予約 2 バイトは ESP32 系 ROM ローダのみが付ける。

つまり**ステータスの位置はペイロード長から推測できない**。「末尾から数える」実装は、予約バイトの有無で 2 バイトずれる。呼び出し側が期待するデータ長を渡す設計とすること。

```js
decodeResponse(frame, responseDataLength = 0)
loader.command(op, payload, { responseDataLength })
```

`status[0] !== 0` ならエラーで、`status[1]` がエラーコード。ペイロードが `responseDataLength + 2` に満たない場合は、コマンドを即座に拒否した応答とみなして先頭 2 バイトをステータスとして読む。

データ長が可変なのは `GET_SECURITY_INFO`（20 または 12）と `SPI_FLASH_MD5`（ROM は 32 文字の hex 文字列、stub は 16 バイトの生値）で、この 2 つは `responseDataLength` に関数を渡して実行時に判定する。

チェックサムはデータ系コマンド（`FLASH_DATA` / `MEM_DATA` / `FLASH_DEFL_DATA`）のみ。シード `0xEF` に対しペイロードを 1 バイトずつ XOR する。

### 6.3 コマンド一覧

ROM / stub 共通:

| Opcode | 名前 | 用途 |
| --- | --- | --- |
| `0x02` | FLASH_BEGIN | 書き込み開始 |
| `0x03` | FLASH_DATA | 書き込みデータ |
| `0x04` | FLASH_END | 書き込み終了 |
| `0x05` | MEM_BEGIN | RAM 転送開始（stub ロード用） |
| `0x06` | MEM_END | RAM 転送終了・エントリ実行 |
| `0x07` | MEM_DATA | RAM 転送データ |
| `0x08` | SYNC | 同期（`07 07 12 20` + `0x55` × 32） |
| `0x09` | WRITE_REG | 32bit レジスタ書き込み |
| `0x0a` | READ_REG | 32bit レジスタ読み出し |
| `0x0b` | SPI_SET_PARAMS | Flash パラメータ設定 |
| `0x0d` | SPI_ATTACH | SPI Flash アタッチ |
| `0x0f` | CHANGE_BAUDRATE | ボーレート変更 |
| `0x10` | FLASH_DEFL_BEGIN | 圧縮書き込み開始 |
| `0x11` | FLASH_DEFL_DATA | 圧縮書き込みデータ |
| `0x12` | FLASH_DEFL_END | 圧縮書き込み終了 |
| `0x13` | SPI_FLASH_MD5 | Flash 領域の MD5 |

**stub loader 専用:**

| Opcode | 名前 |
| --- | --- |
| `0xd0` | ERASE_FLASH（全消去） |
| `0xd1` | ERASE_REGION（領域消去） |
| `0xd2` | READ_FLASH |
| `0xd3` | RUN_USER_CODE |

### 6.4 stub loader

**Flash の読み出しと領域消去は ROM loader ではできない。** これは本プロジェクトの中核機能（Flash Dump / Partition Read / NVS 解析）に直結するため、stub loader のロードを Phase 1 の必須要件とする。

**入手元とライセンス:**

- Espressif の [esp-flasher-stub](https://github.com/espressif/esp-flasher-stub)（Rust 実装）の release JSON を使用する。**Apache-2.0 OR MIT のデュアルライセンス**であり、MIT の本リポジトリに同梱できる。
- 旧 [esptool-legacy-flasher-stub](https://github.com/espressif/esptool-legacy-flasher-stub) は **GPL-2.0 のため使用しない。** 誤って混入しないよう、取得は `scripts/fetch-stub.js` でリリース URL を固定して行い、取得元タグを `src/protocol/stub/README.md` に記録する。

**配布方法:**

JSON はバンドルに埋め込まず、`src/protocol/stub/<chip>.json` として個別に配置し、実行時に `fetch` する。

```js
// stub-loader.js
const url = new URL(`./stub/${chip.stub}.json`, import.meta.url);
```

`import.meta.url` を基準にすることで、npm / CDN / Pages / ローカルのいずれから読み込まれても解決できる。`dist/` にも `dist/stub/*.json` として同じ相対関係で同梱する。

**ロード手順:** `MEM_BEGIN` → `MEM_DATA`×n → `MEM_END(entry)` を text / data セグメントそれぞれについて実行し、最後に stub からの `OHAI` を待つ。

**フォールバック:** stub のロードに失敗した場合は ROM モードへフォールバックし、以下を UI 上で無効化する — Flash Read、Flash Dump、Partition Read、Erase Region、および Read を前提とする全解析機能。書き込みと全消去（FLASH_BEGIN の erase 指定経由）は継続可能。

### 6.5 チップ検出

**検出方法は 1 つではない。** 世代によって 2 通りあり、両方を順に試す必要がある。

| 世代 | 方法 |
| --- | --- |
| ESP32、ESP32-S2 | `CHIP_DETECT_MAGIC_REG = 0x40001000` を `READ_REG` で読み、magic 値で同定する |
| ESP32-S3 以降 | `GET_SECURITY_INFO (0x14)` の応答に含まれる **chip id** で同定する。これらのチップは固有の magic 値を持たない |

手順:

1. `GET_SECURITY_INFO` を発行する。応答本文が 22 バイト以上なら 20 バイト形式（chip id あり）、それ未満なら 12 バイト形式（ESP32-S2。chip id を含まない）。
2. chip id が得られ、既知の `IMAGE_CHIP_ID` と一致すればそれを採用する。
3. 得られなければ magic レジスタを読み、magic テーブルと照合する。
   - ESP32 は `GET_SECURITY_INFO` 自体を実装していないため、手順 1 は失敗する。これは正常な経路であり、エラーとして扱わない。
4. どちらでも同定できなければ `UnknownChipError`。UI は「未知のチップです。Flash 操作は行えません」と表示する。**推測して既知チップとして扱ってはならない。**

Secure Download Mode ではレジスタ読み出しも禁止されるため、手順 3 も失敗しうる。

```js
/**
 * @typedef {object} ChipDef
 * @property {string} name             - "ESP32-S3"
 * @property {number} imageChipId      - IMAGE_CHIP_ID。GET_SECURITY_INFO の chip id と同一
 * @property {boolean} usesMagicValue  - false なら chip id でのみ同定できる
 * @property {number|null} magicValue
 * @property {string} stub             - stub JSON のファイル名
 * @property {number} flashWriteSize
 * @property {number} ramBlockSize
 * @property {number} bootloaderOffset
 * @property {number} macEfuseReg
 * @property {number} spiRegBase       - 以下は RDID による Flash サイズ検出に必要
 * @property {number} spiUsrOffs
 * @property {number} spiUsr1Offs
 * @property {number} spiUsr2Offs
 * @property {number} spiMosiDlenOffs
 * @property {number} spiMisoDlenOffs
 * @property {number} spiW0Offs
 * @property {boolean} spiAddrRegMsb
 * @property {Array<{start:number,end:number,name:string}>} memoryMap
 * @property {string[]} features       - 翻訳キーとして使う安定 ID
 */
```

magic 値・レジスタアドレスは esptool のターゲット定義と突き合わせて検証する。値の誤りは致命的なので、更新時は必ず一次情報に当たること。

**Flash サイズの検出**は、SPI コントローラの「user command」レジスタ経由で RDID (0x9F) を発行し、返る JEDEC ID の容量バイトから引く。チップごとに SPI レジスタのベースとオフセットが異なるため、`ChipDef` に持たせている。検出できない場合は `null` を返し、**既定値で埋めない**（誤ったサイズはダンプを黙って切り詰める）。

### 6.6 ブートローダ突入（reset strategy）

`setSignals` を持つ Transport では以下のシーケンスを実行する（classic reset）:

```text
DTR=false, RTS=true   → 100ms   (EN=low, リセット保持)
DTR=true,  RTS=false  → 50ms    (IO0=low, EN=high でブート)
DTR=false             → 50ms
```

USB-JTAG-Serial 内蔵チップ（C3/S3/C6 等）では上記が効かないことがあるため、失敗時は別バリアントを 1 回リトライし、それでも SYNC が通らなければ手動手順を案内する。

`SYNC` は最大 7 回、各 100ms タイムアウトでリトライする。

### 6.7 EspLoader API

```js
const loader = new EspLoader(transport, { onLog });
await loader.connect({ signal });         // reset → sync → チップ検出
await loader.loadStub();                  // 失敗時 false を返し ROM モード継続
loader.chip                               // -> ChipDef
loader.isStub                             // -> boolean
await loader.command(op, data, checksum, { timeoutMs });
await loader.readReg(addr);
await loader.changeBaudRate(921600);
await loader.disconnect({ reset: true });
```

---

## 7. Flash 操作

```js
const flash = new EspFlash(loader);

await flash.getInfo();                                      // -> DeviceInfo
await flash.read(address, size, { onProgress, signal, chunkSize, attempts });
//   -> Uint8Array  ※ stub 必須
//
// READ_FLASH の1転送は all-or-nothing です。stub は範囲全体に対して MD5 を
// 1つ返すため、1バイト落ちただけでそれまで読んだぶんが全部破棄されます。
// そこで読み出しは chunkSize（既定 256KB）ごとに分割し、各チャンクを
// attempts 回（既定 3）まで再試行します。バイトを落とすリンクでは、
// 何度リトライしても数MBを1転送で通すことはできません。
await flash.write(address, data, { compress = true, verify = false, onProgress, signal });
await flash.eraseRegion(address, size);                     // ※ stub 必須、4KB 境界
await flash.eraseAll();
await flash.verify(address, data);                          // -> {ok, expected, actual}  MD5 比較
await flash.dump({ size, onProgress, signal });             // -> Uint8Array
```

### 7.1 制約と検証

| 項目 | 規則 |
| --- | --- |
| write のアライン | `address` は 4 バイト境界。違反時は `AlignmentError` |
| eraseRegion | `address` と `size` の両方が 4096 の倍数。違反時は `AlignmentError` |
| 範囲外 | `address + size > flashSize` は例外を投げる。**切り詰めない** |
| write のブロック長 | チップごとの `flashWriteSize`（多くは 0x400）に従う |
| read | stub の READ_FLASH に要求サイズとブロックサイズを渡し、応答を逐次受信して MD5 で検証する |
| verify | `SPI_FLASH_MD5` を使う。読み戻し比較はフォールバック |
| 進捗 | `onProgress({ done, total, phase })` を 64KB ごと以上の頻度で呼ぶ |
| 中断 | `signal.aborted` を各ブロック境界で確認し `AbortError` を投げる。中断後の Flash 状態は不定である旨をエラーの `details` に含める |

### 7.2 圧縮書き込み

`FLASH_DEFL_*` は zlib deflate を要求する。**実行時依存ゼロを守るため `CompressionStream('deflate')` を使用する。** 利用不可の環境では自動的に非圧縮 `FLASH_*` へフォールバックする（`compress: true` は「可能なら圧縮」の意味）。

### 7.3 DeviceInfo

```js
/**
 * @typedef {object} DeviceInfo
 * @property {string} chip            - "ESP32-S3" | "unknown"
 * @property {string} revision        - "v0.1" | "unknown"
 * @property {string} mac             - "24:0a:c4:xx:xx:xx" | "unknown"
 * @property {number|null} flashSize  - bytes。検出不能なら null
 * @property {string} flashMode       - "qio" | "dio" | ... | "unknown"
 * @property {string} flashFreq       - "80m" | "40m" | "unknown"
 * @property {string[]} features      - ["wifi", "ble", "embedded-flash"] ※翻訳キーとして使う安定 ID
 * @property {boolean} secureDownloadMode
 * @property {boolean|null} flashEncryptionEnabled
 * @property {boolean} usingStub
 */
```

取得できない項目は `"unknown"` または `null` とし、**推定値で埋めない**。

Secure Download Mode が有効なチップでは Flash 読み出し・RAM 書き込みが禁止される。検出したら UI 上部に警告バナーを出し、Read 系操作を無効化する。

---

## 8. Partition Table

### 8.1 フォーマット

- 既定オフセット `0x8000`、領域サイズ `0xC00`（3072 バイト = 最大 95 エントリ + MD5 エントリ）。
- 1 エントリ 32 バイト:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 2 | Magic。**バイト列で `AA 50`**（LE u16 として読むと `0x50AA`。下記参照） |
| 2 | 1 | Type |
| 3 | 1 | Subtype |
| 4 | 4 | Offset |
| 8 | 4 | Size |
| 12 | 16 | Label（NUL 終端 ASCII） |
| 28 | 4 | Flags |

- MD5 チェックサムエントリ: Magic `0xEBEB`、offset 16 以降 16 バイトが直前までのエントリの MD5。

> **magic のバイト順に注意。** Espressif の `gen_esp32part.py` は `MAGIC_BYTES = b"\xAA\x50"` と**バイト列として**定義し、生のまま比較する。したがってフラッシュ上の並びは `AA 50` であり、リトルエンディアン u16 として読むと **`0x50AA`** になる（`0xAA50` ではない）。
>
> ここを逆にすると、**自分が生成したテーブルだけ読めるパーサ**ができあがる。parse → build のラウンドトリップは両側が同じ誤りを共有するため素通りしてしまい、v0.1.0 ではこの状態で出荷された。実機由来のバイト列を fixture に持つこと（`test/real-hardware.test.js`）。
- 終端は `0xFF` 埋めまたはエントリなし。

### 8.2 API

```js
parsePartitionTable(data, { offset = 0 })     // -> PartitionTable
buildPartitionTable(table)                    // -> Uint8Array (0xC00, 0xFF padded, MD5 付き)
validatePartitionTable(table, { flashSize })  // -> Issue[]
```

```js
/**
 * @typedef {object} Partition
 * @property {string} label
 * @property {number} type
 * @property {number} subtype
 * @property {string} typeName      - "app" | "data" | "unknown"
 * @property {string} subtypeName   - "factory" | "ota_0" | "nvs" | "spiffs" | "unknown"
 * @property {number} offset
 * @property {number} size
 * @property {number} flags
 * @property {boolean} encrypted    - flags bit0
 * @property {number} entryIndex
 */

/**
 * @typedef {object} PartitionTable
 * @property {Partition[]} partitions
 * @property {boolean} hasMd5
 * @property {boolean} md5Valid     - MD5 エントリがない場合は true 扱い
 * @property {Issue[]} issues
 */
```

`validatePartitionTable` が検出すべき問題:

- 領域の重複
- Flash サイズ超過
- app パーティションが 64KB 境界にない
- ラベル重複
- factory と ota_x の同時定義（警告）
- ota_x があるのに otadata パーティションがない（エラー）

Issue は `{ level: 'error'|'warning', code, params?, partitionIndex? }`。**表示文言ではなく `code` を持つ**（[16.8 i18n](#168-i18n)）。パースは Issue があっても中断せず、可能な限り結果を返す。

### 8.3 既知の type / subtype

```text
app  (0x00): factory(0x00), ota_0..ota_15(0x10-0x1F), test(0x20)
data (0x01): ota(0x00), phy(0x01), nvs(0x02), coredump(0x03), nvs_keys(0x04),
             efuse(0x05), undefined(0x06), esphttpd(0x80), fat(0x81),
             spiffs(0x82), littlefs(0x83)
```

未知の値は `unknown` として型名を保持しつつ生の数値も残し、**破棄しない**。

### 8.4 Partition 単位の操作

Partition を選択した状態で、以下の操作を提供する。

| 操作 | 内容 | 破壊的 |
| --- | --- | --- |
| Read Partition | `flash.read(p.offset, p.size)` して buffer に取り込む | いいえ |
| Export Partition | buffer を `<label>.bin` として保存 | いいえ |
| Analyze | `analyzeBinary(data, { partition: p })` | いいえ |
| Import Partition | ファイルを読み込み、その Partition の buffer として設定 | いいえ |
| Replace | buffer の内容を差し替える（メモリ上のみ） | いいえ |
| Write Partition | buffer を `flash.write(p.offset, data)` で書き戻す | **はい** |
| Erase Partition | `flash.eraseRegion(p.offset, p.size)` | **はい** |
| Verify | `flash.verify(p.offset, data)` | いいえ |

- Import / Replace 時にサイズが Partition を超える場合はエラーとし、**切り詰めない**。小さい場合は残りを `0xFF` で埋めることをユーザーに確認する。
- 破壊的操作は [17. 安全機構](#17-安全機構) の確認フローを必ず通す。

想定する典型フロー（NVS の例）:

```text
NVS Partition を選択
  → Read Partition
  → NVS Analyzer で解析
  → 値を変更
  → Binary 再構築（buildNvs）
  → Preview Diff
  → Backup Original
  → Write Partition
  → Verify
```

### 8.5 Partition Map（UI 表現）

- 縦方向にオフセット順で積む。高さはサイズの平方根に比例させる（線形だと NVS 等の小領域が視認できなくなるため）。実サイズは数値で併記する。
- パーティション間の未定義領域は「Unallocated」として明示する（`0x0` 〜 bootloader 前を含む）。
- 色分けは type / subtype 単位。encrypted フラグは斜線パターンで重畳。
- クリックで Inspector に該当パーティションを表示する。

---

## 9. Binary Analyzer とプラグイン

### 9.1 インターフェース

```js
/**
 * @typedef {object} DetectionResult
 * @property {number} confidence   - 0.0 - 1.0
 * @property {string} [reasonCode]
 */

/**
 * @typedef {object} BinaryRegion
 * @property {number} offset
 * @property {number} length
 * @property {string} label
 * @property {'header'|'data'|'entry'|'padding'|'unknown'} kind
 * @property {BinaryRegion[]} [children]
 */

/**
 * @typedef {object} AnalysisResult
 * @property {string} type
 * @property {number} confidence
 * @property {Record<string, unknown>} metadata
 * @property {BinaryRegion[]} regions
 * @property {Issue[]} issues
 * @property {unknown} [model]   - 形式固有の詳細モデル（PartitionTable, NvsStore 等）
 */

/**
 * @typedef {object} BinaryAnalyzer
 * @property {string} id
 * @property {string} name
 * @property {(data: Uint8Array, ctx: AnalyzeContext) => DetectionResult} detect
 * @property {(data: Uint8Array, ctx: AnalyzeContext) => AnalysisResult} analyze
 */
```

`AnalyzeContext` は `{ offset, partition?, flashSize? }`。パーティション内容として解析する場合、subtype をヒントとして渡せる。

### 9.2 登録と実行

```js
registerAnalyzer(analyzer);
unregisterAnalyzer(id);
listAnalyzers();

detectFormat(data, ctx)         // -> DetectionResult[]  confidence 降順
analyzeBinary(data, ctx)        // -> AnalysisResult     最高 confidence の analyzer を実行
analyzeBinaryAs(id, data, ctx)  // -> AnalysisResult     形式を明示指定
```

- confidence が全て 0.3 未満なら `raw` analyzer（Hex 表示のみ）を返す。
- 既定登録: `partition-table`, `esp-image`, `nvs`, `otadata`, `spiffs`(Phase 3), `raw`。

### 9.3 confidence の基準

| 値 | 意味 |
| --- | --- |
| 1.0 | magic とチェックサム／MD5 の両方が一致 |
| 0.8 | magic 一致、構造も整合 |
| 0.5 | magic は一致するが一部不整合（破損の可能性） |
| 0.3 | ヒューリスティックのみ（ヒントに基づく推定） |
| 0.0 | 不一致 |

### 9.4 暗号化の検出

Flash Encryption された領域は高エントロピーになる。エントロピーが 7.5 bits/byte を超え、既知の magic が見つからない場合、`type = 'encrypted?'`、`metadata.entropy` を付して返す。**「解析できた」ように見せてはならない。**

---

## 10. ESP Firmware Image

### 10.1 フォーマット

共通ヘッダ（8 バイト）:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Magic `0xE9` |
| 1 | 1 | Segment count |
| 2 | 1 | SPI mode |
| 3 | 1 | 上位 4bit = Flash size、下位 4bit = Flash frequency |
| 4 | 4 | Entry point |

拡張ヘッダ（ESP32 系、16 バイト）: WP pin, SPI pin drive(3), chip id(2), min chip rev, min/max chip rev full(2+2), reserved(4), hash appended(1)

各セグメント: load address(4) + length(4) + データ。
末尾: 16 バイト境界へパディング後、1 バイトのチェックサム（シード `0xEF` の XOR）。`hash appended = 1` ならさらに 32 バイトの SHA-256。

App Description（app パーティションの場合、第 1 セグメント先頭から `0x20`）:
magic `0xABCD5432`, version[32], project_name[32], time[16], date[16], idf_ver[32], app_elf_sha256[32]

### 10.2 API

```js
parseEspImage(data)  // -> EspImage
```

```js
/**
 * @typedef {object} EspImage
 * @property {number} entryPoint
 * @property {string} spiMode           - "qio"|"qout"|"dio"|"dout"|"unknown"
 * @property {string} flashSize
 * @property {string} flashFreq
 * @property {number|null} chipId
 * @property {string} chipName
 * @property {Segment[]} segments
 * @property {number} checksum
 * @property {boolean} checksumValid
 * @property {string|null} sha256
 * @property {boolean|null} sha256Valid
 * @property {AppDescription|null} app
 * @property {number} imageLength       - 実際に使用しているバイト数
 * @property {Issue[]} issues
 */
```

`Segment` は `{ index, loadAddress, length, fileOffset, memoryRegion }`。`memoryRegion` はチップの `memoryMap` から `"IRAM"|"DRAM"|"IROM"|"DROM"|"RTC"|"unknown"` を判定する。

UI では、App パーティションを解析した際に「イメージ `imageLength` バイト / パーティション N バイト / 空き M バイト（X%）」を表示する。

---

## 11. NVS

### 11.1 フォーマット

NVS パーティションは 4096 バイトのページの連続。

**ページ（4096 バイト）:**

| Offset | Size | 内容 |
| --- | --- | --- |
| 0 | 32 | ページヘッダ |
| 32 | 32 | エントリ状態ビットマップ（2bit × 126 エントリ） |
| 64 | 4032 | エントリ領域（32 バイト × 126） |

ページヘッダ: state(4), seqNo(4), version(1), unused(19), crc32(4)

ページ state:

| 値 | 意味 |
| --- | --- |
| `0xFFFFFFFF` | UNINITIALIZED |
| `0xFFFFFFFE` | ACTIVE |
| `0xFFFFFFFC` | FULL |
| `0xFFFFFFF8` | FREEING |
| `0xFFFFFFF0` | CORRUPT |

version: `0xFF` = v1、`0xFE` = v2（v2 が現行。v1 は読み取りのみ対応）

エントリ状態（ビットマップ、LSB から 2bit ずつ）: `0b11` = EMPTY、`0b10` = WRITTEN、`0b00` = ERASED

**エントリ（32 バイト）:**

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Namespace index（0 = namespace 定義エントリ自身） |
| 1 | 1 | Type |
| 2 | 1 | Span（このエントリが占める 32 バイト単位の数） |
| 3 | 1 | Chunk index（blob 以外は `0xFF`） |
| 4 | 4 | CRC32 |
| 8 | 16 | Key（NUL 終端 ASCII、最大 15 文字） |
| 24 | 8 | データ（プリミティブ）／可変長ヘッダ |

可変長（String / Blob）の場合、offset 24 以降は size(2), reserved(2), crc32 of data(4)。データ本体は続く span-1 個のエントリ領域に格納される。

**Type:**

| 値 | 型 | | 値 | 型 |
| --- | --- | --- | --- | --- |
| `0x01` | U8 | | `0x08` | U64 |
| `0x11` | I8 | | `0x18` | I64 |
| `0x02` | U16 | | `0x21` | STR |
| `0x12` | I16 | | `0x41` | BLOB (v1) |
| `0x04` | U32 | | `0x42` | BLOB_DATA |
| `0x14` | I32 | | `0x48` | BLOB_IDX |

Namespace は `namespaceIndex = 0` のエントリで定義され、key が namespace 名、U8 データが割り当てインデックスとなる。

### 11.2 パース

```js
parseNvs(data, { strict = false })  // -> NvsStore
```

- ページを seqNo 順に走査し、WRITTEN 状態のエントリのみを採用する。
- 同一 (namespace, key) が複数ページに存在する場合、**seqNo が大きいページのものを採用**する（NVS の更新セマンティクス）。
- BLOB は BLOB_IDX が示す chunk 数ぶんの BLOB_DATA を結合する。欠損時は Issue を立て、部分データを `partial: true` として保持する。
- CRC 不一致のエントリは Issue を立て、`crcValid: false` を付けて**保持する**（破棄しない）。`strict: true` の場合のみ例外を投げる。
- ERASED エントリは既定では返さないが、`store.erasedEntries` から参照できる（フォレンジック用途）。

### 11.3 編集モデル

```js
/**
 * @typedef {object} NvsEntry
 * @property {string} namespace
 * @property {string} key
 * @property {string} type          - "U8" | "STR" | "BLOB" | ...
 * @property {number|bigint|string|Uint8Array} value
 * @property {Uint8Array} raw
 * @property {number} pageIndex
 * @property {number} entryIndex
 * @property {number} span
 * @property {boolean} crcValid
 */
```

```js
const store = parseNvs(binary);

store.namespaces              // -> string[]
store.entries                 // -> NvsEntry[]（読み取り専用スナップショット）
store.list(namespace)         // -> NvsEntry[]
store.get(namespace, key)     // -> NvsEntry | undefined
store.set(namespace, key, value, type?)
store.delete(namespace, key)
store.rename(namespace, key, newKey)
store.addNamespace(name)
store.deleteNamespace(name)   // 配下エントリも削除

store.isDirty                 // -> boolean
store.changes()               // -> NvsChange[]  Original に対する差分
store.reset()                 // Original に戻す
store.original                // -> NvsStore（変更不可のスナップショット）

buildNvs(store, { size, version = 2 })  // -> Uint8Array
```

- `store` は **Original を破壊しない**。`parseNvs` の結果は内部に不変スナップショットを保持し、変更はオーバーレイとして積む。
- `set` の型推論: `number` → U32（負なら I32）、`bigint` → U64/I64、`string` → STR、`Uint8Array` → BLOB。曖昧さを避けるため、UI では常に型を明示指定させる。

### 11.4 ビルド

`buildNvs(store, { size })` の規則:

- `size` はパーティションサイズ（4096 の倍数、最小 3 ページ = 12288 バイト）。NVS は最低 1 ページを GC 用に空けておく必要がある。
- エントリを namespace 定義 → 各エントリの順で ACTIVE ページへ詰める。ページが埋まったら FULL にして次ページへ。
- 未使用ページは UNINITIALIZED（全 `0xFF`）とする。
- seqNo は 0 から連番。ページ CRC32 と各エントリ CRC32 を再計算する。
- 収まらない場合は `NvsCapacityError` を投げる。**切り詰めてはならない。**
- **ビルド結果を `parseNvs` で読み直して元の store と一致することを検証する self-check を既定で有効にする**（`{ selfCheck: false }` で無効化可能）。

### 11.5 Diff

```js
diffNvs(before, after)  // -> NvsChange[]
```

```js
/**
 * @typedef {object} NvsChange
 * @property {'added'|'modified'|'deleted'|'renamed'} kind
 * @property {string} namespace
 * @property {string} key
 * @property {unknown} [before]
 * @property {unknown} [after]
 * @property {string} [beforeType]
 * @property {string} [afterType]
 */
```

型のみ変わった場合も `modified` とし、`beforeType !== afterType` で表現する。

---

## 12. Filesystem

Phase 3 で **SPIFFS の読み取り専用解析**を実装する。

```js
parseSpiffs(data, { pageSize = 256, blockSize = 4096, objNameLen = 32 })  // -> FsImage
```

```js
/**
 * @typedef {object} FsFile
 * @property {string} path
 * @property {number} size
 * @property {() => Uint8Array} read
 * @property {number[]} pageIndices
 * @property {boolean} complete
 */
/**
 * @typedef {object} FsImage
 * @property {string} type       - "spiffs" | "littlefs" | "fat"
 * @property {FsFile[]} files
 * @property {object} geometry
 * @property {Issue[]} issues
 */
```

SPIFFS はイメージだけからページサイズ・ブロックサイズを確定できない。既定値で解析を試み、失敗したら候補（pageSize 256/512、blockSize 4096/8192）を総当たりし、最もファイル数が多く整合する組み合わせを採用する。採用したジオメトリは UI に表示し、ユーザーが手動変更できるようにする。

Phase 4 で LittleFS 解析、SPIFFS 再構築、`Extract / Replace / Add / Delete / Rebuild` を扱う。**Rebuild は「元イメージと同一ジオメトリでの再生成」に限定**し、任意パラメータでの新規生成は行わない。

---

## 13. Binary ユーティリティ

### 13.1 Diff

```js
diffBinary(a, b, { minGap = 16 })       // -> BinaryDiffChunk[]
diffBinaryStream(a, b, opts)            // -> AsyncGenerator<BinaryDiffChunk>
```

- バイト単位で比較し、差分が連続する領域を 1 チャンクにまとめる。
- 一致が `minGap` バイト未満しか続かない場合は同一チャンクに含める（細切れ防止）。
- 長さが異なる場合、超過分は末尾チャンクとして `kind: 'added'|'removed'` を付す。

```js
/**
 * @typedef {object} BinaryDiffChunk
 * @property {number} offset
 * @property {Uint8Array} before
 * @property {Uint8Array} after
 * @property {'modified'|'added'|'removed'} kind
 */
```

16MB 同士の比較を UI スレッドで同期実行すると固まるため、`diffBinaryStream()` は 1MB ごとに制御を返す。UI は必ずこちらを使う。

### 13.2 検索

```js
searchBytes(data, pattern, { from = 0, limit = 1000 })                   // -> number[]
searchText(data, text, { encoding = 'utf-8', caseInsensitive = false })  // -> number[]
parseHexPattern("AA 50 ?? 02")  // -> {bytes: Uint8Array, mask: Uint8Array}
```

`??` によるワイルドカードを許可する。

### 13.3 ハッシュ

`crc32(data)`、`md5(data)` を自前実装する（`crypto.subtle` に MD5 はなく、SPI_FLASH_MD5 との照合に必要なため）。SHA-256 は `crypto.subtle.digest` を使い、非対応環境ではフォールバックせず `null` を返す。

---

## 14. エラーモデル

```text
EspFlashError (base)
├── TransportError
│   ├── TransportTimeoutError
│   └── TransportClosedError
├── ProtocolError
│   ├── SyncFailedError
│   ├── CommandFailedError      (status, errorCode)
│   └── UnknownChipError
├── DeviceError
│   ├── StubLoadError
│   ├── SecureDownloadModeError
│   └── UnsupportedOperationError   (code: 'READ_REQUIRES_STUB' 等)
├── FormatError
│   ├── InvalidMagicError
│   ├── ChecksumError
│   └── TruncatedDataError
├── AlignmentError
└── NvsCapacityError
```

すべて `code`（`'SYNC_FAILED'` 等の安定文字列）と `details` オブジェクトを持つ。**UI はメッセージ本文ではなく `code` で分岐し、表示文言は `code` から翻訳する**（[16.8](#168-i18n)）。`message` は英語の開発者向け文字列とする。

**方針:** 解析系（`format/`）は例外を投げるより `issues` に積んで部分結果を返すことを優先する。例外を投げるのは、データが対象形式ですらない場合と `strict: true` 指定時のみ。デバイス操作系は例外を投げる。

---

## 15. 進捗とキャンセル

長時間処理（read / write / dump / diff）は共通のシグネチャを持つ:

```js
{ onProgress?: (p: Progress) => void, signal?: AbortSignal }

/**
 * @typedef {object} Progress
 * @property {string} phase    - "erasing" | "writing" | "reading" | "verifying" | "analyzing"
 * @property {number} done
 * @property {number} total
 * @property {number} [bytesPerSecond]
 */
```

`phase` は翻訳キーとして使う安定 ID である。`onProgress` の呼び出し頻度はライブラリ側で最大 20Hz にスロットルする。

---

## 16. Web アプリケーション

### 16.1 基本方針

- **フレームワークなし、ビルドなし。** `web/index.html` が `./app.js` を `type="module"` で読み込む。
- UI 部品は Custom Elements（`esp-*`）として実装する。Shadow DOM を使用し（スタイル衝突の回避）、CSS 変数でテーマを外から注入する。
- 状態は単一の store に集約し、コンポーネントは購読して再描画する。**コンポーネントが直接 Core API を呼んではならない。** すべて `actions.js` を経由する。
- Core への参照は `web/esp-flashjs.js` に集約する（[4.4](#44-モジュール解決とパス)）。

### 16.2 store

```js
// web/store.js
export const store = createStore(initialState);
store.getState()
store.setState(patch)          // 浅いマージ、変更があれば通知
store.subscribe(selector, fn)  // selector の戻り値が変わったときだけ fn を呼ぶ
```

state の概形:

```js
{
  device: { status: 'disconnected'|'connecting'|'connected', info: DeviceInfo|null, usingStub: false },
  flash:  { size: null, dump: null },
  partitions: { table: PartitionTable|null, source: 'device'|'file'|null },
  selection: { kind: 'partition'|'file'|'region'|null, id: null },
  buffers: Map<string, {name, data: Uint8Array, source, analysis: AnalysisResult|null}>,
  nvs: { storeId: null, editing: false },
  inspector: { tab: 'info'|'hex'|'analyze'|'edit'|'diff' },
  busy: { active: false, phase: '', done: 0, total: 0, cancel: null },
  locale: 'ja',
  log: LogEntry[],
}
```

`Uint8Array` は state に置くが、**変更通知は参照比較で行う**（ディープコピーしない）。最大 16MB のバッファを扱うため、コピーは明示的な操作のみとする。

### 16.3 画面構成

```text
┌───────────────────────────────────────────────────┐
│ ESP FlashJS                    [Device: ESP32-S3] │
├───────────────────────────────────────────────────┤
│ Device                                            │
│ [Connect] [Disconnect]  Chip / Rev / MAC / Flash  │
├─────────────────┬─────────────────────────────────┤
│ Flash Map       │ Inspector                       │
│                 │ ┌─────────────────────────────┐ │
│  Bootloader     │ │ Info │ Hex │ Analyze │ Edit │ │
│  Partition Tbl  │ ├─────────────────────────────┤ │
│  NVS            │ │                             │ │
│  OTA Data       │ │                             │ │
│  App0           │ │                             │ │
│  App1           │ │                             │ │
│  SPIFFS         │ │                             │ │
│  (Unallocated)  │ │                             │ │
│                 │ └─────────────────────────────┘ │
├─────────────────┴─────────────────────────────────┤
│ Log                                        [Clear]│
└───────────────────────────────────────────────────┘
```

- 左ペインには Flash Map のほか、ファイルから読み込んだバッファの一覧も表示する（「Files」セクション）。デバイス由来とファイル由来を同じ Inspector で扱う。
- 画面幅 900px 未満では 1 カラムに折り返し、Flash Map と Inspector をタブ切り替えにする。

### 16.4 Inspector タブ

| タブ | 内容 |
| --- | --- |
| Info | 選択対象のメタ情報（offset / size / type / subtype / label / end address / encrypted） |
| Hex | Hex Viewer。解析済み region をハイライト |
| Analyze | `analyzeBinary` の結果。形式ごとの専用ビュー（Partition テーブル、Image セグメント一覧、NVS ツリー、SPIFFS ファイルツリー）。形式を手動で切り替えるセレクタを付ける |
| Edit | NVS Editor など、形式固有の編集 UI |
| Diff | 2 つのバッファを選択して比較 |

### 16.5 Hex Viewer（`esp-hex-viewer`）

- 最大 16MB（= 1,048,576 行）を扱うため **仮想スクロール必須**。DOM に存在する行はビューポート + 前後バッファのみ。
- 1 行 16 バイト。表示は `オフセット(8桁) | Hex 16バイト(8バイト目後に区切り) | ASCII`。
- 機能: 選択（バイト範囲）、Jump to Address（`0x` 付き / 10 進の両方を受理）、Search Hex（ワイルドカード対応）、Search Text、ハイライト（`BinaryRegion[]` を背景色で塗る）。
- 選択範囲について、ステータス行に「offset、length、u8/u16/u32/i32/float の解釈値、ASCII/UTF-8 解釈」を表示する。
- 属性ではなく**プロパティ**で値を渡す: `.data`（Uint8Array）、`.baseAddress`、`.regions`。

### 16.6 UI 用語（統一）

「Upload」「Download」は方向が曖昧なため**使用禁止**。

| 文脈 | 使う語 |
| --- | --- |
| デバイス → PC | Read from Device |
| PC → デバイス | Write to Device |
| ファイル → アプリ | Import Binary |
| アプリ → ファイル | Export Binary |
| Partition | Read Partition / Write Partition / Import Partition / Export Partition |
| 全体 | Flash Dump（読み出し） / Flash Erase |

この原則は各言語の訳語にも適用する。翻訳時に方向が曖昧にならないよう、`locales/` のキー名自体を `action.readFromDevice` のように方向を含む形にする。

破壊的操作のボタンは危険色（赤系）とし、非破壊操作（Read / Analyze / Export）とは視覚的に分離したグループに置く。

### 16.7 ログ

すべてのデバイス操作と解析実行をログに残す。

```js
{ time, level: 'info'|'warn'|'error', code, params, detail? }
```

表示時に `code` を翻訳する。Log は Export（テキスト）でき、バグ報告に添付できるようチップ情報とライブラリバージョンをヘッダに含める。**Export したログは英語で出力する**（報告先で読めるように）。

### 16.8 i18n

**要件:** ブラウザの言語設定から自動判定し、対応言語がなければ英語にフォールバックする。日本語・英語・中国語を最初から用意し、他の主要言語を後から足しやすい構造にする。

**言語の初期セット:**

```text
en        English      （フォールバック先。必ず全キーが揃っている必要がある）
ja        日本語
zh-Hans   简体中文
zh-Hant   繁體中文
```

中国語は簡体・繁体を別ロケールとして扱う。単なる字体変換では語彙が合わないため。

**判定ロジック:**

1. `localStorage` に保存されたユーザーの明示選択があればそれを使う
2. なければ `navigator.languages` を先頭から走査し、以下の順で照合する
   - 完全一致（`zh-Hant`）
   - スクリプト付き一致（`zh-TW` → `zh-Hant`、`zh-CN` → `zh-Hans`）
   - 言語のみ一致（`ja-JP` → `ja`）
3. どれにも当たらなければ `en`

**辞書の形式:** `web/locales/<locale>.json` にフラットな key-value で置く。ネストしない（キーの全文検索を容易にするため）。

```json
{
  "action.readFromDevice": "Read from Device",
  "partition.label": "Label",
  "error.SYNC_FAILED": "Could not synchronize with the device.",
  "warn.partitionOverlap": "Partition \"{label}\" overlaps another partition."
}
```

**API:**

```js
// web/i18n.js
await initI18n();          // 言語判定 → 該当ロケールと en を fetch
t('action.readFromDevice')            // -> string
t('warn.partitionOverlap', { label }) // -> 補間済み string
setLocale('zh-Hans')       // 明示切り替え。localStorage に保存し、再描画を促す
availableLocales()         // -> [{code, nativeName}]
```

**規約:**

- `en.json` が唯一の正典。他ロケールに欠けているキーは英語にフォールバックし、コンソールに警告を出す。
- キーが存在しない場合はキー文字列そのものを返す（画面が空白にならないように）。
- **`src/` にはユーザー向け文言を一切置かない。** ライブラリが返すのは `code` と `params` だけで、翻訳は `web/` の責務である。これにより、ライブラリを組み込む第三者アプリが自前の文言体系を使える。
- 翻訳の追加は `locales/xx.json` を 1 つ足し、`availableLocales()` の一覧に加えるだけで完了する。コードの変更を伴わせない。
- 言語切り替えは即時反映する（リロードを要求しない）。
- `<html lang>` を選択ロケールに合わせて更新する。
- 数値・日時の整形は `Intl.NumberFormat` / `Intl.DateTimeFormat` に任せる。ただし**バイト数とアドレスは整形しない**（`0x00009000` や `4096` は言語に依らない技術的表記である）。

**将来追加したい言語:** ko、de、fr、es、pt-BR、ru。コミュニティからの PR で受け入れられるよう、CONTRIBUTING に翻訳手順を書く。

---

## 17. 安全機構

Flash 書き込みはデバイスを起動不能にしうるため、以下を必須とする。

### 17.1 危険領域の定義

以下に該当する書き込み・消去は「危険操作」とする:

- Bootloader 領域（ESP32 は `0x1000`〜、S3/C3 等は `0x0`〜、いずれも Partition Table 手前まで）
- Partition Table 領域（`0x8000` + `0xC00`）
- otadata パーティション
- app パーティション（type = 0）
- `encrypted` フラグが立つパーティション
- efuse / nvs_keys パーティション

### 17.2 確認フロー

危険操作の実行前に確認ダイアログを表示する。ダイアログは以下を含む:

1. 対象領域（offset / size / 該当パーティション名）
2. 何が起きうるか（「デバイスが起動しなくなる可能性があります」）
3. **バックアップ済みかどうかの表示。** 未バックアップなら「Backup first」を主ボタンとして提示する
4. 確認テキストの入力（パーティションラベル、または `WRITE` の入力）。チェックボックスでは不十分とする

暗号化パーティションへの平文書き込みは、確認に加えて**二重の警告**を出す。

### 17.3 Backup First

推奨フローを UI が誘導する:

```text
Read Original → Store Backup → Modify → Preview Diff → Write → Verify
```

- Write ダイアログには常に「Backup Original」チェックボックスを置き、**既定でオン**にする。オンの場合、書き込み前に対象領域を読み出して `buffers` に保存し、同時に自動で `.bin` として Export する。
- バックアップに失敗した場合、書き込みは実行しない。
- Preview Diff は、書き込み対象領域の現在値と新しい値の差分を表示する。

### 17.4 Verify

書き込み後は既定で `verify` を実行する（MD5 比較）。不一致の場合は明確なエラーとしてログとダイアログに出す。

---

## 18. 未対応領域の扱い

- 解析できない領域・パーティションも一覧から**消さない**。`Unknown / Raw` として表示する。
- Raw に対しても Hex View / Export / Replace / Diff は利用可能とする。
- Partition Table に定義のない Flash 領域は `Unallocated` として Flash Map に表示し、Read / Export を可能にする。

---

## 19. 暗号化領域

- Flash Encryption 等で内容を直接解析できない場合、解析できたかのように扱わない。
- 状態を 3 値で明示する。
  - `Encrypted` — パーティションの `encrypted` フラグが立っている、または eFuse から Flash Encryption 有効を確認できた
  - `Possibly Encrypted` — エントロピーが高く既知 magic が見つからない（[9.4](#94-暗号化の検出)）
  - `Unknown` — 判定材料がない
- **暗号化解除は行わない。実装もしない。**

---

## 20. テスト

### 20.1 方針

実機に依存せず fixture ベースで検証する。テストランナーは Node.js 組み込みの `node:test` を使う（依存追加なし、`node --test` で実行）。ブラウザ固有部分は手動テストとする。

### 20.2 fixture

**fixture はコードで生成する。** バイナリをコミットするより、その fixture が何を意図しているかが読めることを優先する。`test/helpers.js` にビルダーを置く。

| 関数 | 生成するもの |
| --- | --- |
| `singleAppPartitions()` / `otaPartitions()` | パーティション構成（4MB 単一アプリ / デュアル OTA） |
| `partitionTableBytes(partitions?)` | パーティションテーブルのバイト列 |
| `espImageBytes(options)` | ファームウェアイメージ。`corruptChecksum` / `appendHash` / `appDesc` を指定可 |
| `otaDataBytes(sequences)` | otadata。`null` でそのセクタを未書き込みにする |
| `flashImage(options)` | bootloader + テーブル + アプリを配置した Flash 全体像 |
| `pathologicalInputs()` | 空 / 1 バイト / 全 0x00 / 全 0xFF / ランダム |

実機から採取したバイナリを追加する場合のみ `test/fixtures/` にコミットし、**MAC アドレス・Wi-Fi 認証情報・証明書・鍵を必ず匿名化する。**

### 20.3 必須テストケース

| 対象 | ケース |
| --- | --- |
| 全パーサ | 正常データ / 破損データ / 境界値 / 空データ（長さ 0） / 未知形式 |
| SLIP | エスケープの往復、フレーム分割受信、不正フレーム |
| Protocol | MockTransport 経由での SYNC / チップ検出 / read / write / タイムアウト / リトライ |
| Partition | parse → build → parse のラウンドトリップでバイト一致 |
| NVS | parse → build → parse で全エントリ一致。編集後のラウンドトリップ。容量超過で例外 |
| Image | checksum / SHA-256 検証 |
| Diff | 差分なし / 全差分 / 長さ違い / minGap の境界 |
| Flash | 範囲外・非アライン入力で例外が飛ぶこと |
| i18n | `en.json` に対する各ロケールのキー欠落検出、`navigator.languages` の各パターンでの判定 |

**ラウンドトリップテストは NVS と Partition Table で必須とする。** 書き戻し機能の正しさはここでしか担保できない。

### 20.4 CI

GitHub Actions で以下を実行する。ローカルでは `npm run check` が同じ 4 つをまとめて走らせる。

| 検査 | コマンド |
| --- | --- |
| ユニットテスト | `npm test`（`node --test`） |
| JSDoc 型検査 | `npm run typecheck`（`tsc --noEmit`） |
| レイヤ違反・import の健全性 | `npm run lint:layers` |
| ロケールのキー欠落と placeholder 不整合 | `npm run lint:locales` |

これに続けて `npm run build` と `npm run build:site` を実行し、ビルドが通ることまで確認する。

ワークフローの詳細と、初回に必要なリポジトリ設定は [ci.ja.md](./ci.ja.md) を参照。テストの書き方と実機での手動テスト項目は [development.ja.md](./development.ja.md) にある。

---

## 21. 公開・配布

詳細は [publishing.ja.md](./publishing.ja.md)。要点のみ:

| 経路 | 内容 |
| --- | --- |
| GitHub Pages | GitHub Actions が `scripts/build-site.js` で `site/` を組み立ててデプロイ |
| npm | 単一パッケージ `esp-flashjs`。`dist` に full と core の 2 系統。**公開は手元のマシンから**（トークンをリポジトリに置かない） |
| CDN | jsDelivr から `dist/esp-flashjs.min.js` を直接読み込み可能 |

---

## 22. ロードマップ

### Phase 1 — MVP（実装済み）

- [x] Transport（WebSerial / Mock）
- [x] Protocol（SLIP / コマンド / チップ検出 / stub loader）
- [x] Device Info
- [x] Flash read / write / erase / verify / dump
- [x] Partition Table 解析・検証・生成
- [x] ESP Firmware Image 解析（Phase 3 から前倒し。Analyzer の実証に必要だったため）
- [x] otadata 解析（同上）
- [x] Binary Diff / 検索（同上）
- [x] Binary Import / Export
- [x] Hex Viewer（仮想スクロール・検索・ハイライト）
- [x] Flash Map
- [x] Web アプリの骨格（store / Inspector / Log / 安全機構 / i18n）
- [x] ビルドスクリプトと GitHub Pages 用の site 組み立て
- [x] CI（テスト / 型検査 / レイヤ検証 / ロケール検証）
- [x] npm 公開（[v0.1.0](https://www.npmjs.com/package/esp-flashjs)、2026-08-16）
- [ ] 実機での検証

### Phase 2 — NVS

- [ ] NVS parse
- [ ] Namespace / Key ツリー表示
- [ ] Value 編集
- [ ] NVS build（self-check 付き）
- [ ] Partition への書き戻し
- [ ] NVS Diff
- [ ] Backup First フローの完成

### Phase 3 — 解析の拡充

- [ ] ESP Firmware Image 解析
- [ ] otadata 解析
- [ ] Binary Diff
- [ ] SPIFFS 読み取り解析・ファイル抽出
- [ ] 暗号化検出

### Phase 4 — 拡張

- [ ] SPIFFS 再構築
- [ ] LittleFS
- [ ] Analyzer Plugin API の公開・ドキュメント化
- [ ] NodeSerialTransport / WebUSBTransport
- [ ] ESP8266 サポートの再検討
- [ ] パッケージ分割の判断（`@esp-flashjs/*`）

---

## 23. 未決事項

| # | 事項 | 備考 |
| --- | --- | --- |
| 1 | **実機検証** | 現状すべて未検証。特に reset シーケンスと READ_FLASH のフロー制御は、MockTransport では本質的に検証できない。手元のボードを教えてもらい README の対応表に反映する |
| 2 | パッケージ分割の是非と時期 | Phase 4 で判断。それまではディレクトリ境界で規律を保つ |
| 3 | LittleFS の実装方針 | 自前実装か、既存 JS 実装の移植か |
| 4 | 追加言語 | ko / de / fr / es / pt-BR / ru。翻訳は JSON を 1 つ足すだけで済む |

**解決済み:**

- ~~stub JSON の同梱範囲~~ → 全 10 チップ分を同梱する。合計 132KB で、しかもバンドルには埋め込まず実行時 fetch なので、解析しか使わない利用者への負担はゼロ。
- ~~UI の言語~~ → `navigator.languages` から自動判定し、en / ja / zh-Hans / zh-Hant を同梱。
- ~~トップページの内容~~ → Web アプリを直接トップにする。上部に説明とリンクを常設した。
