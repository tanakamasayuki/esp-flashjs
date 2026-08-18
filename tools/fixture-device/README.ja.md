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
| `BAUD` | `921600` | 失敗するときは `115200` に下げる |
| `OUT` | `test/fixtures/hardware/<chip>/` | 出力先 |

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
| `app0.bin` | 1.25 MB | ESP イメージのヘッダ・セグメント・SHA-256・app description |
| `app1.bin` | 1.25 MB | 未書き込み（消去済みの見え方） |
| `spiffs.bin` | 320 KB | SPIFFS |
| `littlefs.bin` | 320 KB | LittleFS |
| `ffat.bin` | 832 KB | FAT + wear levelling |
| `MANIFEST.txt` | — | チップ・取得日時・esptool 版・各ファイルの sha256 |

`app0.bin` と `app1.bin` は 1.25 MB あります。app0 はビルドしたスケッチそのもので環境依存が大きいため、**コミットするかは別途判断**してください（先頭 64 KB だけでもイメージ解析の検証には足ります）。

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
