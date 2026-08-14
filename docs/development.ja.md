# 開発ガイド

ESP FlashJS の開発手順・テストの書き方・ローカル検証の方法。

関連文書: [仕様書](./spec.ja.md) / [CI](./ci.ja.md) / [リリース手順](./release.ja.md) / [配布方法](./publishing.ja.md)

---

## 1. セットアップ

必要なもの: **Node.js 20 以上**（開発は 22 で行っている）。それ以外はありません。

```sh
git clone https://github.com/tanakamasayuki/esp-flashjs.git
cd esp-flashjs
npm install
```

`npm install` が入れるのは devDependencies の 3 つだけです。

| パッケージ | 用途 |
| --- | --- |
| `esbuild` | `dist/` のバンドルと minify |
| `typescript` | JSDoc の型検査と `.d.ts` 生成。**トランスパイルには使わない** |
| `@types/w3c-web-serial` | Web Serial の型定義 |

**実行時依存はゼロです。** `dependencies` に何かを足す提案は、まずそれを避ける方法がないか検討してください。

---

## 2. ローカルで動かす

```sh
npm run dev
```

リポジトリのルートを `http://localhost:8080` で配信します。

| URL | 内容 |
| --- | --- |
| `http://localhost:8080/web/` | Web アプリ |
| `http://localhost:8080/examples/` | サンプル一覧 |

ビルドは不要です。`src/` を編集してリロードすれば、そのまま反映されます。ブラウザがネイティブ ESM を解決しているだけなので、間に何も挟まっていません。

### 2.1 なぜ `file://` では動かないか

ESM の `import` と `fetch` が CORS で失敗するためです。必ず HTTP サーバ経由で開いてください。

### 2.2 Web Serial とセキュアコンテキスト

Web Serial は**セキュアコンテキストでのみ動作**します。

| URL | 動作 |
| --- | --- |
| `http://localhost:8080/web/` | ○ localhost はセキュアコンテキスト扱い |
| `http://192.168.1.5:8080/web/` | **×** LAN の IP は対象外。接続ボタンが無効になる |
| `https://…` | ○ |

別マシンの実機で試したい場合は、そのマシンで `npm run dev` を動かすか、Pages にデプロイしたものを使ってください。

### 2.3 開発サーバの実装

`scripts/serve.js` は `node:http` だけで書いた 80 行程度のものです。依存ゼロを保つために自前で持っています。ポートやルートを変えたい場合:

```sh
node scripts/serve.js --port 3000 --root .
```

---

## 3. テスト

### 3.1 走らせる

```sh
npm test                  # 全部
npm run test:watch        # ファイル変更で再実行
npm run test:coverage     # カバレッジ付き
```

ランナーは Node.js 組み込みの `node:test` です。依存を増やさずに済み、`node --test` で直接叩けます。

```sh
# 1 ファイルだけ
node --test test/protocol.test.js

# テスト名で絞る（部分一致・正規表現）
node --test --test-name-pattern="partition table" "test/*.test.js"

# 出力を短く
node --test --test-reporter=dot "test/*.test.js"
```

### 3.2 テストファイルの構成

```text
test/
├── helpers.js          # fixture ビルダー。テストではない
├── binary.test.js      # util/ と binary/
├── format.test.js      # format/（partition / image / otadata / registry）
├── protocol.test.js    # protocol/ と device/。MockTransport 経由の統合テスト
└── web.test.js         # web/ のうち DOM 非依存の部分（store / i18n）
```

現状 **113 件・行カバレッジ 93.6%** です。

### 3.3 fixture はコードで作る

`test/helpers.js` に生成関数を置いてあります。バイナリをコミットするより、何を意図した fixture なのかが読めることを優先しています。

```js
import { singleAppPartitions, otaPartitions, partitionTableBytes,
         espImageBytes, otaDataBytes, flashImage, pathologicalInputs } from './helpers.js';

// 標準的な 4MB 単一アプリ構成のパーティションテーブル
const bytes = partitionTableBytes();

// OTA 構成
const ota = partitionTableBytes(otaPartitions());

// チェックサムを壊したファームウェアイメージ
const broken = espImageBytes({ corruptChecksum: true });

// bootloader + テーブル + アプリを配置した 4MB の Flash 全体像
const flash = flashImage({ size: 1024 * 1024 });
```

実機由来のバイナリを追加する場合は、**MAC アドレス・Wi-Fi 認証情報・証明書・鍵を必ず匿名化**してください。一度コミットすると git 履歴から消すのは面倒です。

