# リリース手順

npm への公開と GitHub Pages の更新。

関連文書: [開発ガイド](./development.ja.md) / [CI](./ci.ja.md) / [配布方法](./publishing.ja.md)

---

## 1. 全体像

公開先は 2 つあり、**トリガが別**です。

| 公開先 | トリガ | 頻度 |
| --- | --- | --- |
| **GitHub Pages** | `main` への push | 毎回自動 |
| **npm** | `v*` タグの push | リリース時のみ |

つまり `main` にマージすればサイトは勝手に最新になりますが、npm には出ません。npm への公開は必ずタグを打つという明示的な操作を要します。

---

## 2. バージョニング

semver に従います。

**`0.x` の間は、破壊的変更を minor で入れてよい**こととします（`0.1.0` → `0.2.0`）。API はまだ固まっていません。この方針は README にも明記してあります。

`1.0.0` は、以下がすべて満たされてからにします。

- 主要チップで実機検証が済んでいる
- NVS の編集と書き戻し（Phase 2）が動いている
- 公開 API を破壊的に変えたい箇所が残っていない

| 変更 | 上げ方（0.x） | 上げ方（1.0 以降） |
| --- | --- | --- |
| バグ修正 | patch | patch |
| 機能追加 | minor | minor |
| 破壊的変更 | minor | major |

---

## 3. 初回リリースの準備

