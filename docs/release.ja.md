# リリース手順

[English](./release.md) · **日本語**

npm への公開は**手元のマシンから**行います。トークンをリポジトリに置かないためです。

関連文書: [開発ガイド](./development.ja.md) / [CI](./ci.ja.md) / [配布方法](./publishing.ja.md)

---

## 1. 毎回のリリース（これをコピペ）

`main` がクリーン（コミット漏れなし）で、変更履歴が書けていることを確認してから（[1.1](#11-リリースコミットが自動で書き換えるもの)）:

```sh
npm version patch              # 修正なら patch / 機能追加なら minor / 破壊的変更なら major
npm publish --access public    # 2FA のコードを聞かれたら入力
git push --follow-tags
```

これだけです。各コマンドが自動でやること:

| コマンド | 自動で走るもの |
| --- | --- |
| `npm version <ver>` | ① `preversion` = `npm run check` + `scripts/check-releasable.js`（**ここで失敗すればバージョンは作られず、何も書き換わらない**）② `scripts/sync-version.js` が変更履歴を締め、全バージョン参照を書き換える（[1.1](#11-リリースコミットが自動で書き換えるもの)）③ コミット + `v*` タグ作成 |
| `npm publish` | `prepack` = `npm run build` + `npm run types`（`dist/` と `types/` を作ってから梱包） |
| `git push --follow-tags` | コミットとタグを push。Pages が自動デプロイ。**release.yml は発火しない**（手動実行専用の予備） |

バージョンの選び方:

| 変更内容 | コマンド |
| --- | --- |
| バグ修正・ドキュメントのみ | `npm version patch` |
| 後方互換の機能追加 | `npm version minor` |
| 破壊的変更（API の変更・削除） | `npm version major` |

1.0.0 以降、API はセマンティックバージョニングの対象です。**破壊的変更には major が要ります。** 「明らかに間違っていたから」は例外になりません。`^1` で固定している人は、何も読まずにその修正を受け取ります。

---

## 1.1. リリースコミットが自動で書き換えるもの

[CHANGELOG.md](../CHANGELOG.md) は英日1ファイルです。各項目を `- (EN)` と `- (JA)` の2行で書き、作業中は `## Unreleased` の下に積んでいきます。**手でやるのはここだけです。**

あとは `npm version` が `scripts/sync-version.js` を走らせ、**タグが乗るのと同じコミットの中で**、それらの項目を `## <version>` の見出しの下に移し、空の `## Unreleased` を開き直し、`src/index.js` の `VERSION` 定数を更新し、README（英日）・`docs/`・`examples/` の `esp-flashjs@<version>` をすべて書き換えます。

最後のものは以前チェックリストと `grep` に任せていました。つまり**ずれていました**。README のとおりに試した人が、前の版のコードを読み込むことになります。

**ローカルで行い、GitHub Actions にはしません。** Actions はタグ push で発火します。つまり**コミットができた後**なので、そこで書き換えたものはタグが指すコミットより後に入ります。しかも Pages は `main` から出るので、その間だけ古い版を案内するサイトが公開されます。

### 推測せずに拒否するもの

| 検査 | 場所 | 止めるもの |
| --- | --- | --- |
| `scripts/check-releasable.js` | `preversion` | `## Unreleased` が空のままリリースすること。**npm がバージョンを上げる前**に走るので、失敗しても作業ツリーは元のままです。npm は `version` フックが失敗してもバージョンを戻さないため、1つ後ろで気づくと手で戻す羽目になります |
| `the changelog keeps its shape` | `npm run check` | バージョン番号だけになっていない見出し、タグの無い箇条書き、英日の項目数が食い違っている節 |
| `no documented version pin is out of date` | `npm run check` | リポジトリ内のどこかにある `esp-flashjs@<version>` が `package.json` と食い違っていること。**スクリプトが知らないファイルに書かれた CDN URL** はこれで捕まります |

スクリプトは書き込む前に全編集を先に確定させます。以前の版は README を書き換えてから変更履歴で例外を投げ、**リリースされていないバージョン番号が書かれたツリー**を残しました。

内容が読む価値のあるものかどうかは、どれも判断できません。そこは [3](#3-リリース前に手で見ておくこと) です。

**例示のバージョンは pin に見えてはいけません。** 「リポジトリ内の `esp-flashjs@<version>` はすべて現行リリースを指す」という規則なので、例示は `esp-flashjs@<broken>` のように書き、過去への言及はパッケージ名を付けずに書きます（`esp-flashjs@1.0.0` ではなく「0.1.0 はテストリリース」）。

変更履歴に日付は書きません。タグにもあり npm にもあるものを、手で維持する3つ目のコピーとして持つ理由がありません。

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
- [ ] `## Unreleased` の内容が**コミット件名の羅列ではなく、利用者が知りたいこと**になっている。機械的な部分は [1.1](#11-リリースコミットが自動で書き換えるもの) が処理する
- [ ] 前回のリリースで**間違っていたこと**を「修正」に丸めず明記する。旧版を使っている人には、そもそも動いたのかどうかが要る情報
- [ ] README（英日）の**対応チップ表**を更新した（実機で確認できたものだけ「済」にする）
- [ ] README の Phase 進捗が実態と合っている
- [ ] 破壊的変更があれば README に書いた
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

GitHub Release（Releases → Draft a new release）はタグを選んで手で書きます。書くとよいこと: 追加機能、**破壊的変更**（1.0.0 以降は major になるが、それでも目立たせる）、修正したバグ、実機検証が進んだチップ。

---

## 5. 困ったとき

**`404 Not Found - PUT https://registry.npmjs.org/esp-flashjs`**

ログインが切れています。npm は**認証できない publish を 401 ではなく 404 で返します**。権限の無い相手にパッケージの存在有無を教えないためですが、そのせいで**実際にいちばん遭遇するエラーが、まったく別のエラーに見えます**。`~/.npmrc` の `_authToken` は残ったままで、受け付けられなくなっているだけです。

```sh
npm whoami                     # ここで 401 なら確定。名前ではなくトークンの問題
npm login                      # 認証アプリの 6 桁を入力
npm whoami                     # 名前が返れば通っている
npm publish --access public
```

**この時点で `npm version` は完了しています。** コミットもタグもできており、失敗したのは publish だけです。**もう一度 `npm version` を走らせないでください。** バージョン番号を無駄に1つ消費します。

`npm login` が成功しても 404 が続く場合は、そのアカウントがパッケージの所有者か確認します。

```sh
npm owner ls esp-flashjs
```

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
npm deprecate esp-flashjs@<broken> "Broken flash read; use <fixed> or later"
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

## 7. 初回だけの準備（完了済み）

**v0.1.0 は 2026-08-16 に公開済みです**（<https://www.npmjs.com/package/esp-flashjs>）。以下は記録であり、再度行う必要はありません。

1. `npm view esp-flashjs` が 404（名前が空いている）ことを確認する。誰かが取っていたら名前を決め直し、`package.json` の `name`、README の import 例、CDN URL をすべて更新する
2. `npm login` でこのマシンを npm アカウントに紐付ける
3. npm アカウントの 2FA（認証アプリ）を有効化する — 現在の npm は「2FA または 2FA バイパス付きトークン」なしでは publish できない
4. **Settings → Pages → Source** を「GitHub Actions」に変更する（既定のままだと、ワークフローは成功するのに何も公開されない）
5. 初回は [8 章](#8-初回リリースだけの例外記録)の手順で公開した（`package.json` に既に初期バージョンが入っていたため、通常の 3 行が使えなかった）

---

## 8. 初回リリースだけの例外（記録）

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