### 3.4 MockTransport で実機なしにプロトコルを試す

`src/testing/mock-transport.js` は、`Uint8Array` を Flash に見立てて**本物の SLIP プロトコルで応答する仮想デバイス**です。プロトコル層と device 層を CI で検証できるのはこれのおかげです。

```js
import { MockTransport } from '../src/testing/mock-transport.js';
import { EspLoader } from '../src/protocol/loader.js';
import { EspFlash } from '../src/device/esp-flash.js';

const transport = new MockTransport({
  chip: 'ESP32-C6',                 // チップ名
  flashSize: 4 * 1024 * 1024,       // または flash: Uint8Array で中身ごと渡す
  secureDownloadMode: false,        // true で SDM を再現
  allowStub: true,                  // false で stub ロード失敗を再現
  supportsSecurityInfo: undefined,  // 省略時はチップ定義に従う
});

const loader = new EspLoader(transport);
await loader.connect();
await loader.loadStub();

const flash = new EspFlash(loader);
await flash.getInfo();

// 検証用
transport.flash          // シミュレートされた Flash の中身
transport.commandLog     // 受け取ったオペコードの列 ['0x08', '0x14', ...]
transport.poke(addr, b)  // プロトコルを介さず直接書き込む
```

再現できるシナリオ:

| 設定 | 再現する状況 |
| --- | --- |
| `chip: 'ESP32'` | `GET_SECURITY_INFO` 非対応。magic レジスタでの検出経路を通る |
| `allowStub: false` | stub ロード失敗 → ROM モードへのフォールバック |
| `secureDownloadMode: true` | レジスタ読み出しも stub ロードも拒否される |
| `registers.set(0x40001000, 0xdead)` | 未知チップ |

**MockTransport で検証できないこと:** reset シーケンスのタイミング、実際の UART のボーレート変更、`READ_FLASH` のフロー制御（mock はペーシングせず一気に返す）。ここは実機でしか確かめられません。

### 3.5 テストを書くときの方針

**パーサには必ず病的入力を通す。** `pathologicalInputs()` が空・1バイト・全0x00・全0xFF・ランダムを返します。パーサは例外を投げるか結果を返すかのどちらかで、無限ループやクラッシュはしないこと。

**parse → build → parse のラウンドトリップを検証する。** 書き戻し機能の正しさはここでしか担保できません。Partition Table では**バイト単位の一致**まで見ています。

```js
const original = partitionTableBytes(otaPartitions());
const rebuilt = buildPartitionTable(parsePartitionTable(original));
assert.deepEqual([...rebuilt], [...original]);
```

**「壊れたデータで例外を投げない」ことをテストする。** 解析系は `issues` に積んで部分結果を返す設計なので、それが守られているかを確認します。

**境界を切り詰めないことをテストする。** 範囲外・非アラインは例外であって、丸めではありません。

```js
await assert.rejects(() => flash.write(0x1001, data), AlignmentError);
await assert.rejects(() => flash.read(0xfff000, 0x2000), OutOfRangeError);
```

**アサーションの前提を疑う。** 実装中、テスト側の想定が間違っていた例が複数ありました（`nvs` は `0x9000`〜`0xf000` なので `0xefff` は範囲内、など）。失敗したときはまず実装を疑い、次にテストを疑ってください。

---

## 4. 型検査

```sh
npm run typecheck
```

ソースは素の JavaScript です。TypeScript は**リンタとして**しか使っていません。`.js` のままで、構文も変換しません。

全ファイルの先頭に `// @ts-check` を置き、型は JSDoc で書きます。

```js
/**
 * @param {Uint8Array} data
 * @param {object} [options]
 * @param {number} [options.offset]
 * @returns {PartitionTable}
 */
export function parsePartitionTable(data, { offset = 0 } = {}) { … }
```

検査対象は `src/**/*.js` と `web/**/*.js` です（`tsconfig.json`）。

### 4.1 これが実際に捕まえたもの

型検査を入れる判断は、以下で元が取れています。

- **`setSignals` の引数名。** Web Serial は `dtr`/`rts` ではなく `dataTerminalReady`/`requestToSend` を取ります。気づかなければブートローダ突入が黙って効きませんでした。
- **Issue の `warning` とログの `warn` の不一致。** ログの CSS クラスが当たらず、警告が通常表示になっていました。
- **`null` チェック漏れ。** `flashSize` は `number|null` です。