一度だけ必要な作業です。2 回目以降は [4 章](#4-リリース手順)へ。

### 3.1 パッケージ名を確認する

```sh
npm view esp-flashjs
```

`404` なら空いています。誰かが取っていたら名前を決め直し、`package.json` の `name`、README の import 例、CDN の URL をすべて更新してください。

### 3.2 npm に最初の版を出す

Trusted Publishing は既存パッケージにしか設定できないので、初回だけ手元から公開します。

```sh
npm login
npm run check && npm run build && npm run types
npm publish --access public
```

### 3.3 Trusted Publishing を設定する

npmjs.com のパッケージページ → Settings → Trusted Publisher で、以下を登録します。

| 項目 | 値 |
| --- | --- |
| Provider | GitHub Actions |
| Repository | `tanakamasayuki/esp-flashjs` |
| Workflow filename | `release.yml` |

これで長期トークンをリポジトリに置かずに済みます。設定しない場合は、npm の Automation トークンを `NPM_TOKEN` シークレットとして登録してください（[CI 5.2](./ci.ja.md#52-npm-への公開)）。

### 3.4 GitHub Pages を有効にする

**Settings → Pages → Source** を **「GitHub Actions」** に変更します。既定のままだと、ワークフローは成功するのに何も公開されません。

---

## 4. リリース手順

### 4.1 リリース前チェック

```sh
git switch main && git pull
npm ci
npm run check && npm run build && npm run build:site
```

`npm ci` を使うのは、`package-lock.json` の通りに入れるためです。ローカルに残った古い依存で確認しても意味がありません。

確認すること:

- [ ] `main` が最新で、作業中の変更が残っていない（`git status` がクリーン）
- [ ] `npm run check` が通る
- [ ] 変更点が README に反映されている（対応チップ、Phase の進捗、API の変更）
- [ ] 破壊的変更があれば README にその旨がある
- [ ] 実機で確認した項目があれば、README の対応表を更新した
- [ ] `npm pack --dry-run` の同梱ファイルが妥当（[4.2](#42-同梱物を確認する)）

### 4.2 同梱物を確認する

```sh
npm pack --dry-run
```

**含まれているべきもの:** `dist/`、`src/`、`types/`、`README.md`、`README.ja.md`、`LICENSE`、`NOTICE`

**含まれていてはいけないもの:** `web/`、`examples/`、`test/`、`site/`、`scripts/`、`docs/`

npm の利用者にリファレンスアプリは不要で、パッケージを太らせるだけです。`package.json` の `files` で制御しています。

`src/protocol/stub/*.json` と `dist/stub/*.json` は**含まれている必要があります**。実行時に fetch する対象なので、これが無いと Flash 読み出しが動きません。

### 4.3 バージョンを上げてタグを打つ

```sh
npm version minor    # または patch / major
```

この 1 コマンドで、npm のライフサイクルにより以下が順に走ります。

| 段階 | 実行されるもの | 内容 |
| --- | --- | --- |
| `preversion` | `npm run check` | 検査。**落ちたらここで中断**し、バージョンは上がりません |
| — | npm 本体 | `package.json` の `version` を更新 |
| `version` | `scripts/sync-version.js` | `src/index.js` の `VERSION` 定数を合わせ、`git add` する |
| — | npm 本体 | コミット（メッセージは `0.2.0`）と `v0.2.0` タグの作成 |

`VERSION` 定数の同期を自動化してあるのは、手作業だと必ずずれるからです。ずれると、バグ報告に添付されたログのバージョン表示が嘘になります。

**手で更新が必要なもの:** README（英日）と `examples/` の CDN URL に書いたバージョン番号。古い版を指したままだと、新機能を試そうとした人が古いコードを読み込みます。

```sh
grep -rn "esp-flashjs@[0-9]" README.md README.ja.md examples/ docs/
```

### 4.4 push する

```sh
git push origin main
git push origin --tags
```

`main` の push で Pages が、タグの push で Release が動きます。

### 4.5 結果を確認する

Actions タブで **Release to npm** が緑になったら:

```sh
npm view esp-flashjs version        # 新しいバージョンが出るか
npm view esp-flashjs dist.tarball
```

CDN からも確認します（jsDelivr は数分かかることがあります）。

```sh
curl -sI https://cdn.jsdelivr.net/npm/esp-flashjs@0.2.0/dist/esp-flashjs.min.js | head -1
```

npm のパッケージページに provenance のバッジが出ていることも見てください。出ていなければ `id-token: write` か Trusted Publishing の設定に問題があります。

### 4.6 GitHub Release を書く

タグができているので、Releases → Draft a new release でタグを選び、変更点を書きます。ワークフローは自動生成しないので手動です。

書くとよいこと:

- 追加された機能
- **破壊的変更**（`0.x` では minor に入るので、見落とされないよう目立たせる）
- 修正されたバグ
- 実機検証が進んだチップ

---

## 5. 公開後にやること

- [ ] `https://tanakamasayuki.github.io/esp-flashjs/` が新しい版で動く
- [ ] CDN のサンプルが動く（README のスニペットをそのまま実行してみる）
- [ ] `npm i esp-flashjs` して `import` が通る
- [ ] TypeScript のプロジェクトから型が引けるか（`.d.ts` が正しく出ているか）

最後の確認は捨てディレクトリで:

```sh
mkdir /tmp/check && cd /tmp/check && npm init -y
npm i esp-flashjs
node -e "import('esp-flashjs/core').then(m => console.log(Object.keys(m).length, 'exports'))"
```

---

## 6. 間違えたとき

### 6.1 公開前に気づいた

タグを push する前なら、やり直せます。

```sh
git tag -d v0.2.0
git reset --hard HEAD~1     # npm version のコミットを取り消す
```

### 6.2 公開してしまった

**npm の公開は取り消せないものと考えてください。** `npm unpublish` は 72 時間以内かつ他が依存していない場合のみ可能で、同じバージョン番号は二度と使えません。

**基本方針: 取り下げるより、直した版をすぐ出す。**

```sh
# 壊れた版を deprecate して、利用者に知らせる
npm deprecate esp-flashjs@0.2.0 "Broken flash read; use 0.2.1 or later"

# 修正して patch を出す
npm version patch
git push origin main --tags
```

`dist-tags` の `latest` は自動的に新しい版を指すので、`npm i esp-flashjs` する人は修正版を得ます。

### 6.3 Pages が壊れた

`main` を revert して push すれば、次のデプロイで戻ります。急ぐ場合は、直前の正常なコミットに `git revert` してから Actions の手動実行（Run workflow）で即座に再デプロイできます。

---

## 7. チェックリスト（印刷用）

```text
準備
  [ ] main が最新でクリーン
  [ ] npm ci
  [ ] npm run check && npm run build && npm run build:site
  [ ] npm pack --dry-run で同梱物を確認
  [ ] README の対応チップ表・Phase 進捗を更新
  [ ] README / examples の CDN バージョンを更新

リリース
  [ ] npm version <patch|minor|major>      ← 検査と VERSION 同期は自動
  [ ] git push origin main
  [ ] git push origin --tags

確認
  [ ] Actions の Release が緑
  [ ] Actions の Pages が緑
  [ ] npm view esp-flashjs version
  [ ] provenance バッジが出ている
  [ ] Pages のサイトが動く
  [ ] CDN の URL が引ける
  [ ] GitHub Release に変更点を書いた
```
