# リリース手順

[English](./release.md) · **日本語**

npm への公開は**手元のマシンから**行います。トークンをリポジトリに置かないためです。

関連文書: [開発ガイド](./development.ja.md) / [CI](./ci.ja.md) / [配布方法](./publishing.ja.md)

---

## 1. 毎回のリリース（これをコピペ）

`main` がクリーン（コミット漏れなし）であることを確認してから:

```sh
npm version patch              # 修正なら patch / 機能追加なら minor / 破壊的変更なら major
npm publish --access public    # 2FA のコードを聞かれたら入力
git push --follow-tags
```

これだけです。各コマンドが自動でやること:

| コマンド | 自動で走るもの |
| --- | --- |
| `npm version <ver>` | ① `preversion` = `npm run check`（テスト・型・レイヤ・ロケール。**失敗するとバージョンは作られない**）② `scripts/sync-version.js` が `src/index.js` の `VERSION` 定数を同期 ③ コミット + `v*` タグ作成 |
| `npm publish` | `prepack` = `npm run build` + `npm run types`（`dist/` と `types/` を作ってから梱包） |
| `git push --follow-tags` | コミットとタグを push。Pages が自動デプロイ。**release.yml は発火しない**（手動実行専用の予備） |

バージョンの選び方:

| 変更内容 | コマンド |
| --- | --- |
| バグ修正・ドキュメントのみ | `npm version patch` |
| 後方互換の機能追加 | `npm version minor` |
| 破壊的変更（API の変更・削除） | `npm version major` |

`0.x` の間は、**破壊的変更を minor で入れてよい**こととします（`0.1.0` → `0.2.0`）。API はまだ固まっていません。この方針は README にも明記してあります。

---

## 2. 何が自動で、何が手動か

push しても npm には出ません。**npm への公開はローカルでの `npm publish` だけ**が経路です。

| 対象 | トリガ | 実行される場所 |
| --- | --- | --- |
| **npm** | `npm publish` | **手元のマシン** |
| **GitHub Pages** | `main` への push | GitHub Actions（自動） |
| **CI（検査）** | push / PR | GitHub Actions（自動） |