バイナリ処理は、この種のミスが例外にならず**静かに壊れたバイナリを書き込む**形で表面化します。デバイスを起動不能にしうる用途なので、検査の価値は高いです。

### 4.2 typedef を公開 API に出すとき

`export *` は JSDoc の typedef を**運びません**。新しい型を公開したい場合は、`src/core.js` か `src/index.js` の typedef ブロックに明示的にエイリアスを足してください。

```js
/**
 * @typedef {import('./format/partition.js').Partition} Partition
 */
```

コメントブロックは `/**` で始めること。`/*` では JSDoc として認識されません（実際にこれで小一時間溶かしました）。

---

## 5. レイヤ検証

```sh
npm run lint:layers
```

`scripts/check-layers.js` が以下を静的に検査します。

**依存方向。** 下から上への import を禁止します。

| ディレクトリ | import してよい先 |
| --- | --- |
| `src/util/` | なし |
| `src/binary/` | `util/` |
| `src/format/` | `binary/`, `util/` |
| `src/transport/` | `util/` |
| `src/protocol/` | `transport/`, `binary/`, `util/` |
| `src/device/` | `protocol/`, `binary/`, `format/`, `util/` |
| `src/testing/` | 上記すべて |

守りたいのは主に「`format/` と `binary/` が純粋であること」です。パーサが transport に手を伸ばした瞬間、「デバイスなしでファイルを解析できる」という約束が静かに崩れます。

**拡張子付き import。** `./slip.js` は可、`./slip` は不可。ブラウザには解決機構がないので、拡張子なしは本番でだけ壊れます。

**DOM グローバル。** `document` / `window` の参照は `transport/web-serial.js` 以外で禁止です。Node と Worker で動かなくなります。

---

## 6. ロケール検証

```sh
npm run lint:locales
```

`web/locales/en.json` が正典です。`scripts/check-locales.js` が各言語について検査します。

- キーの欠落（実行時は英語にフォールバックしますが、気づかないまま放置されるのを防ぐ）
- 未知のキー（片方だけリネームした痕跡であることが多い）
- **placeholder の不一致。** `{label}` を訳文で落とすと、その値が画面に出なくなります

### 6.1 言語を追加する

コードの変更は不要です。

1. `web/locales/en.json` をコピーして `web/locales/<code>.json` を作り、値を訳す
2. `web/i18n.js` の `LOCALES` に `{ code, nativeName }` を 1 行足す
3. `npm run lint:locales` で欠落がないことを確認

`zh-TW` のような地域タグから `zh-Hant` へのマッピングが要る場合は、同ファイルの `TAG_ALIASES` に足してください。

### 6.2 文言を追加するとき

**`src/` にユーザー向けの文言を書かないでください。** ライブラリが返すのは安定した `code` と `params` だけで、翻訳は `web/locales/` の責務です。この分離があるおかげで、ライブラリを組み込む第三者アプリが自前の文言体系を使えます。

```js
// src/ 側
issues.push({ level: 'warning', code: 'partition.overlap', params: { a, b, at } });

// web/locales/ja.json 側
"partition.overlap": "パーティション「{a}」と「{b}」が重なっています。"
```

---

## 7. ビルド

```sh
npm run build        # dist/
npm run build:site   # site/（build の後に実行すること）
npm run clean        # dist / site / types を削除
```

`dist/`・`site/`・`types/` はすべて `.gitignore` 済みです。生成物はコミットしません。

### 7.1 `dist/` の中身

| ファイル | 内容 | サイズ |
| --- | --- | --- |
| `esp-flashjs.js` / `.min.js` | 全部（Web Serial 含む） | 107 KB / 52 KB |
| `esp-flashjs.core.js` / `.min.js` | 解析のみ（シリアル関連なし） | 53 KB / 28 KB |
| `stub/*.json` | 実行時 fetch 用。**バンドルに埋め込まない** | 132 KB |

esbuild は `bundle` と `minify` にしか使っていません。`target` を指定していないので**構文変換は起きません**。

### 7.2 `site/` の組み立て

`scripts/build-site.js` が `web/` の中身をサイトルートへ、`src/` `examples/` `dist/` `docs/` をリポジトリと同じ位置に配置します。

`web/` だけ深さが変わるので、`web/` から `src/` への参照は **`web/esp-flashjs.js` の 1 ファイルに集約**してあります。build-site が書き換えるのはこのファイルの指定子だけです。

