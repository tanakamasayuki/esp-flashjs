# Analyzer の書き方

[English](./analyzers.md) · **日本語**

Analyzer は、あるバイナリ形式を ESP FlashJS に認識・記述させるための部品です。パーティションテーブル、ファームウェアイメージ、OTA データ、NVS、SPIFFS、LittleFS、FAT のぶんは同梱してあります。それ以外 — ベンダ固有のプロビジョニング領域、設定領域、独自ログ — は、実行時に登録するプラグインとして書けます。

このページはその書き方です。型定義は [spec.ja.md §9](./spec.ja.md#9-binary-analyzer-とプラグイン) にあります。

---

## 形

```js
import { registerAnalyzer } from 'esp-flashjs/core';

registerAnalyzer({
  id: 'my-format',
  name: 'My Format',
  detect(data, ctx) { return { confidence: 0.0 }; },
  analyze(data, ctx) { return { /* AnalysisResult */ }; },
});
```

`detect` は「これは自分のものか、どれくらい確信があるか」に答えます。`analyze` は勝った1つだけが呼ばれ、UI が描画する記述を返します。どちらも同じ `ctx` を受け取ります（`{ offset?, partition?, flashSize? }`）。`partition` は、データの出どころがパーティションテーブル上のどのエントリか分かっている場合に入ります。

---

## 実例

デバイスがプロビジョニング記録を持っているとします。8バイトのマジック、バージョン、長さ、そして UTF-8 の JSON 本体という構成です。

```js
import { registerAnalyzer } from 'esp-flashjs/core';

const MAGIC = 'PROVCFG1';

/** @param {Uint8Array} data */
function hasMagic(data) {
  if (data.length < 16) return false;
  for (let i = 0; i < MAGIC.length; i++) {
    if (data[i] !== MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

registerAnalyzer({
  id: 'provcfg',
  name: 'Provisioning Config',

  detect(data) {
    if (!hasMagic(data)) return { confidence: 0 };
    const length = new DataView(data.buffer, data.byteOffset).getUint32(12, true);
    // マジックがあり長さも収まっているなら強い証拠。長さが領域からはみ出す
    // 場合は「偶然の一致」ではなく「壊れた記録」なので、一致ではあるが確信度
    // は下げる。
    return length + 16 <= data.length
      ? { confidence: 0.9, reasonCode: 'magicAndLength' }
      : { confidence: 0.5, reasonCode: 'lengthOverruns' };
  },

  analyze(data) {
    const view = new DataView(data.buffer, data.byteOffset);
    const version = view.getUint32(8, true);
    const length = view.getUint32(12, true);
    const issues = [];

    const available = Math.min(length, data.length - 16);
    if (available < length) {
      issues.push({
        level: 'error',
        code: 'provcfg.truncated',
        params: { declared: length, available },
      });
    }

    let payload = null;
    try {
      payload = JSON.parse(new TextDecoder().decode(data.subarray(16, 16 + available)));
    } catch (error) {
      issues.push({ level: 'error', code: 'provcfg.badJson', params: { message: String(error) } });
    }

    return {
      type: 'provcfg',
      confidence: available === length ? 0.9 : 0.5,
      metadata: { version, length, keys: payload ? Object.keys(payload).length : 0 },
      regions: [
        { offset: 0, length: 16, label: 'Header', kind: 'header' },
        { offset: 16, length: available, label: 'JSON payload', kind: 'data' },
      ],
      issues,
      model: payload,
    };
  },
});
```

登録するだけで済みます。以降 `analyzeBinary` が拾うようになり、Web アプリでも自分のコードでも同じように効きます。

---

## 自明でないルール

### `detect` は軽くする

登録された全 analyzer に対して、全バッファで走ります。数MBのバッファも含みます。マジックを見る、長さを見る、ヘッダをつまむ。**領域全体を解析できるかを判断するために領域全体を解析してはいけません。**

マジックを持たない形式（SPIFFS と NVS がそうです）は `ctx.partition.subtypeName` に頼り、フォールバックは既定設定1つでの解析にとどめてください。総当たりは禁物です。

### `detect` で例外を投げない

例外を投げた detector はスキップされ、走査は続きます。ただしそれに頼るのはバグです。例外は判断ではありませんし、**低い確信度を返す**という、しばしば最も誠実な選択肢を捨てることになります。

### 消去済みフラッシュを掴まない

これは同梱の analyzer が実際に踏みました。テーブルから見れば、真っ白な `nvs` パーティションも `nvs` パーティションです。サブタイプヒントに頼る analyzer は `0xFF` だらけの領域を平気で掴み、「ファイル0件のファイルシステム」と報告します。こうなると「空」と「一度もフォーマットされていない」が見分けられません。そして機器が動いているのは片方だけです。

```js
detect(data, ctx) {
  if (isUniform(data, 0xff) || isUniform(data, 0x00)) return { confidence: 0 };
  ...
}
```

`raw` analyzer に譲ってください。`contents: 'erased'` と報告され、そちらが真実です。

### 確信度は「証拠」の主張であって「労力」の主張ではない

| 値 | 意味すべきこと |
| --- | --- |
| 1.0 | マジック**と**チェックサム／ハッシュの両方が検証できた |
| 0.8〜0.95 | マジックが一致した。またはパーティションの subtype がそう言っており、構造もそれと矛盾しない |
| 0.5 | マジックは一致するが矛盾がある。あるいは構造は合うが、裏付けるものが無い |
| 0.3〜0.4 | 推測のみ。それらしいヘッダがあるだけ |
| 0.0 | 自分のものではない |

0.3 未満なら `raw` が勝ちます。推測に対してはそれが正しい結果です。自分の analyzer を勝たせるために確信度を盛っても正しくはなりません。**間違った答えが気づかれにくくなるだけです。**

同梱の analyzer は、パーティションの subtype を単なる推測ではなく 0.8〜0.9 の帯に置いています。テーブルは「その領域が何を保持するはずか」についての強い主張だからです。とはいえバイト列についての証明ではないので、subtype だけで識別されるものは 1.0 に届きません。`nvs` が 0.9 で止まるのは、NVS の形式自体に自分を名乗る要素が無いためです。

### 問題は投げずに報告する

`analyze` が呼ばれる時点で、検出はすでにあなたの analyzer に決まっています。ここで例外を投げると、**解析できた部分まで含めて全部失われます**。`issues` を埋め、手元にあるものを返してください。該当するなら `complete: false` や確信度を下げる形で。問題を明示した部分的な答えのほうが、例外より役に立ちます。相手はたいてい、すでに壊れた機器を見ているのですから。

### regions は hex ビュー用

`BinaryRegion` のオフセットは、`analyze` に渡されたバッファ基準です。元のフラッシュアドレスではありません。これを出すと hex ビューアが構造にラベルを付けて強調できます。ただし数千個出しても誰も嬉しくないので、長いリストは打ち切ってください（同梱のファイルシステム analyzer は 512 ファイルで止めます）。

---

## Analyzer のテスト

いちばん重要なルールは [開発ガイド](./development.ja.md#33-fixture-は2種類ありそれぞれ嘘をつく条件が違う) にあるとおりです。

> このプロジェクトが考案していない形式のパーサには、このプロジェクトが生成していないバイト列に対して走るテストを最低1つ置く。

自分の writer が作ったイメージだけでテストした analyzer は、正しかろうが間違っていようが自分自身と一致します。このプロジェクトの形式バグは、すべてこの理由で完全なテストスイートを素通りしました。

加えて、どの analyzer でも書く価値のある検査が2つあります。

```js
// 自分の領域を他が掴まないこと
assert.deepEqual(detectFormat(myData, {}).filter((c) => c.id !== 'provcfg'), []);

// 他人の領域を自分が掴まないこと
for (const other of [nvsImage, spiffsImage, fatImage, erasedFlash]) {
  assert.equal(detect(other, {}).confidence, 0);
}
```

誤検出は、見ただけでは間違いと分かりません。あるファイルシステムを別のファイルシステムと誤認しても、それらしいファイル一覧が出てきます。

---

## 解除と一覧

```js
unregisterAnalyzer('provcfg');
listAnalyzers();  // -> [{ id, name }, …]
```

`analyzeBinaryAs('provcfg', data, ctx)` は検出結果に関わらず特定の analyzer を強制します。Web アプリの形式セレクタがこれを使っています。勝てなかった領域を自分の analyzer がどう見ているか確かめるのにも、これがいちばん手早い方法です。
