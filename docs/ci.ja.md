# GitHub Actions

[English](./ci.md) · **日本語**

3 本のワークフローが動いています。何を守っているのか、失敗したらどう読むのか、初回に必要なリポジトリ設定をまとめます。

関連文書: [開発ガイド](./development.ja.md) / [リリース手順](./release.ja.md)

---

## 1. 全体像

| ワークフロー | ファイル | 起動条件 | やること |
| --- | --- | --- | --- |
| **CI** | `.github/workflows/ci.yml` | `main` への push、全 PR | 検査してビルドが通ることを確認 |
| **Pages** | `.github/workflows/pages.yml` | `main` への push、手動 | 検査 → ビルド → GitHub Pages へデプロイ |
| **Release** | `.github/workflows/release.yml` | **手動実行のみ** | 検査 → ビルド → npm へ公開（予備） |

```text
PR を作る ──────────────► CI（検査のみ）
                             │
main にマージ ──────────► CI ＋ Pages（サイト更新）
                             │
npm publish（手元） ────► npm へ公開   ← Actions は関与しない
```

**npm への公開は手元のマシンから行います。**タグを push しても Actions は npm に触りません（[リリース手順](./release.ja.md)）。トークンをリポジトリに置かないための判断です。

CI と Pages は同じ検査を先頭で走らせます。**壊れたものを公開しないことが目的**なので、意図的に重複させています。

---

## 2. CI

`.github/workflows/ci.yml`

```yaml
on:
  push:
    branches: [main]
  pull_request
```

`ubuntu-latest` に Node 22 を入れ、`npm ci` の後に次を順に実行します。

| ステップ | コマンド | 落ちたときに疑うこと |
| --- | --- | --- |
| Unit tests | `npm test` | ロジックの退行。ローカルで `npm test` を再現 |
| Type check (JSDoc) | `npm run typecheck` | JSDoc の型と実装のずれ。`null` 未チェック、引数の取り違え |
| Layer boundaries | `npm run lint:layers` | 依存方向の逆流、拡張子なし import、DOM グローバルの持ち込み |
| Locale key coverage | `npm run lint:locales` | 訳の追加漏れ、placeholder の落とし |
| Build | `npm run build` | esbuild が解決できない import |
| Assemble site | `npm run build:site` | 絶対パスの混入、`web/esp-flashjs.js` を経由しない参照 |

### 2.1 ローカルで同じことを再現する

```sh
npm run check                            # 検査 4 種
npm run check && npm run build && npm run build:site   # CI と同一
```

`npm ci` は `package-lock.json` の通りに厳密に入れます。ローカルで `npm install` して lock が更新されたのに commit していないと、CI だけ違う依存で動くことになります。lock ファイルの差分は必ずコミットしてください。

### 2.2 キャッシュ

`actions/setup-node` の `cache: npm` で npm のキャッシュが効きます。依存が 3 つしかないので効果は小さいですが、無料なので入れてあります。

---

## 3. Pages

`.github/workflows/pages.yml`

### 3.1 なぜ「ブランチから公開」ではないのか

GitHub Pages を「Deploy from a branch」で使う場合、公開ディレクトリはリポジトリルートか `/docs` に限られます。しかし `dist/` は `.gitignore` 済みで、リポジトリには存在しません。ビルド成果物を含むサイトを配信するには Actions が必要です。

副次的に、**CI が通ったものだけを公開できる**という利点もあります。ブランチ公開はプッシュ即公開で、テストが落ちていても出ていきます。

### 3.2 権限と並行制御

```yaml
permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true
```

`id-token: write` は OIDC でのデプロイに必要です。`concurrency` は、連続 push したときに古いデプロイが後から上書きするのを防ぎます。

### 3.3 手順

`npm ci` → `npm test` → `npm run typecheck` → `npm run lint:layers` → ロケール検査 → `npm run build` → `npm run build:site` → `site/` をアップロード → デプロイ。

公開先は `https://tanakamasayuki.github.io/esp-flashjs/` です。

### 3.4 反映されるまで

デプロイ完了後、実際に見えるまで数分かかることがあります。Pages の `Cache-Control` は 10 分程度なので、ブラウザのハードリロード（Ctrl+Shift+R）を試してください。

### 3.5 手動実行

Actions タブ → Deploy to GitHub Pages → Run workflow。`workflow_dispatch` を入れてあるので、コード変更なしで再デプロイできます。

---

## 4. Release（予備）

`.github/workflows/release.yml`

**通常は使いません。** npm への公開は手元から `npm publish` で行います（[リリース手順](./release.ja.md)）。

```yaml
on:
  workflow_dispatch:      # 手動実行のみ。タグ push では発火しない

permissions:
  contents: read
  id-token: write         # npm provenance / Trusted Publishing に必要
```

