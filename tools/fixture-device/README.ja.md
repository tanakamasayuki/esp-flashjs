# 実機 fixture の作り方

[English](./README.md) · **日本語**

既知の内容を書き込んだ実機からフラッシュを吸い出し、テスト fixture としてコミットするための一式です。

---

## なぜ必要か

ここまでに見つかったパーサのバグは、**すべてテストを素通り**していました。原因は共通で、fixture を検証対象と同じコードで生成していたためです。

| バグ | なぜ検出できなかったか |
| --- | --- |
| パーティション magic のバイト順 | parse と build が同じ誤った定数を共有 |
| otadata の CRC 規約 | fixture の CRC も同じ式で生成 |
| データコマンドのチェックサム範囲 | モックが検証していなかった |
| READ_FLASH の ack を SLIP で包んでいない | モックが ack を無視していた |
| タイムアウトした read の放棄 | モックが同期実装だった |

**実機から出てきたバイト列だけが、この共犯関係を断ち切れます。**

書き込む内容はこちらで決めた定数だけなので、秘匿情報は含まれません。MAC アドレスは eFuse にあり、ここで吸い出す領域には入りません。そのままコミットできます。

---

## 用意するもの

- ESP32 系ボード（フラッシュ 4MB 以上）
- Arduino IDE + arduino-esp32、または arduino-cli
- `esptool`（`pip install esptool`）

**中身は消去されます。** 残したいデータがあるボードでは実行しないでください。

---

## 手順

### 1. 書き込む

Arduino IDE で `fixture_device/fixture_device.ino` を開きます。

- **ボード**: 対象のチップ
- **Partition Scheme**: `Custom`
  スケッチと同じフォルダの `partitions.csv` が自動で使われます

arduino-cli の場合:

```sh
cd tools/fixture-device
arduino-cli compile --fqbn esp32:esp32:esp32 \
  --build-property build.partitions=partitions \
  --build-property upload.maximum_size=1310720 fixture_device
arduino-cli upload --fqbn esp32:esp32:esp32 -p /dev/ttyUSB0 fixture_device
```

### 2. 完了を待つ

シリアルモニタ（115200）を開き、**`FIXTURE COMPLETE`** が出るまで待ちます。書き込み途中で吸い出すと、中途半端な状態が fixture になってしまいます。

```
ESP FlashJS fixture provisioner
chip: ESP32-D0WD-V3
flash: 4194304

=== NVS
  types: 10 keys
  blobs: small(64) big(9000) rewritten deleted
  many: 200 keys

=== SPIFFS
  /hello.txt  22
  ...

FIXTURE COMPLETE - safe to capture now
```

### 3. 吸い出す

**シリアルモニタを閉じてから**実行してください（ポートを掴んでいると失敗します）。

```sh
PORT=/dev/ttyUSB0 ./tools/fixture-device/capture.sh
```

チップは自動判別し、`test/fixtures/hardware/<チップ名>/` に保存します。

環境変数:

| 変数 | 既定 | 用途 |
| --- | --- | --- |
| `PORT` | （必須） | シリアルポート |
| `CHIP` | 自動判別 | `esp32` / `esp32s3` / `esp32p4` などを明示 |
| `BAUD` | `auto` | 読み出し速度。`auto` は測って決めます（下記）。数値で固定も可 |
| `BAUD_CANDIDATES` | 8種 | `auto` が速い順に試す候補 |
| `BAUD_PROBE_SIZE` | `0x40000` | 1候補あたりの試し読みサイズ |
| `WHOLE` | `1` | フラッシュ全体を1回で読んでローカルで切り分ける。`0` で領域ごとに読む |
| `ATTEMPTS` | `3` | 1チャンクあたりの再試行回数 |
| `CHUNK` | `0x40000` | 1回の esptool 呼び出しで読む量（256KB） |
| `MIN_CHUNK` | `0x4000` | 失敗時にここまで半分に縮めて再挑戦する下限 |
| `PORT_WAIT` | `20` | 他プロセスがポートを離すのを待つ秒数。超えたら中止 |
| `APP_HEAD` | `0x10000` | app パーティションは先頭このバイト数だけ取得する |
| `KEEP_IMAGE` | `0` | `1` で切り出し前の `flash.bin`（4MB）も残す |
| `OUT` | `test/fixtures/hardware/<chip>/` | 出力先 |