**`web/` 配下のファイルが `../src/` を直接 import してはいけません。** 必ず `./esp-flashjs.js`（`components/` からは `../esp-flashjs.js`）を経由してください。これを破るとサイト上でだけモジュール解決が壊れます。

build-site は最後に**絶対パスの混入を検査**して、見つかれば失敗します。サイトは `/esp-flashjs/` 配下で配信されるので、`/src/...` のような絶対パスは必ず壊れるためです。

---

## 8. flasher stub の更新

```sh
npm run fetch-stub                # 既定のタグから取得
npm run fetch-stub -- --tag v1.3.0
```

取得元は [espressif/esp-flasher-stub](https://github.com/espressif/esp-flasher-stub) の release で、**Apache-2.0 OR MIT** です。

> **旧 `esptool-legacy-flasher-stub` は GPL-2.0 なので絶対に使わないでください。** 本リポジトリは MIT です。`scripts/fetch-stub.js` は URL を固定しているので、通常の手順を踏む限り混入しません。手で JSON を置くのは避けてください。

取得元のタグは `src/protocol/stub/README.md` に自動記録されます。

---

## 9. 実機での手動テスト

自動テストで担保できない部分です。実機を触るときは以下を通してください。

### 9.1 準備

- ボードを USB で接続
- `npm run dev` → `http://localhost:8080/web/` を Chrome か Edge で開く
- 別のツール（Arduino IDE、esptool、シリアルモニタ）がポートを掴んでいないことを確認。掴まれていると接続に失敗します

### 9.2 チェックリスト

**接続**

- [ ] Connect でポート選択が出る
- [ ] チップ名が正しく表示される
- [ ] MAC アドレスが表示される（`unknown` でない）
- [ ] Flash サイズが実際の容量と一致する
- [ ] Mode が「stub ローダ」になる。ROM のままなら stub ロードに失敗している
- [ ] BOOT ボタンを押さずに接続できる（自動 reset が効いている）

**読み出し**

- [ ] パーティションテーブルが自動で読まれ、Flash Map に出る
- [ ] Partition を選んで Read → Hex タブに中身が出る
- [ ] app パーティションを Analyze → ESP Firmware Image と判定され、checksum が valid
- [ ] Flash Dump が完走し、サイズが Flash サイズと一致する
- [ ] 進捗バーが動き、Cancel で中断できる

**書き込み（壊れてもいいボードで）**

- [ ] Write Partition でファイル選択 → 確認ダイアログが出る
- [ ] ラベルを正しく入力するまで実行ボタンが押せない
- [ ] 実行するとバックアップが自動ダウンロードされる
- [ ] 書き込み後に検証が通る
- [ ] 書き込んだ内容を読み戻すと一致する

**エラー系**

- [ ] ケーブルを抜くとエラーがログに出て、UI が固まらない
- [ ] Disconnect 後にアプリが再起動する（reset が効いている）

**ブラウザ**

- [ ] Firefox か Safari で開き、接続 UI が「非対応」と明示され、ファイル解析は動く

### 9.3 結果の記録

動いたチップは README の対応表（英日両方）の「実機検証」列を更新してください。**動かしていないものを「済」にしないでください。**

問題が出たら、ログペインの Export でテキストを書き出してください。チップ情報とバージョンがヘッダに入るので、そのまま Issue に貼れます。

---

## 10. コミット前に

```sh
npm run check
```

CI と同じ検査（テスト・型検査・レイヤ・ロケール）をまとめて走らせます。これが通っていれば CI で落ちることはほぼありません。

ビルドまで含めて確認するなら:

```sh
npm run check && npm run build && npm run build:site
```

---

## 11. よくある落とし穴

| 症状 | 原因 |
| --- | --- |
| ブラウザで `Failed to resolve module specifier` | import に拡張子がない。`npm run lint:layers` が検出します |
| サイト上でだけ 404 | 絶対パスを書いた、または `web/` から `../src/` を直接 import した |
| JSDoc の型が効かない | コメントが `/*` で始まっている。`/**` が必要です |
| 接続はできるが Read が失敗する | stub がロードされていない。ROM には READ_FLASH がありません |
| LAN の IP で接続ボタンが無効 | セキュアコンテキストではない。localhost か HTTPS を使ってください |
| ポートが開けない | 他のツールが掴んでいる |
| 翻訳が英語のまま | キーの綴り違い。ブラウザのコンソールに警告が出ます |
