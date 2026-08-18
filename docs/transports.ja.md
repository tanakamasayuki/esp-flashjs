# Transport の書き方

[English](./transports.md) · **日本語**

Transport はライブラリとデバイスの間のバイトの通り道です。同梱しているのは `WebSerialTransport`、テストが使うのは `MockTransport`。それ以外 — Node.js、WebUSB、遠隔ボードへの TCP ブリッジ、記録したセッションの再生 — は自分で書く40行程度のコードです。

---

## インターフェース

```js
/**
 * @typedef {object} Transport
 * @property {() => Promise<void>} open
 * @property {() => Promise<void>} close
 * @property {() => boolean} isOpen
 * @property {(data: Uint8Array) => Promise<void>} write
 * @property {(options?: {timeoutMs?: number, signal?: AbortSignal}) => Promise<Uint8Array>} read
 * @property {(baudRate: number) => Promise<void>} [setBaudRate]
 * @property {(signals: {dtr?: boolean, rts?: boolean}) => Promise<void>} [setSignals]
 * @property {() => Promise<void>} [flushInput]
 * @property {string} [description]
 */
```

必須は5つ。省略可能な3つは、無くても degrade するだけです。

| 無い場合 | 起きること |
| --- | --- |
| `setSignals` | 自動リセットができない。ユーザーが BOOT を押しながら EN を叩くことになる。`canAutoReset()` がこれを報告するので UI で案内できる |
| `setBaudRate` | 開いたときの速度のまま |
| `flushInput` | 失敗後の復帰が不確実になる。中断した転送の残りバイトが次の応答として解釈されるため |

---

## `read()` は「届いているぶん」を返す。要求した長さではない

長さのパラメータはありません。これは意図的です。SLIP フレームは長さ前置ではなく区切り文字方式なので、**フレーミング層は何バイト要求すべきか原理的に知り得ません**。バッファにあるものを返してください。足りなければ上位のデコーダがもう一度聞きます。

### 間違えやすいところ

**タイムアウトで、進行中の read を捨ててはいけません。** 素朴な実装は、下層の read とタイマーを競走させます。

```js
// 誤り。これをやってはいけない。
async read({ timeoutMs = 3000 } = {}) {
  return Promise.race([
    this.reader.read().then((r) => r.value),
    new Promise((_, reject) => setTimeout(() => reject(new TransportTimeoutError()), timeoutMs)),
  ]);
}
```

タイマーが勝つと `reader.read()` の Promise は放棄されますが、**read 自体はキャンセルされていません**。やがて解決したチャンクは捨てられます。次の呼び出し側はその「次」のチャンクを読むので、以降すべてのフレームが1つずつずれます。

これは机上の懸念ではありません。実際に出荷され、症状は「3機種すべてでチップ検出に失敗する」でした。タイムアウトとの関係が見た目には一切ありません。消えていたのは最初の応答ではなく、2番目の応答でした。

対処は**バックグラウンドポンプ**です。1つのループが継続的にバッファへ読み込み、`read()` は期限つきでバッファを待ちます。こうするとタイムアウトが止めるのは待ち手であって、読み込みではありません。

```js
class MyTransport {
  async open() {
    /* … */
    this.pending = new Uint8Array(0);
    this.pump = this.readLoop();   // ここで await しない
  }

  async readLoop() {
    for (;;) {
      const chunk = await this.source.next();   // デバイスから来るもの
      if (chunk === null) { this.closed = true; this.wake(); return; }
      this.append(chunk);
      this.wake();                              // 待っている read() を起こす
    }
  }

  async read({ timeoutMs = 3000, signal } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.pending.length > 0) {
        const out = this.pending;
        this.pending = new Uint8Array(0);
        return out;
      }
      if (this.closed) throw new TransportClosedError();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TransportTimeoutError(timeoutMs);
      await this.waitForData(remaining, signal);
    }
  }
}
```

`src/transport/web-serial.js` がこの形の完全な実装です。

---

## Node.js

Node 版は同梱していません。これは欠落ではなく判断です。Node にはシリアル API が無いので、実装するには native モジュールである `serialport` への依存が必要になります。このライブラリは**ランタイム依存ゼロ**で、それがビルド無しの `<script type="module">` で動く理由です。パッケージに native 依存が入れば、そのコストを全利用者が払うことになります — `.bin` を解析したいだけの人も含めて。

自分のプロジェクトで書けば40行ほどです。