失敗した場合、esptool の出力は `<出力先>/capture.log` に全部残ります。

### 読み出しが失敗するとき

**まず、ポートを他に掴まれていないか確認してください。** シリアルポートは共有できません。2つのプロセスが同じポートを読むと互いの応答を食い合い、リンク不良とそっくりな失敗が延々と出ます。capture.sh は掴んでいるプロセスを名指しして中止しますが、シリアルモニタや別ターミナルの esptool は自分で閉じる必要があります。

```sh
fuser -v "$PORT"
```


esptool の読み出しは **all-or-nothing** です。途中で1バイト落ちただけで転送全体が破棄されます。

```
A fatal error occurred: Corrupt data, expected 0x1000 bytes but received 0xff5 bytes.
```

これが出たら、速度ではなく**リンクがバイトを落としています**。何度リトライしても 4MB は通りません。1回の読み出し量を減らすのが唯一の対処で、それを自動でやるのが `CHUNK` と縮退リトライです。チャンクが失敗し続けると `MIN_CHUNK` まで半分ずつ縮めます。

**速度は下げれば安全、ではありません。** ESP32 実機（CH340 系ブリッジ、WSL2 の usbip 経由）で 256KB の読み出しを各速度4回ずつ試した実測:

| baud | 成功 |
| --- | --- |
| 115200 | 2/4 |
| 230400 | 1/4 |
| 250000 | 0/4 |
| **460800** | **4/4** |
| 500000 | 0/4 |
| 750000 | 0/4 |
| 921600 | 0/4 |
| 1500000 | 0/4 |

速度順に並べても規則性はありません。115200 は最良ではなく、その上下に通る値と通らない値が混在します。「分周が正確な値のほうが良い」という説も、この表が否定しています（250000・500000・750000・1500000 は 12MHz を割り切りますが全滅）。**推測せず、測ってから決めてください:**

```sh
for b in 115200 230400 250000 460800 500000 750000 921600 1500000; do
  esptool --port "$PORT" --baud $b read-flash 0x0 0x40000 /tmp/t.bin >/dev/null 2>&1 \
    && echo "$b ok" || echo "$b FAILED"
done
```

なお `/sys/bus/usb-serial/devices/ttyUSB*` の実体が `vhci_hcd`（usbip）配下なら、WSL2 の USB パススルー越しです。この経路は素の USB より確実にバイトを落とします。Windows 側で直接 esptool を走らせて `.bin` を持ち込むほうが速くて確実です。

**`WHOLE` の既定が 1 の理由:** 領域ごとに読むと、1領域につきリセット・sync・stub 転送が走ります。9領域なら9回、それぞれが独立に失敗しうる。実際 ESP32 実機で 9 領域中 5 領域が失敗し、しかも同じ 320KB の spiffs が成功して littlefs が失敗するという、サイズにも順番にも相関しない散らばり方をしました。全体を1回で読めば、ワイヤ上の時間はほぼ同じまま、失敗しうる箇所が1回に減ります。stub の MD5 検証もイメージ全体に対して1回で効きます。

**`BAUD` が `auto` の理由:** 固定値で正解を出せません。同じ CH340 リンクの実測で 115200 は 2/4、460800 は 4/4 でした。遅いほうが不確実かつ遅い。しかもこの順位は別のケーブルやホストには持ち越せません。

リトライがあれば速度を気にしなくていい、とはなりません。リトライが救えるのは**たまに失敗する速度**であって、同じリンクの 921600 は 0/4 — 何度試しても通らないものは通りません。

`auto` は 256KB の試し読みを速い順に1回ずつ行い、最初に通った速度を採用します。256KB なのは、64KB だと通ってしまう速度が 4MB で落ちるためです。

**ネイティブUSB でも速度は効きます。** 「UART が挟まらないから名目値だろう」と考えて測定を飛ばしかけましたが、実測は逆でした。

