# ドキュメント

[English](./README.md) · **日本語**

| 文書 | 内容 | 主な読み手 |
| --- | --- | --- |
| [guide.ja.md](./guide.ja.md) | **ここから。** ファイルを開くところから実機の NVS 編集まで、作業単位で | 全員 |
| [api.ja.md](./api.ja.md) | 全エクスポートを用途別に | 全員 |
| [troubleshooting.ja.md](./troubleshooting.ja.md) | 症状別。それが何を意味するか | 全員 |
| [spec.ja.md](./spec.ja.md) | 仕様書。設計判断、プロトコル、各フォーマットの構造、安全機構 | 実装者 |
| [development.ja.md](./development.ja.md) | 開発ガイド。セットアップ、テストの書き方と走らせ方、実機での手動テスト | コントリビュータ |
| [analyzers.ja.md](./analyzers.ja.md) | Analyzer プラグインの書き方 |
| [transports.ja.md](./transports.ja.md) | Transport の書き方（Node.js・WebUSB など） |
| [ci.ja.md](./ci.ja.md) | GitHub Actions の説明。3 本のワークフロー、必要な設定、失敗時の読み方 | コントリビュータ、メンテナ |
| [release.ja.md](./release.ja.md) | リリース手順。バージョニング、npm 公開、間違えたときの対処 | メンテナ |
| [publishing.ja.md](./publishing.ja.md) | 配布方法の決定。npm / CDN / Pages の構成と、その理由 | メンテナ |

全文書に英語版があり、`.ja.md` を外したファイル名で置いてあります。各ページ冒頭のリンクから行き来できます。

公開先:

| | |
| --- | --- |
| Web アプリ | <https://tanakamasayuki.github.io/esp-flashjs/> |
| npm | <https://www.npmjs.com/package/esp-flashjs> |

## どこから読むか

**使いたいだけ** — [README](../README.ja.md) で足ります。

**手を入れたい** — [development.ja.md](./development.ja.md) → [spec.ja.md](./spec.ja.md) の関係する章。

**なぜこうなっているのか知りたい** — [spec.ja.md の §3「主要な設計判断」](./spec.ja.md#3-主要な設計判断)に、判断とその理由を並べてあります。

**リリースする** — [release.ja.md](./release.ja.md)。

## 前提として知っておくとよいこと

実装で一番効いている制約は 2 つです。

1. **ROM ブートローダは Flash を読めない。** `READ_FLASH` / `ERASE_FLASH` / `ERASE_REGION` を実装していないため、読み出し系はすべて flasher stub のロードが前提になります（[spec §6.4](./spec.ja.md#64-stub-loader)）。
2. **ライブラリはユーザー向けの文言を持たない。** 安定した `code` と `params` だけを返し、翻訳は `web/locales/` の責務です（[spec §17.8](./spec.ja.md#178-i18n)）。これがあるので、ライブラリを組み込む第三者アプリが自前の文言体系を使えます。