**タグ push で発火させない理由:** ローカルで publish 済みのバージョンを Actions が再度公開しようとして必ず失敗し、赤いバッジだけが残るためです。公開経路は 1 本に絞ってあります。

CI と同じ検査の後、`npm publish --provenance --access public` を実行します（`prepack` が `dist` と `types` を作ります）。

### 4.1 使うとしたら

npmjs.com で Trusted Publishing（GitHub Actions / このリポジトリ / `release.yml`）を登録すると、Actions タブから手動実行してトークンなしで公開できます。npm 上に provenance のバッジが付きます。

---

## 5. 初回に必要なリポジトリ設定

コードだけでは動きません。以下は GitHub の Web UI で一度だけ設定します。

### 5.1 Pages

**Settings → Pages → Build and deployment → Source** を **「GitHub Actions」** に変更。

既定は「Deploy from a branch」なので、変更しないと `pages.yml` は成功したように見えて何も公開されません。

### 5.2 npm への公開

**通常は何も設定しません。** 公開は手元の `npm publish` で行うので、リポジトリ側に必要な設定はありません。必要なのは `npm login` と npm アカウントの 2FA だけです（[リリース手順 7 章](./release.ja.md#7-初回だけの準備完了済み)）。

Actions から公開したくなった場合のみ、npmjs.com で Trusted Publishing（GitHub Actions / このリポジトリ / `release.yml`）を登録するか、Automation トークンを **Settings → Secrets and variables → Actions** に `NPM_TOKEN` として置きます。

### 5.3 Environment（任意）

`pages.yml` は `github-pages` environment を使います。これは初回デプロイ時に自動作成されるので、通常は何もしなくて構いません。承認を挟みたい場合は **Settings → Environments** で保護ルールを設定できます。

---

## 6. 失敗したときの読み方

### 6.1 まずどこで落ちたかを見る

Actions タブ → 該当の実行 → 赤いステップを開く。ステップ名がそのまま原因の分類になっています。

### 6.2 症状別

| 症状 | 原因と対処 |
| --- | --- |
| `npm ci` が失敗する | `package-lock.json` が `package.json` と食い違っている。ローカルで `npm install` して lock をコミット |
| テストだけ落ちる | ローカルで `npm test` を再現。CI 特有の要素（時刻・ロケール・並行性）はテストに含めていないので、まず再現するはず |
| 型検査だけ落ちる | `npx tsc --noEmit` をローカルで。エディタは古いキャッシュを見ていることがあるので、コマンドで確認 |
| `lint:layers` で「must not import from」 | 依存方向の違反。責務の置き場所が間違っている可能性が高いので、`@ts-ignore` 的な回避ではなくファイルの移動を検討 |
| `lint:layers` で「missing a file extension」 | import に `.js` を付ける |
| `lint:locales` で missing | 訳を追加するか、`en.json` から不要なキーを消す |
| `build:site` で「Absolute paths found」 | `/src/...` のような絶対パスを書いた。サイトはサブディレクトリ配信なので必ず壊れる |
| Pages が成功するのに反映されない | Source が「GitHub Actions」になっているか確認。キャッシュも疑う |
| Release（手動実行）で 403 / E404 | npm の権限。Trusted Publishing の設定漏れ、またはトークンの期限切れ。そもそも通常は手元から publish します |

### 6.3 再実行

一時的なネットワーク障害などは Re-run failed jobs で解消します。ただし**テストが落ちたときに再実行で通ることを期待しないでください**。このリポジトリのテストは実機にもネットワークにも依存していないので、落ちたら本物の失敗です。

---

## 7. ワークフローを変更するとき

`.github/workflows/*.yml` を編集した PR は、**その PR のブランチ上の定義で** CI が動きます（`pull_request` トリガの場合）。一方 `pages.yml` と `release.yml` は `main` にマージされるまで新しい定義では動きません。

`pages.yml` と `release.yml` はどちらも `workflow_dispatch` を持つので、マージ後に手動実行して確認できます。`release.yml` は実行すると本当に publish するため、動作確認は Trusted Publishing を設定してからにしてください。

---

## 8. 意図的にやっていないこと

| やらないこと | 理由 |
| --- | --- |
| lint（ESLint / Prettier） | 型検査とレイヤ検証で実害のあるものは拾えている。整形の好みを CI で強制するほどの規模ではない |
| ブラウザでの E2E | Playwright を入れると devDependencies が桁違いに増える。UI は手動チェックリスト（[開発ガイド 9 章](./development.ja.md#9-実機での手動テスト)）で担保する |
| 実機テスト | セルフホストランナーにボードを繋げば可能だが、現状は割に合わない |
| カバレッジの閾値強制 | 数字を守るためのテストが書かれ始めるほうが害が大きい。`npm run test:coverage` で見るだけにしている |
| 依存の自動更新（Dependabot） | devDependencies が 3 つしかない。手で見るほうが早い |

規模が変われば見直す前提の判断です。