```js
import { SerialPort } from 'serialport';
import { EspLoader, EspFlash } from 'esp-flashjs';

class NodeSerialTransport {
  constructor(path, baudRate = 115200) {
    this.path = path;
    this.baudRate = baudRate;
    this.port = null;
    this.pending = [];
    this.waiters = [];
  }

  isOpen() { return Boolean(this.port?.isOpen); }
  get description() { return `${this.path} @ ${this.baudRate}`; }

  async open() {
    this.port = new SerialPort({ path: this.path, baudRate: this.baudRate, autoOpen: false });
    await new Promise((res, rej) => this.port.open((e) => (e ? rej(e) : res())));
    // The pump: 'data' fires whenever bytes arrive, independently of read().
    this.port.on('data', (buf) => {
      this.pending.push(new Uint8Array(buf));
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  async close() {
    if (this.port?.isOpen) await new Promise((res) => this.port.close(() => res()));
    this.port = null;
  }

  async write(data) {
    await new Promise((res, rej) => this.port.write(Buffer.from(data), (e) => (e ? rej(e) : res())));
  }

  async read({ timeoutMs = 3000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.pending.length > 0) {
        const total = this.pending.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const c of this.pending.splice(0)) { out.set(c, at); at += c.length; }
        return out;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('transport timeout');
      await new Promise((res) => {
        const timer = setTimeout(res, remaining);
        this.waiters.push(() => { clearTimeout(timer); res(); });
      });
    }
  }

  async setSignals({ dtr, rts }) {
    await new Promise((res, rej) =>
      this.port.set({ dtr: dtr ?? false, rts: rts ?? false }, (e) => (e ? rej(e) : res())));
  }

  async setBaudRate(baudRate) {
    this.baudRate = baudRate;
    await new Promise((res, rej) => this.port.update({ baudRate }, (e) => (e ? rej(e) : res())));
  }

  async flushInput() {
    this.pending.length = 0;
    await new Promise((res) => this.port.flush(() => res()));
  }
}

const loader = new EspLoader(new NodeSerialTransport('/dev/ttyUSB0'));
await loader.connect();
await loader.loadStub();
const info = await new EspFlash(loader).getInfo();
```

ポンプをしているのが `'data'` ハンドラです。`serialport` はこの形を最初から提供してくれるので、Web Serial 版より短くなります。

---

## WebUSB

予定はありません。理由はデバイスによって2つに分かれます。

**ブリッジチップ越し**（CP210x、CH340、FTDI）の場合、WebUSB では各ベンダのコントロール転送プロトコルを — 速度設定と DTR/RTS の操作について — 自前で実装し直すことになります。3種類以上のデバイス固有ドライバを書き、そして**保守し続ける**必要があります。ブラウザはすでにそれを持っていて、その名前が Web Serial です。

**チップ内蔵 USB**（C3・S3・C6・H2・P4 の USB-Serial/JTAG）の場合、WebUSB は十分に合理的な道です。WebUSB は使えるが Web Serial は使えない Android Chrome に届きます。これは実在するギャップで、埋める理由も実在します。ここで対象外にしているのは「悪い考えだから」ではなく、テストスイートからは検証できない実機テストが必要で、しかも恩恵を受けるのがネイティブUSB を持つチップに限られるからです。

必要なら、実装すべきは上のインターフェースだけです。ライブラリの他のどこも、シリアルポートというものを知りません。

---

## 自分の Transport をテストする

`MockTransport` は、実機なしでプロトコルをテストするためのものです。**Transport 自体**のテストはその逆で、偽のバイト供給源で駆動し、厄介なケースを乗り越えられるか確かめます。

```js
// タイムアウト後に届いたチャンクが、次の呼び出し側に渡ること。
const t = new MyTransport(source);
await t.open();
await assert.rejects(() => t.read({ timeoutMs: 10 }));
source.emit(Uint8Array.of(1, 2, 3));
assert.deepEqual(await t.read({ timeoutMs: 100 }), Uint8Array.of(1, 2, 3));
```

このテスト1つが、上に書いたバグを捕まえたはずのものです。`test/web-serial.test.js` にこれがあり、あわせて「タイムアウトを繰り返してもキューのデータを消費しない」「read 前に届いたデータも取りこぼさない」を検査しています。フレームの再構成は1つ上の層の仕事で、`test/protocol.test.js` の `SlipDecoder` テストが担当します。**Transport 側はフレーム境界を気にする必要がありません。**

なお `test/transport-contract.test.js` は、必須5メソッドだけを持つ Transport で実際にデバイスへ到達できることを検査しています。同梱の Transport はどれも8つ全部を実装しているため、省略可能なメソッドへの隠れた依存はこのテストが無いと表に出ません。