`release.yml` はタグ push では動きません。ローカル公開と衝突して、npm が既に持っているバージョンで赤くなるのを避けるためです。CI から公開したくなった場合は [6 章](#6-ci-から公開したくなったら)を参照してください。

---

## 3. リリース前に手で見ておくこと

`npm version` が `npm run check` を走らせるので、テスト・型・レイヤ・ロケールは自動です。それでは拾えないものだけ確認します。

- [ ] `git status` がクリーン
- [ ] README（英日）の**対応チップ表**を更新した（実機で確認できたものだけ「済」にする）
- [ ] README の Phase 進捗が実態と合っている
- [ ] 破壊的変更があれば README に書いた
- [ ] README と `examples/` の **CDN URL のバージョン**を上げた

```sh
grep -rn "esp-flashjs@[0-9]" README.md README.ja.md examples/ docs/
```

古い版を指したままだと、新機能を試そうとした人が古いコードを読み込みます。

### 同梱物の確認

```sh
npm pack --dry-run
```

**含まれているべきもの:** `dist/`、`src/`、`types/`、`README.md`、`README.ja.md`、`LICENSE`、`NOTICE`

**含まれていてはいけないもの:** `web/`、`examples/`、`test/`、`site/`、`scripts/`、`docs/`

`src/protocol/stub/*.json` と `dist/stub/*.json` は**含まれている必要があります**。実行時に fetch する対象なので、これが無いと Flash 読み出しが動きません。

---

## 4. 公開後の確認

```sh
npm view esp-flashjs version
```

- npm ページ: <https://www.npmjs.com/package/esp-flashjs>
- CDN（反映まで数分かかることがある）: <https://cdn.jsdelivr.net/npm/esp-flashjs/dist/esp-flashjs.min.js>
- Web アプリ: <https://tanakamasayuki.github.io/esp-flashjs/>

型定義が正しく届いているかは、捨てディレクトリで:

```sh
mkdir /tmp/check && cd /tmp/check && npm init -y
npm i esp-flashjs
node -e "import('esp-flashjs/core').then(m => console.log(Object.keys(m).length, 'exports'))"
```

GitHub Release（Releases → Draft a new release）はタグを選んで手で書きます。書くとよいこと: 追加機能、**破壊的変更**（`0.x` では minor に入るので目立たせる）、修正したバグ、実機検証が進んだチップ。

---

## 5. 困ったとき

**`403 Two-factor authentication ... is required`**

2FA のワンタイムコードが渡っていません。`npm version` は済んでいるので publish だけやり直せば OK です。

```sh
npm publish --access public --otp=123456   # 6 桁は認証アプリの現在値
```

**publish する前にバージョンを取り消したい**

```sh
git reset --hard HEAD~1      # npm version が作ったコミットを取り消す
git tag -d v0.1.1            # タグも消す（番号は読み替え）
```

**publish してしまった版を直したい**

`npm unpublish` は原則使いません（72 時間制限があり、同じ番号は二度と使えません）。修正を入れて次の版を出します。

```sh
npm deprecate esp-flashjs@0.2.0 "Broken flash read; use 0.2.1 or later"
npm version patch
npm publish --access public
git push --follow-tags
```

`dist-tags` の `latest` は自動的に新しい版を指すので、`npm i esp-flashjs` する人は修正版を得ます。

**`npm version` が check で止まった**

それが仕事です。バージョンもタグも作られていないので、直してからやり直してください。

**Pages が壊れた**

`main` を revert して push すれば次のデプロイで戻ります。急ぐなら Actions タブから Deploy to GitHub Pages を手動実行できます。

---

## 6. CI から公開したくなったら

`.github/workflows/release.yml` は残してあります。`workflow_dispatch` のみなので、**Actions タブから手動実行**したときだけ動きます。

使うには、npmjs.com のパッケージ設定で Trusted Publishing を登録します。

| 項目 | 値 |
| --- | --- |
| Provider | GitHub Actions |
| Repository | `tanakamasayuki/esp-flashjs` |
| Workflow filename | `release.yml` |

これでトークンなしに公開でき、npm 上に provenance（GitHub Actions のこの実行から公開されたという検証可能な証明）が付きます。ハードウェアのファームウェアを書き換えるライブラリなので、供給元をたどれることには実質的な価値があります。

Trusted Publishing を使わない場合は、npm の Automation トークンを `NPM_TOKEN` シークレットとして登録してください。

---

## 7. 初回だけの準備

記録として残します。2 回目以降は不要です。

1. `npm view esp-flashjs` が 404（名前が空いている）ことを確認する。誰かが取っていたら名前を決め直し、`package.json` の `name`、README の import 例、CDN URL をすべて更新する
2. `npm login` でこのマシンを npm アカウントに紐付ける
3. npm アカウントの 2FA（認証アプリ）を有効化する — 現在の npm は「2FA または 2FA バイパス付きトークン」なしでは publish できない
4. **Settings → Pages → Source** を「GitHub Actions」に変更する（既定のままだと、ワークフローは成功するのに何も公開されない）
5. 初回だけは [8 章](#8-初回リリースだけの例外)の手順で公開する（`package.json` に既に初期バージョンが入っているため、通常の 3 行は使えない）

---

## 8. 初回リリースだけの例外

`package.json` が最初から `0.1.0` を持っているので、`npm version 0.1.0` は

```text
npm error Version not changed
```

で止まります。**これは異常ではありません。** npm が「変化のないバージョンコミットは作らない」と言っているだけです。

ただし `npm version` が止まったということは、**それに紐づく処理も走っていません**。

| 本来 `npm version` がやること | 実行されたか |
| --- | --- |
| `preversion` = `npm run check` | **走っていない** |
| `VERSION` 定数の同期 | 走っていない（すでに一致しているので実害なし） |
| コミットと `v0.1.0` タグの作成 | **作られていない** |

そのため初回だけは `--allow-same-version` を付けます。**同じバージョンのままで、通常フローを最後まで走らせる**フラグです。

```sh
npm version 0.1.0 --allow-same-version
npm publish --access public
git push --follow-tags
```

これで `preversion` の検査・`VERSION` 定数の同期・コミット・**注釈付きタグ**まで、通常の 3 行と同じものが自動で行われます。手で `git tag` を打つ必要はありません。

`package.json` に差分が出ない場合、npm は空のコミットを作ります。無害ですし、リリース地点の目印として役に立ちます。

**2 回目以降はフラグも不要**です。バージョンが変わるので `npm version patch` がそのまま動きます。

### 手でタグを打つ場合の注意

何らかの事情で自分でタグを作るなら、**必ず `-a` を付けてください**。

```sh
git tag -a v0.1.0 -m "v0.1.0"     # ○ 注釈付き
git tag v0.1.0                    # × 軽量タグ
```

`git push --follow-tags` は**軽量タグを push しません**。エラーも警告も出ないので、「ローカルにはタグがあるのに GitHub には無い」という状態に気づきにくいです。`npm version` が作るタグは注釈付きなので、自動フローではこの問題は起きません。

軽量タグを作ってしまった場合は、明示的に push するか作り直します。

```sh
git push origin v0.1.0
# または
git tag -d v0.1.0 && git tag -a v0.1.0 -m "v0.1.0" && git push --follow-tags
```
