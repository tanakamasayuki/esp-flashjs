# esp-flashjs の使い方

[English](./guide.md) · **日本語**

`.bin` ファイルを開くところから、実機の NVS を編集するところまでを、作業単位で説明します。各節は「短い答え」から始めて、そのあとに内部で何が起きているかを説明します。ESP32 のツールを触るのが初めてでも、5つ目でも読めるようにしたつもりです。

設計の根拠は [spec.ja.md](./spec.ja.md)、エクスポートの一覧は [api.ja.md](./api.ja.md)、動かないときは [troubleshooting.ja.md](./troubleshooting.ja.md) を参照してください。

---

## 目次

1. [どちらの import を使うか](#1-どちらの-import-を使うか)
2. [実機なしで始める](#2-実機なしで始める)
3. [ボードに接続する](#3-ボードに接続する)
4. [フラッシュを読む](#4-フラッシュを読む)
5. [パーティションテーブル](#5-パーティションテーブル)
6. [NVS: 読む・編集する・書き戻す](#6-nvs-読む編集する書き戻す)
7. [ファイルシステム: SPIFFS / LittleFS / FAT](#7-ファイルシステム-spiffs-littlefs-fat)
   - [編集と再構築](#編集と再構築)
8. [安全に書き込む](#8-安全に書き込む)
9. [進捗とキャンセル](#9-進捗とキャンセル)
10. [エラー](#10-エラー)
11. [速くする](#11-速くする)
12. [ブラウザ以外で使う](#12-ブラウザ以外で使う)

---

## 1. どちらの import を使うか

入口は2つあり、どちらを選ぶかは見た目以上に重要です。

```js
// すべて。Web Serial を含む。ブラウザが必要。
import { EspFlash, EspLoader, WebSerialTransport } from 'esp-flashjs';

// パーサとバイトユーティリティのみ。シリアル関連を含まない。どこでも動く。
import { analyzeBinary, parseNvs, parseSpiffs } from 'esp-flashjs/core';
```

`esp-flashjs/core` は `Uint8Array` に対する純粋な計算だけです。デバイスの存在を知らないので、Node でも Worker でもサーバーでも動きます。**ファイルを解析するだけならこちら**です。小さく、ブラウザ API に手を伸ばすことが原理的にありません。

フル版はこれに Transport、ブートローダプロトコル、その上のフラッシュ操作を足したものです。`core` の中身はすべて再エクスポートされているので、両方を import する必要はありません。

> **どちらもランタイム依存ゼロです。** これは意図的で、ビルド無しの `<script type="module">` から直接動く理由でもあります。

---

## 2. 実機なしで始める

このライブラリが何をするか理解する最短路は、ファイルを渡してみることです。フラッシュダンプ、パーティションテーブル、NVS パーティション、ファームウェアイメージのいずれを `analyzeBinary` に渡しても、それが何かを判定します。

```js
import { analyzeBinary } from 'esp-flashjs/core';

const bytes = new Uint8Array(await file.arrayBuffer());
const result = analyzeBinary(bytes);

console.log(result.type);        // 'partition-table' | 'esp-image' | 'nvs' |
                                 // 'spiffs' | 'littlefs' | 'fat' | 'otadata' |
                                 // 'raw' | 'encrypted?'
console.log(result.confidence);  // 0.0 〜 1.0
console.log(result.metadata);    // 形式ごとの要約
console.log(result.regions);     // バイト範囲。hex ビューの強調表示用
console.log(result.issues);      // 見つかった問題。安定したコードで返る
console.log(result.model);       // 解析済みモデル（その形式にあれば）
```

**解析は壊れた入力でも例外を投げません。** 問題は `issues` で返し、解析できた部分はそのまま返します。**壊れたイメージこそ、いちばん見たいものだから**です。

### 分かっている情報は渡す

そのバイト列がどのパーティションから来たか分かっているなら、伝えてください。NVS や SPIFFS のように**自分を示すマジックを持たない形式**があり、パーティションのサブタイプが「認識できる」と「当てずっぽう」の分かれ目になります。

```js
const table = parsePartitionTable(tableBytes);
const nvsPartition = findPartitionByLabel(table.partitions, 'nvs');

const result = analyzeBinary(nvsBytes, {
  partition: nvsPartition,
  offset: nvsPartition.offset,
  flashEncryptionEnabled: false,   // 分かっていれば。spec.ja.md §9.4 参照
});
```

### 形式を強制する

判定結果に納得がいかないとき、あるいは「勝てなかった領域を自分の analyzer がどう見るか」を確かめたいとき:

```js
import { analyzeBinaryAs, listAnalyzers } from 'esp-flashjs/core';

console.log(listAnalyzers());                     // [{ id, name }, …]
const forced = analyzeBinaryAs('nvs', bytes, {});
```

---

## 3. ボードに接続する

ブラウザでは Web Serial 経由でデバイスに到達します。3つの条件があり、**3つとも引っかかる人がいます**。

- **セキュアコンテキスト**でのみ動きます。HTTPS か `localhost`。`file://` は不可
- ポート選択ダイアログは**ユーザー操作の中でしか開きません**。クリックハンドラ内で呼ぶ必要があります
- デスクトップの Chromium 系のみです。Firefox と Safari は未実装で、モバイル Chrome も同様です

```js
import { EspFlash, EspLoader, WebSerialTransport } from 'esp-flashjs';

button.addEventListener('click', async () => {
  if (!WebSerialTransport.isSupported()) {
    // 後で無関係に見える失敗をするより、ここで明言する。
    return showMessage('このブラウザはシリアルデバイスに接続できません。');
  }

  const transport = await WebSerialTransport.request();   // 選択ダイアログ
  const loader = new EspLoader(transport);

  await loader.connect();        // リセット → 同期 → チップ判定
  console.log(loader.chip?.name); // 'ESP32-S3'

  const ok = await loader.loadStub();
  if (!ok) console.warn('stub 無しで動作中: 読み出しはできません。');

  const flash = new EspFlash(loader);
  const info = await flash.getInfo();
  console.log(info.chip, info.mac, info.flashSize);

  await loader.disconnect();     // リセットしてアプリを起動させる
});
```

### 読み出しに stub は必須です

プロトコルについて知っておくべきことの筆頭です。

**ESP32 の ROM ブートローダには `READ_FLASH` コマンドがありません。** `ERASE_FLASH` も `ERASE_REGION` もありません。フラッシュの読み出し、ダンプ、パーティション読み出し、NVS 解析 — 読み取り側はすべて、**flasher stub** という小さなプログラムをチップの RAM に転送してからでないと動きません。`loadStub()` がそれを行います。

`loadStub()` は失敗時に例外ではなく `false` を返します。stub 無しでも書き込みは可能で、**機能を落とした状態のほうがセッション不成立よりましだから**です。この状態で読み出すと `UnsupportedOperationError`（`code === 'REQUIRES_STUB'`）が飛びます。

> **ブラウザ外では** `loadStub()` は助けが要ります。モジュール隣の URL から stub イメージを取得しますが、Node の `fetch` は `file:` を実装していません。[§12](#12-ブラウザ以外で使う) を参照。

### ボードが応答しない場合

`connect()` は DTR と RTS を操作してチップをブートローダに落とします。多くの開発ボードの自動リセット回路はこれを前提に配線されています。その回路が無いボードや、それらの線を駆動できない Transport では、ユーザーが手で BOOT を押しながら EN を叩く必要があります。

```js
import { canAutoReset } from 'esp-flashjs';

if (!canAutoReset(transport)) {
  showMessage('BOOT を押しながら EN を叩き、BOOT を離してください。');
}
await loader.connect({ autoReset: false });   // リセットを試みない
```

---

## 4. フラッシュを読む

```js
const data = await flash.read(0x8000, 0xc00);   // アドレス、長さ
```

たいていはこれで済みます。うまくいかない場合に備えて、内部を知っておく価値があります。

`READ_FLASH` の1転送は **all-or-nothing** です。stub は範囲全体に対して MD5 を1つ返すので、**どこか1バイト落ちれば全部が破棄されます**。バイトを落とすリンク（長いケーブル、品質の低い USB ブリッジ、仮想マシンのパススルー）では、数MBの読み出しは何度リトライしても完了しません。

そこで `read()` は範囲を分割し、チャンクごとに再試行します。

```js
const data = await flash.read(0x290000, 0x50000, {
  chunkSize: 0x40000,   // 1転送あたりのバイト数。既定 256KB
  attempts: 3,          // チャンクごとの試行回数
  onProgress: ({ done, total }) => console.log(done, '/', total),
  signal: controller.signal,
});
```

読み出しが失敗し続けるなら、**他を触る前にチャンクを小さくしてください。** リンクが運べないサイズを再試行しても通りません。一度に要求する量を減らすことだけが効きます。[troubleshooting.ja.md](./troubleshooting.ja.md#読み出しが失敗する短く返る) を参照。

### チップ全体をダンプする

```js
const image = await flash.dump({ onProgress: (p) => console.log(p.done, p.total) });
```

指定しなければ、チップから取得したサイズで全体を読みます。

### 転送せずに検証する

`verify()` はデバイス側で計算したハッシュで比較するので、読み出し1回分ではなくコマンド1回分のコストで済みます。

```js
const same = await flash.verify(0x10000, expectedBytes);
```

---

## 5. パーティションテーブル

パーティションテーブルは `0x8000` にあり、3KB です。フラッシュ上の他のすべては、ここを経由して見つけます。

```js
import {
  parsePartitionTable,
  findPartitionByLabel,
  describeFlashLayout,
  PARTITION_TABLE_OFFSET,
  PARTITION_TABLE_SIZE,
} from 'esp-flashjs/core';

const raw = await flash.read(PARTITION_TABLE_OFFSET, PARTITION_TABLE_SIZE);
const table = parsePartitionTable(raw);

for (const p of table.partitions) {
  console.log(p.label, p.typeName, p.subtypeName, p.offset, p.size, p.encrypted);
}
console.log(table.md5Valid);   // テーブルは自分のチェックサムを持つ
console.log(table.issues);     // 重なり、magic 不正、境界ずれ…
```

### 隙間を含めたチップ全体を見る

`describeFlashLayout` は、bootloader・テーブル自身・未割り当て領域も含めて、アドレス順に全領域を返します。

```js
const regions = describeFlashLayout(table.partitions, {
  flashSize: info.flashSize,
  bootloaderOffset: info.bootloaderOffset,
});
// [{ kind: 'bootloader' | 'partition-table' | 'partition' | 'unallocated', … }]
```

bootloader とテーブルは、**誤って書き込むとデバイスが起動しなくなる**2領域です。空き領域と一緒くたにせず、名前を付けて返します。

### 各パーティションに実際に何が入っているか

テーブルが示すのはパーティションの**用途**であって、何か書かれているかではありません。`probePartitions` は各領域の先頭セクタだけを読んで分類します。

```js
const states = await flash.probePartitions(table.partitions);
// Map<label, 'erased' | 'zeroed' | 'data' | 'unreadable'>
```

パーティションあたり数KBで「このデバイスは書き込み済みか」に答えられます。数MB読む必要はありません。

---

## 6. NVS: 読む・編集する・書き戻す

NVS は ESP-IDF アプリケーションが設定を保存する場所です。Wi-Fi 認証情報、校正値、カウンタなど。名前空間で区切られたキー・バリューストアです。

### 読む

```js
import { parseNvs } from 'esp-flashjs/core';

const store = parseNvs(await flash.read(0x9000, 0x5000));

console.log(store.namespaces);            // ['blobs', 'many', 'types']
for (const entry of store.entries) {
  console.log(entry.namespace, entry.key, entry.type, entry.value);
}
console.log(store.get('wifi', 'ssid')?.value);
console.log(store.list('wifi'));
```

値は保存された型で返ります。8/16/32ビット整数は `number`、64ビットは `bigint`、`STR` は `string`、`BLOB` は `Uint8Array` です。

### 消去済みエントリはノイズではありません

```js
console.log(store.erasedEntries);   // 上書き・削除済み。フラッシュ上には残っている
```

NVS はその場を上書きしません。値の変更は新しいエントリを書いて古い方を消去済みに印を付けるだけ、削除は印を付けるだけです。この残骸は GC がページを回収するまで残り、**そのデバイスが実際に使われた証拠**になります。これを隠すツールは、使用済みのパーティションを新品同然に見せてしまいます。

### 編集する

編集はオーバーレイとして保持されます。解析したイメージには手を触れないので、取り消しは再読み出しではなく破棄で済み、**書き込みが何を変えるか**をいつでも問い合わせられます。

```js
store.set('wifi', 'ssid', 'lab-network', 'STR');
store.set('wifi', 'retries', 3, 'U32');
store.delete('wifi', 'old_key');
store.rename('wifi', 'psk', 'password');
store.addNamespace('calibration');

console.log(store.isDirty);     // true
console.log(store.changes());   // [{ kind, namespace, key, before, after, … }]

store.reset();                  // すべて破棄
```

**型は必ず明示してください。** 推論はスクリプトからの編集を可能にするために存在しますが、JavaScript の値から NVS の型への対応は曖昧で、UI がユーザーの代わりに推測してよいものではありません。

### 書き戻す

```js
import { buildNvs } from 'esp-flashjs/core';

const image = buildNvs(store, { size: partition.size });
await flash.write(partition.offset, image);
```

`buildNvs` は**返す前に自分の出力を読み直し、ストアと突き合わせます**。表現できない値や、読み戻せないイメージは、**デバイスに触れる前に**失敗します。書き込みの途中で失敗するのが最悪で、その状態はシリアルケーブル無しでは誰も復旧できません。

また、切り詰めるのではなく拒否します。収まらなければ `NvsCapacityError` を投げ、`details` に必要だった容量が入ります。

> **1ページは常に空けます。** NVS は GC の書き込み先が必要で、全ページを使ったイメージはデバイスを「何も書けない」状態にします。ここは節約できません。これを守らずに作った fixture は、初回起動時に GC が走って**消去済みエントリを静かに失いました**。

### 2つのイメージを比較する

```js
import { diffNvs, summarizeNvsDiff } from 'esp-flashjs/core';

const changes = diffNvs(parseNvs(backup), parseNvs(current));
console.log(summarizeNvsDiff(changes));  // { added, modified, deleted, renamed, total }
```

`diffNvs` は「削除」と「同一内容の追加」を対にしてリネームとして報告します。両方を別々に見たい場合は `{ detectRenames: false }` を渡してください。

---

## 7. ファイルシステム: SPIFFS / LittleFS / FAT

3形式とも同じ型を返すので、一覧や取り出しをするコードは**どの形式を見ているか知る必要がありません**。

```js
import { parseSpiffs, parseLittlefs, parseFat } from 'esp-flashjs/core';

const image = parseSpiffs(bytes);     // parseLittlefs / parseFat も同様

console.log(image.type);      // 'spiffs' | 'littlefs' | 'fat'
console.log(image.geometry);  // 形式ごと。ユーザーに見せる価値がある
console.log(image.issues);

for (const file of image.files) {
  if (file.directory) continue;
  console.log(file.path, file.size, file.complete);
  const contents = file.read();       // 遅延評価
}
```

`read()` が遅延なのは意図的です。320KB のイメージが1ページごとにファイルを持つこともあり、一覧を描くためだけに全部デコードするのは誰も頼んでいない仕事です。

### `complete: false` は重要です

デバイスから読んだ領域はページが欠けていることがあります。残った分から組み立てたファイルも取り出す価値はあります（欠落はゼロとして読めます）が、**完全なものと取り違えてはいけません**。表示を変えてください。

### どのパーサを使うか、そして各形式の落とし穴

パーティションのサブタイプで選ぶか、`analyzeBinary` に任せてください。そのうえで:

**SPIFFS** はジオメトリを自分では記録しないため、ページサイズとブロックサイズを推定します。`parseSpiffs` は候補を「**見つかったファイルが整合しているか**」で採点します。「何個見つかったか」ではありません。正しい値の約数である誤ったジオメトリは、**正しいファイル名を全部見つけたうえで中身だけを壊します**。`image.geometry` を表示し、ユーザーが上書きできるようにしてください。

```js
parseSpiffs(bytes, { pageSize: 256, blockSize: 4096, detectGeometry: false });
```

**LittleFS** はスーパーブロックにジオメトリを持つので、推測は不要です。

**FAT** は ESP-IDF では wear levelling 層の下にあり、1セクタが予備として飛ばされます。`parseFat` はその位置を自動判定します。無視すると**ブートセクタは完璧に解析したうえで、ルートディレクトリの位置から FAT テーブルを読む**ことになり、FAT の中身を名前にしたファイルが1件出てきます。

### 編集と再構築

コピーを取り、変更し、新しいイメージを組み立てます。

```js
import { parseLittlefs, FsStore, buildFs, checkFsStore } from 'esp-flashjs/core';

const store = FsStore.from(parseLittlefs(bytes));

store.write('/config.json', JSON.stringify({ mode: 'field' }));  // 追加または置換
store.delete('/logs');                                           // 配下ごと
store.rename('/old.bin', '/archive/old.bin');

for (const issue of checkFsStore(store)) console.warn(issue.code, issue.params);

const rebuilt = buildFs(store, { size: bytes.length, source: bytes });
```

`FsStore.from` は全ファイルを先に読みます。それが狙いです。1ファイル変わった時点でイメージ内の全オフセットが動くので、遅延させる意味がもう無いからです。

**`buildFs` は切り詰めずに例外を投げます。** 入り切らなければ `FsCapacityError`（ページ／ブロック／クラスタ単位で報告します。**実際に足りなくなった単位はそれ**だからです）、そもそも保存できないパスなら `FsPathError`。返す前に自分の出力を読み直して突き合わせるので、**デバイスに手を付ける前に**失敗します。

実機に書き込む前に知っておくことが4つあります。

- **FAT では `source` が必須です。** パーティション末尾に wear levelling 層自身の状態（チップが乱数で決めたデバイスIDを含む）があり、これは再生成できず、引き継ぐことしかできません
- **再構築はコンパクションでもあります。** 削除済みページ、上書きされたエントリ、LittleFS ログの履歴は全部消えます。**同じファイルを持つ別のバイト列**になるので、元イメージと diff して無差分を期待しないでください
- **先に `store.incomplete` を見てください。** 一部しか復元できなかったファイルは欠損部分がゼロとして読め、再構築するとそのゼロが書き込まれます。`checkFsStore` は `fs.rebuildIncomplete` として報告します。エラーではなく警告なのは、それが望みどおりである場合もあるからです
- **書き込む先の形式に存在できないものがあります。** SPIFFS にディレクトリはなく `/sub/nested.txt` は15バイトの1個の名前です。したがって**空ディレクトリは存在のしようがなく**、31バイトを超えるパスはそもそも保存できません。`checkFsStore` はどちらも構築前に指摘します

更新日時は保存されません。SPIFFS は名前の隣に、ESP-IDF の LittleFS はユーザ属性として持っていますが、store がどちらも運びません。

あとは他のパーティションと同じように書き込みます（[§8](#8-安全に書き込む)）。

```js
await flash.write(partition.offset, rebuilt, { verify: true });
```

正直に書いておくべき留保が1つあります。上記はすべて**結果を読み戻して**確認しています。SPIFFS と LittleFS については、その読み戻しはパーサとは意図的に別経路です（オブジェクトインデックス経由、およびブロックアロケータが辿る tail チェーン）。同じ理解から書かれた builder と parser は、その理解が間違っていても互いに一致するからです。しかしそれでも「**デバイスが実際にマウントするか**」は証明できません。そこが重要なら、このリポジトリの `tools/hardware-check.mjs --rebuild` が実機に対して一連の流れを実行し、チップ自身のドライバが何を見つけたかを読み取ります。

---

## 8. 安全に書き込む

フラッシュへの書き込みは、デバイスを起動不能にし得る唯一の操作です。ライブラリは部品を提供します。**順序はあなた次第で、順序が重要です。**

```js
// 1. 先にバックアップし、失敗したら中止する。
const original = await flash.read(partition.offset, partition.size);
saveToDisk(original);

// 2. 消去する前に、新しいイメージを構築して検証する。
const image = buildNvs(store, { size: partition.size });

// 3. ユーザーに確認する（危険な領域については下記）。
if (!(await confirmWithUser(partition))) return;

// 4. 書いて、検証する。
await flash.write(partition.offset, image, { verify: true });
```

`write()` は該当セクタを消去してから書き込みます。`CompressionStream` が使える環境では圧縮して転送します。`{ verify: true }` で書き込み後にハッシュを比較します。

### どの領域が危険か

UI が「どこかのパーティション」と区別して扱うべき3つです。

- **`0x9000` 未満**は bootloader とパーティションテーブルです。ここでの失敗はデータの破損ではなく、**チップがまったく起動しなくなる**ことを意味します
- **`app` パーティション**はファームウェアです。実行中の側を上書きすると、シリアル経由でしか復旧できません
- **`ota` / `nvs_keys` / `efuse` サブタイプ**は、何を起動するかの判断や、保存内容の復号にデバイスが必要とする状態です

リファレンスアプリはこれを使って、続行前にパーティション名の入力を求めるかどうかを決めています（`web/actions.js` の `assessRisk`）。

### 消去する

```js
await flash.eraseRegion(partition.offset, partition.size);
await flash.eraseAll();     // チップ全体
```

どちらも stub が必要です。`eraseRegion` は 4KB 境界を要求し、外れていれば `AlignmentError` を投げます。**隣を黙って消すよりましだから**です。

---

## 9. 進捗とキャンセル

長い操作はすべて `onProgress` と `signal` を受け取ります。

```js
const controller = new AbortController();
cancelButton.onclick = () => controller.abort();

await flash.dump({
  signal: controller.signal,
  onProgress: ({ phase, done, total, bytesPerSecond }) => {
    bar.value = done / total;
    label.textContent = `${phase} ${done}/${total} (${bytesPerSecond} B/s)`;
  },
});
```

中断すると `OperationAbortedError` が飛びます。**書き込みや消去を中断した後のフラッシュ内容は未定義です。** 操作は途中で止まっており、その領域を書き直すまで定義された状態には戻りません。この事実はエラーメッセージに含めてあるので、ログに残ります。

---

## 10. エラー

すべてのエラーは安定した `code` と `details` を持ちます。`message` は英語で開発者向けです。**ライブラリはユーザー向けの文章を一切作りません。** これがアプリケーション側で表現を翻訳できる理由です。

```js
try {
  await flash.read(0, 1024);
} catch (error) {
  switch (error.code) {
    case 'REQUIRES_STUB':      /* ROM では読めない。stub を読み込む */ break;
    case 'TRANSPORT_TIMEOUT':  /* デバイスが応答しなくなった */ break;
    case 'OUT_OF_RANGE':       /* フラッシュ末尾を超えた */ break;
    case 'CHECKSUM_MISMATCH':  /* 届いたものが送られたものと違う */ break;
    default: throw error;
  }
}
```

クラスもエクスポートしているので `instanceof` も使えます。`TransportTimeoutError`、`ChecksumError`、`UnsupportedOperationError`、`NvsCapacityError`、`OperationAbortedError` などの一覧は [api.ja.md](./api.ja.md) にあります。

**パーサは壊れたデータで例外を投げません。** 読めた分を返し、残りを `issues` で説明します。各 issue も `code` と `level` を持ちます。

---

## 11. 速くする

すべては 115200 baud から始まります。すべてのチップがこの速度で応答するからです。stub が起動した後に上げると、大きな読み出しが数倍速くなります。

```js
await loader.loadStub();
await loader.changeBaudRate(921600);
```

**速いほうが確実とは限らず、しかも単調ではありません。** ある CH340 ボードでの実測では、256KB の読み出し4回のうち 115200 は2回成功、460800 は4回成功でした。**遅いほうが不確実かつ遅い**という結果です。別のボードでは 921600 が全滅し 1500000 が通りました。

つまり、速度は**仮定するものではなく測るもの**で、信用する前に検証すべきものです。stub はすべての読み出しを自分の MD5 で覆うので、リンクが運べない速度は**静かな破損ではなく例外**になります。だから試すこと自体は安全です。

```js
await loader.changeBaudRate(rate);
try {
  await flash.read(0, 0x1000, { attempts: 1 });   // 意図的に1回だけ
} catch {
  await loader.changeBaudRate(115200);            // 通っていた速度に戻す
}
```

どの速度が通るかは外からは分かりません。シリアルポートがブリッジ用ファームウェアを載せたマイコンであるボード — たとえば M5 ATOM の CH552 — は実装済みの固定の値しか受け付けず、**921600 は使えない一方で 250000・500000・750000・1500000 は通ります**。リファレンスアプリが両系統を提示しているのはこのためです。

---

## 12. ブラウザ以外で使う

Node 版の Transport は同梱していません。これは欠落ではなく判断です。Node にシリアル API が無いので、同梱すれば native 依存となり、**全利用者がその代償を払う**ことになります。`Transport` インターフェースは5メソッドで、[transports.ja.md](./transports.ja.md) に貼り付けられる完全な Node 実装があります。

試した人が全員つまずく点が2つあります。

**stub が取得できません。** `loadStub()` はモジュール隣の URL を `fetch()` に渡しますが、Node の fetch は `file:` を実装していません。自分でイメージを登録してください。

```js
import { registerStub } from 'esp-flashjs';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('./node_modules/esp-flashjs/dist/stub/', import.meta.url);
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  registerStub(file.replace(/\.json$/, ''), JSON.parse(readFileSync(new URL(file, dir), 'utf8')));
}
```

チップ名のリストではなく、**ディレクトリ内の全ファイル**を登録してください。シリコンリビジョンごとに別の stub が要るチップがあり（v3.0 未満の ESP32-P4 がそうです）、手で管理するリストはそれを取りこぼします。症状は「原因不明の stub 失敗」です。

**読み出しとタイムアウトを競走させてはいけません。** 下層の read とタイマーを競走させる Transport は、タイマーが勝ったときに**進行中のチャンクを放棄**するので、以降のフレームが1つずつずれます。バックグラウンドポンプを使ってください。`transports.ja.md` に説明があり、`src/transport/web-serial.js` が実装例です。

自分の環境を確認するには `tools/hardware-check.mjs` が使えます。ライブラリを実機に対して走らせ、esptool のキャプチャと突き合わせます。

---

## 次に読むもの

| やりたいこと | 参照先 |
| --- | --- |
| エクスポートの一覧 | [api.ja.md](./api.ja.md) |
| 動かないものを動かす | [troubleshooting.ja.md](./troubleshooting.ja.md) |
| 未対応の形式に対応させる | [analyzers.ja.md](./analyzers.ja.md) |
| 別の方法でデバイスに到達する | [transports.ja.md](./transports.ja.md) |
| なぜその設計なのかを知る | [spec.ja.md](./spec.ja.md) |
| ライブラリ自体を変更する | [development.ja.md](./development.ja.md) |