| | 115200 | 921600 | 1500000 |
| --- | --- | --- | --- |
| ESP32-S3 (USB-Serial/JTAG) | 26.0s | 4.4s | **3.4s** |
| ESP32-P4 (USB-Serial/JTAG) | 26.3s | 4.8s | **3.8s** |

256KB あたりの所要時間で **7.7倍** の差です。判別して飛ばす分岐は削除し、全ポートで測ります。

3 機種ぶん続けて取るなら:

```sh
PORT=/dev/ttyUSB0 ./tools/fixture-device/capture.sh   # ESP32
PORT=/dev/ttyACM0 ./tools/fixture-device/capture.sh   # ESP32-S3
PORT=/dev/ttyACM1 ./tools/fixture-device/capture.sh   # ESP32-P4
```

---

## 何が取れるか

| ファイル | 内容 | 何を検証できるか |
| --- | --- | --- |
| `bootarea.bin` | `0x0`–`0x8000` | bootloader イメージ。チップごとに開始位置が違う |
| `partition-table.bin` | `0x8000` | エントリの magic バイト順、MD5 |
| `nvs.bin` | 20 KB | 全型・blob 分割・上書き・削除・ページ跨ぎ |
| `otadata.bin` | 8 KB | ROM の CRC 規約。factory が無いので bootloader が実際に書き込む |
| `app0.bin` | 64 KB | ESP イメージのヘッダ・セグメント・SHA-256・app description |
| `app1.bin` | 64 KB | 未書き込み（消去済みの見え方） |
| `spiffs.bin` | 320 KB | SPIFFS |
| `littlefs.bin` | 320 KB | LittleFS |
| `ffat.bin` | 832 KB | FAT + wear levelling |
| `MANIFEST.txt` | — | チップ・取得日時・esptool 版・各ファイルの sha256 |

app パーティションは先頭 64 KB だけ取得します（`APP_HEAD` で変更可）。イメージ解析に必要なもの（マジック・セグメント表・chip id・SHA-256 マーカー・app description）はすべて先頭数 KB にあり、残りはビルド済みコードで環境依存が大きく、しかも **fixture 一式のうち唯一まともに圧縮されない部分**です。3機種で実測したところ app0 だけでリポジトリ負荷の 96% を占めていました。0xFF だらけの領域は git が潰すので、全体では 4.9 MB / 圧縮後 50 KB 程度に収まります。

---

## NVS に何が入るか

パーサの難所を狙って選んであります。

| 名前空間 | 内容 | 狙い |
| --- | --- | --- |
| `types` | u8/i8/u16/i16/u32/i32/u64/i64/文字列/空文字列 | 全型コードと符号の扱い |
| `blobs` | `small`(64B) | 1 チャンクに収まる blob |
| | `big`(9000B) | **4032B を超えるので BLOB_IDX + 複数 BLOB_DATA に分割される** |
| | `rewritten` | 上書き。旧エントリが erased で残り、seqNo で新しい方を選ぶ必要がある |
| | `deleted` | 削除。erased のみが残る |
| `many` | `k000`–`k199` | 126 エントリ/ページを超えるのでページを跨ぎ、FULL 状態が生まれる |

---

## ファイルシステムの中身

3 つとも同じ木を書きます。フォーマット間で結果を比べられるようにするためです。

```
/hello.txt      短いテキスト
/big.bin        4096 バイト（1 ページを超える）
/sub/nested.txt ネストしたパス
/empty.txt      空ファイル
```

チップやパーティションサイズによっては使えない形式があります。その場合スケッチは `unavailable` と出して先に進むので、取れたものだけで構いません。特に FAT は wear levelling 層が必要で、小さいパーティションには載りません。

---

## コミットするとき

1. `MANIFEST.txt` を確認する
2. 想定どおりのサイズか確認する（全部 0xFF なら書き込みが効いていない）
3. `test/fixtures/hardware/<chip>/` ごとコミットする

fixture を差し替えたときは、それに依存するテストの期待値も更新してください。**期待値を実装の出力に合わせて書き換えるのは本末転倒**です。実機がこう返した、という事実の側を正としてください。
