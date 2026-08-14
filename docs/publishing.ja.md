# ESP FlashJS 配布・公開方法

[English](./publishing.md) · **日本語**

本書は ESP FlashJS の配布・公開についての**決定と、その理由**を記録する。実際に手を動かす手順は [release.ja.md](./release.ja.md) に、ワークフローの説明は [ci.ja.md](./ci.ja.md) にある。仕様本体は [spec.ja.md](./spec.ja.md)。

---

## 1. 結論

3 経路で公開する。

| 経路 | 対象 | URL / 指定子 |
| --- | --- | --- |
| **GitHub Pages** | Web アプリを試したい人 | `https://tanakamasayuki.github.io/esp-flashjs/` |
| **npm** | 自分のプロジェクトに組み込む人 | `npm i esp-flashjs` |
| **CDN** | ビルドなしで使いたい人 | `https://cdn.jsdelivr.net/npm/esp-flashjs@0.1.0/dist/esp-flashjs.min.js` |

### 1.1 ライブラリ配布は plainbind の方式を踏襲する

同一著者の既存 JS プロジェクト [plainbind](https://github.com/tanakamasayuki/plainbind) の配布方式に合わせる。

| 項目 | plainbind | ESP FlashJS |
| --- | --- | --- |
| npm パッケージ名 | `plainbind`（スコープなし） | `esp-flashjs`（スコープなし） |
| CDN | jsDelivr で `dist/*.min.js` | 同左 |
| ビルド | `scripts/build.js`（esbuild）→ `dist/`、`dist` は `.gitignore` | 同左 |
| `package.json` | `main` / `module` / `browser` / `unpkg` / `jsdelivr` / `exports` を併記 | 同左 |
| `files` | `dist` とソースの両方を同梱 | 同左 |
| README | `README.md` + `README.ja.md` の二言語 | 同左 |
| ライセンス / author | MIT / TANAKA Masayuki | 同左 |

`src/` のソースはビルドなしでそのまま `import` でき、加えて `<script src>` 派のために `dist/esp-flashjs.min.js` を提供する。**ビルドは配布の利便のためのオプションであり、ライブラリを使う前提条件ではない。**

---

## 2. GitHub Pages

Web アプリ自体が主要な成果物であり、かつ **Web Serial API は Secure Context（HTTPS）でしか動作しない**ため、誰でも試せる HTTPS のデモページを用意する。

### 2.1 配信方式: GitHub Actions

「Deploy from a branch」では公開ディレクトリがリポジトリルートか `/docs` に限られ、`dist/` は `.gitignore` 済みなので Pages に存在しない。Actions で配信すれば、`npm run build` の成果物を含めた任意の構成を配信でき、**リポジトリのルートは plainbind と同じすっきりした形のまま保てる**。

副次的な利点として、CI 通過を配信の条件にできる（ブランチ公開はテストが落ちていてもプッシュ即公開になる）。

リポジトリ設定で **Settings → Pages → Source を「GitHub Actions」** にする。

### 2.2 `site/` の組み立て

`scripts/build-site.js` が以下を行う。

```text
site/
├── index.html            ← web/index.html
├── app.js                ← web/app.js
├── store.js / actions.js / i18n.js
├── components/           ← web/components/
├── locales/              ← web/locales/
├── styles/               ← web/styles/
├── esp-flashjs.js        ★ 生成（下記）
│
├── src/                  ← src/ をそのままコピー
├── examples/             ← examples/ をそのままコピー
├── dist/                 ← npm run build の成果物
└── docs/                 ← docs/ をそのままコピー
```

つまり **`web/` の中身をサイトルートへ、それ以外はリポジトリと同じ位置に**置く。

`web/` の中身だけ深さが変わるため、`web/` から `src/` への相対参照が 1 段ずれる。これを吸収するために、`web/` から `src/` への参照は `web/esp-flashjs.js` の 1 ファイルに集約してある（[spec.ja.md 4.4](./spec.ja.md#44-モジュール解決とパス)）。

```js
// リポジトリ内の web/esp-flashjs.js
export * from '../src/index.js';

// build-site.js が site/esp-flashjs.js として書き出す内容
export * from './src/index.js';
```

**書き換えるのはこの 1 ファイルだけ。** `web/` 内部の相対参照はすべて兄弟関係なので、配置が変わっても壊れない。`examples/` はリポジトリと同じ深さに置かれるので `../src/index.js` がそのまま通り、書き換え不要。

この方式なら、ローカルでリポジトリを HTTP サーバで開いた状態と、Pages 上の状態で、**同じソースが同じように動く**。

### 2.3 ワークフロー

`.github/workflows/pages.yml`。検査 → ビルド → `site/` のアップロード → デプロイの順で、CI と同じ検査を先頭に置いている。

**壊れたページを公開するより、公開が遅れるほうがましである**という判断で、検査を通らなければデプロイしない。

権限・並行制御・初回に必要なリポジトリ設定などの詳細は [ci.ja.md](./ci.ja.md) を参照。

### 2.4 注意点

| 項目 | 内容 |
| --- | --- |
| 絶対パス禁止 | 公開 URL が `/esp-flashjs/` 配下のため、`/src/...` は必ず壊れる。HTML・JS・CSS のすべてのパス参照を相対にする。CI で grep チェックする |
| `.nojekyll` | Actions 配信では Jekyll 処理が入らないため**不要**。ルートに置かない |
| HTTPS | Web Serial は Secure Context 必須。Pages は HTTPS なので問題ない。ローカル開発は `http://localhost` を使う（localhost は Secure Context 扱い）。LAN の IP（`http://192.168.x.x`）では動かない |
| MIME | `.js` は `text/javascript`、`.json` も正しく返る。設定不要 |
| 特別なヘッダ | 不要。`SharedArrayBuffer` を使わないので COOP/COEP は要らない。Pages はカスタムヘッダを設定できないため、これは意図的な設計制約である |
| キャッシュ | Pages の `Cache-Control` は約 10 分。更新が即反映されないことがある |
| 容量 | サイト上限 1GB、推奨 100MB 未満。stub JSON を全チップ分置いても数百 KB で問題ない |
| カスタムドメイン | 使う場合は `site/CNAME` を `build-site.js` が出力するようにする |

### 2.5 ローカル開発

`file://` では ESM の import と `fetch` が CORS で失敗する。必ず HTTP サーバを立てる。実行時依存ゼロの方針に合わせ、開発サーバも `node:http` だけで書いた `scripts/serve.js` を自前で持つ。

```sh
npm run dev
```

リポジトリのルートを配信するので、`http://localhost:8080/web/` でアプリが、`http://localhost:8080/examples/` でサンプルが、ビルドなしで動く。**ローカルと Pages で同じソースが同じように動く**のは 2.2 の配置のおかげである。

npm scripts の一覧と使い分けは [development.ja.md](./development.ja.md) にある。

---

## 3. npm

### 3.1 単一パッケージ

**`esp-flashjs`（スコープなし）で公開する。**

- ビルド構成上、パッケージを分けても利用者側の利得がない。`exports` のサブパスと `dist` の分割で同じ効果が得られる。
- スコープなしの名前は `npm i esp-flashjs` / `import 'esp-flashjs'` と短く、CDN URL も短い。
- 分割が必要になったら、`exports` のサブパスを維持したまま後から `@esp-flashjs/*` を追加公開できる。

公開前に `npm view esp-flashjs` で名前の空きを確認すること。

### 3.2 `dist` の構成

full と core の 2 系統を出す。オフライン解析しかしない利用者に、シリアル通信のコードを背負わせないため。

```text
dist/
├── esp-flashjs.js            full  ESM 非圧縮   107 KB
├── esp-flashjs.min.js        full  ESM 圧縮      52 KB
├── esp-flashjs.core.js       core  ESM 非圧縮    53 KB
├── esp-flashjs.core.min.js   core  ESM 圧縮      28 KB
└── stub/*.json               実行時 fetch 用    132 KB（バンドルには埋め込まない）
```

（サイズは v0.1.0 実測値）

| | full | core |
| --- | --- | --- |
| エントリ | `src/index.js` | `src/core.js` |
| 含むもの | すべて | `format/` `binary/` `util/` |
| 含まないもの | — | `transport/` `protocol/` `device/` `stub/` |
| 用途 | デバイス接続を伴う操作 | ファイルのオフライン解析、Node.js |

**stub JSON はバンドルに埋め込まない。** 全チップ分を base64 で埋めると本体が数百 KB 肥大し、解析しかしない利用者にも負担させることになる。`dist/stub/` に個別ファイルとして置き、`new URL('./stub/<chip>.json', import.meta.url)` で実行時に取得する。CDN 経由でも `dist/` からの相対で解決できる。

`scripts/build.js` は esbuild を `bundle` + `minify` のみで使い、**構文変換（target 変換）は行わない**。ソースは既にブラウザと Node.js がネイティブに解釈できる構文で書かれている。

### 3.3 `package.json`

```jsonc
{
  "name": "esp-flashjs",
  "version": "0.1.0",
  "description": "JavaScript toolkit for ESP32 flash analysis, editing and programming.",
  "type": "module",
  "license": "MIT",
  "author": "TANAKA Masayuki",
  "sideEffects": false,

  "main": "dist/esp-flashjs.js",
  "module": "dist/esp-flashjs.js",
  "browser": "dist/esp-flashjs.min.js",
  "unpkg": "dist/esp-flashjs.min.js",
  "jsdelivr": "dist/esp-flashjs.min.js",
  "types": "types/index.d.ts",

  "exports": {
    ".": {
      "types": "./types/index.d.ts",
      "default": "./dist/esp-flashjs.js"
    },
    "./core": {
      "types": "./types/core.d.ts",
      "default": "./dist/esp-flashjs.core.js"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },

  "files": ["dist", "src", "types", "README.md", "README.ja.md", "LICENSE", "NOTICE"],
  "engines": { "node": ">=20" },
  "keywords": ["esp32", "esptool", "web-serial", "flash", "nvs", "partition-table", "spiffs", "firmware"],
  "repository": { "type": "git", "url": "git+https://github.com/tanakamasayuki/esp-flashjs.git" },
  "bugs": { "url": "https://github.com/tanakamasayuki/esp-flashjs/issues" },
  "homepage": "https://tanakamasayuki.github.io/esp-flashjs/",
  "devDependencies": {
    "esbuild": "^0.25.0",
    "typescript": "^5.7.0"
  }
}
```

- `files` に `src` を含め、**バンドルされていない生ソースも同梱**する。ビルドを介さず個別モジュールを import したい利用者と、jsDelivr でソースを素通し参照したい利用者のため。
- `web/`・`examples/`・`test/` は含めない。npm 利用者にリファレンスアプリは不要で、パッケージを太らせるだけ。
- `homepage` は Pages の URL にする（npm のページからデモへ直行できる）。

### 3.4 型定義

TypeScript でソースを書くことはしないが、TS 利用者向けに `.d.ts` を生成して同梱する。JSDoc から自動生成するので手書きの型ファイルは持たない。

```jsonc
// tsconfig.json — 型検査と .d.ts 生成のためだけに置く。トランスパイルはしない
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "allowJs": true,
    "checkJs": true,
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.js"]
}
```

- CI では `tsc --noEmit` で JSDoc の型検査を行う。バイナリ処理では引数順の取り違えや `await` 忘れが例外にならず、静かに壊れたバイナリを書き込む形で表面化するため、この検査には価値がある。
- リリース時のみ `npm run types` で `types/` を生成する。**生成物はコミットしない。**

### 3.5 公開フロー

`.github/workflows/release.yml` で `v*` タグのプッシュをトリガに公開する。

```yaml
on:
  push:
    tags: ['v*']
permissions:
  contents: write
  id-token: write        # npm provenance に必要
```

手順: `npm ci` → `npm test` → `npm run typecheck` → `npm run build` → `npm run types` → `npm publish --provenance --access public`

- **`--provenance` を使う。** ハードウェアを書き換えるライブラリなので、供給元が GitHub Actions であることを npm 上で検証可能にしておく価値は高い。
- npm の Trusted Publishing（OIDC）を設定し、長期トークンをリポジトリに置かない。
- バージョンは semver。`0.x` の間は破壊的変更を minor で入れてよいこととし、README に明記する。

---

## 4. CDN

npm に公開すれば以下がそのまま動く。追加作業は不要。

```html
<!-- 推奨: jsDelivr -->
<script type="module">
  import { parsePartitionTable } from 'https://cdn.jsdelivr.net/npm/esp-flashjs@0.1.0/dist/esp-flashjs.core.min.js';
</script>
```

| CDN | 用途 |
| --- | --- |
| **jsDelivr** | 主。`dist/*.min.js` を素通し配信。plainbind と同じ |
| unpkg | 予備。jsDelivr と同形 |
| esm.sh | bare specifier を解決したい場合や `?bundle` を使いたい場合 |

本ライブラリは実行時依存ゼロで bare specifier を一切含まないため、**素通し配信でそのまま動く**。`dist/` を経由せず `src/` を直接読むこともできる。

```html
<script type="module">
  import { parseNvs } from 'https://cdn.jsdelivr.net/npm/esp-flashjs@0.1.0/src/format/nvs/parse.js';
</script>
```

CDN のサンプルコードでは**必ずバージョンを固定**する。バージョン未指定の URL を README に載せると、破壊的変更で他人のページが壊れる。

---

## 5. 公開しないもの

| 対象 | 理由 |
| --- | --- |
| CommonJS ビルド | Node.js 20+ は ESM をネイティブに扱える。二重管理のコストに見合わない |
| IIFE / UMD ビルド | `<script type="module">` で足りる。グローバル変数を汚す形は提供しない |
| Docker イメージ / デスクトップアプリ | スコープ外 |
| 実機由来の Flash ダンプ | fixture は匿名化したもののみ。MAC アドレス・Wi-Fi 認証情報・証明書を含むダンプを絶対にコミットしない |

---

## 6. ライセンスと帰属

- 本体: **MIT**（`LICENSE`）。
- 同梱する flasher stub: [espressif/esp-flasher-stub](https://github.com/espressif/esp-flasher-stub) の release JSON。**Apache-2.0 OR MIT のデュアルライセンス**のため MIT プロジェクトに同梱できる。`NOTICE` に帰属表示を記載し、`src/protocol/stub/README.md` に取得元のリリースタグを記録する。
- 旧 [espressif/esptool-legacy-flasher-stub](https://github.com/espressif/esptool-legacy-flasher-stub) は **GPL-2.0 のため使用しない。** 誤混入を防ぐため、取得は `scripts/fetch-stub.js` でリリース URL を固定して行う。
- プロトコル仕様は [esptool のドキュメント](https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html) に公開された仕様を参照したものであり、コードの複製は行わない。実装は本リポジトリで独自に行う。
- README に「Espressif Systems の公式プロジェクトではない」旨の免責を記載する。

---

## 7. 公開前チェックリスト

- [ ] `npm view esp-flashjs` で名前の空きを確認
- [ ] 絶対パス（`src="/`、`from '/`）が 1 つもない — grep で確認
- [ ] Settings → Pages → Source = GitHub Actions
- [ ] `npm run build:site` の出力を `npm run dev` 相当で開いて動作確認
- [ ] Pages 上で Chrome から実機接続まで通ることを手動確認
- [ ] Firefox / Safari で開いて、Binary モードが動き、接続 UI が「非対応」と明示されることを確認
- [ ] 各ロケール（en / ja / zh-Hans / zh-Hant）で表示崩れがないことを確認
- [ ] `NOTICE` に stub の帰属表示がある
- [ ] fixture に実機由来の秘匿情報が含まれていない
- [ ] README に免責・対応ブラウザ・チップ別の検証状況を明記
- [ ] `npm pack --dry-run` で同梱ファイルを確認（`web/` `examples/` `test/` が入っていないこと）
- [ ] CDN サンプルのバージョンが固定されている
