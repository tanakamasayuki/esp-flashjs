# API リファレンス

[English](./api.md) · **日本語**

全エクスポートを用途別に並べたものです。チュートリアルではなく地図です。動く例は [guide.ja.md](./guide.ja.md)、なぜこの形なのかは [spec.ja.md](./spec.ja.md) を参照してください。

TypeScript の型定義（`types/index.d.ts`）をパッケージに同梱しています。ソースの JSDoc から生成しているので、エディタの補完が全部効きます。

---

## 2つの入口

```js
import { … } from 'esp-flashjs';        // すべて
import { … } from 'esp-flashjs/core';   // パーサとバイトユーティリティのみ
```

`core` は `Uint8Array` に対する純粋な計算です。シリアル関連もブラウザ API も含まず、小さく、Node や Worker でも使えます。`core` の中身はフル版からすべて再エクスポートされているので、両方を import する必要はありません。

下の **デバイス** 節にあるものだけが `esp-flashjs` 専用です。それ以外は両方にあります。

---

## デバイス

### `class EspLoader`

ブートローダプロトコル。リセット、同期、チップ判定、stub、そして生のコマンドチャネル。

```js
new EspLoader(transport, { onLog })
```

| メンバ | 用途 |
| --- | --- |
| `connect({ signal, autoReset })` | リセット・同期・判定。`chip` を設定する |
| `loadStub({ signal })` | flasher stub を転送して起動。失敗時は例外ではなく `false` |
| `disconnect({ reset })` | 切断。リセットしてアプリを起動させることもできる |
| `chip` | 判定された `ChipDef`、または null |
| `isStub` | stub が動作中か |
| `secureDownloadMode` | チップが RAM 書き込みとフラッシュ読み出しを拒否しているか |
| `changeBaudRate(rate)` | stub 起動後にのみ意味を持つ |
| `readReg(address)` / `writeReg(address, value, mask, delayUs)` | レジスタアクセス |
| `readFlashId()` / `detectFlashSize()` | SPI フラッシュの identification |
| `command(op, payload, options)` | コマンドを1つ送って応答を待つ |
| `readFrame({ timeoutMs, signal })` | SLIP フレームを1つ読む |
| `resync({ settleMs })` | 失敗した操作の残りを捨てる |
| `sync()` / `reset(strategy)` / `detectChip()` / `getSecurityInfo()` | `connect()` の各段階。特殊な流れ用に公開 |
| `attachSpiFlash()` / `runSpiFlashCommand(cmd, opts)` | 生の SPI |
| `stubNameFor(chip)` | このシリコンに必要な stub。リビジョンで異なるチップがある |
| `exclusive(run, { signal, phase })` | リンクを占有して処理を実行する |
| `busy` | 実行中または待機中の操作があるか |

### `class EspFlash`

接続済みローダの上に構築されたフラッシュ操作。

```js
new EspFlash(loader)
```

| メンバ | 用途 |
| --- | --- |
| `getInfo({ refresh })` | チップ、MAC、フラッシュサイズと ID、セキュリティ状態 |
| `read(address, size, { chunkSize, attempts, onProgress, signal })` | stub 必須。チャンク分割して各々を再試行 |
| `write(address, data, { compress, verify, onProgress, signal })` | 該当セクタを消去してから書き込む |
| `verify(address, data, { signal })` | デバイス側ハッシュで比較。転送なし |
| `eraseRegion(address, size, { signal })` | 4KB 境界が必要 |
| `eraseAll({ signal })` | チップ全体 |
| `dump({ size, onProgress, signal })` | 全体を読む |
| `probePartitions(partitions, { probeBytes, onProgress, signal })` | 各領域の先頭セクタ。`Map<label, 'erased'\|'zeroed'\|'data'\|'unreadable'>` を返す |

**操作は直列化されます。** シリアルポートが運べる会話は1つで、2つ同時に始めると**互いのフレームを読み合います**。症状はチェックサム不一致 → タイムアウト → 「デバイスが応答しない」で、ケーブル不良と見分けがつきません。そのため上記の各操作はリンクを最初から最後まで占有し、**同時に呼ばれた側はキューで待ちます**。待つことは常に回復可能ですが、破損はそうではなく、これを呼び出し側に自作させるのは筋が通りません。キュー待ち中の操作も `signal` で中止できます。待つより拒否したいアプリケーション向けに、実行中かどうかは `loader.busy` で分かります。

定数: `FLASH_SECTOR_SIZE`、`READ_BLOCK_SIZE`。

### Transport

| 名前 | 用途 |
| --- | --- |
| `WebSerialTransport` | Web Serial。`.request({ filters, baudRate })`、`.list()`、`.isSupported()` |
| `MockTransport` | テスト用の仮想デバイス。`chip`、`flash`、`flashSize`、`allowStub`、`flakyReads` などを受け取る |
| `canAutoReset(transport)` | DTR/RTS を駆動できるか、つまりユーザーの手を借りずにリセットできるか |
| `delay(ms)` | — |

`Transport` インターフェースは必須5メソッドと省略可能3メソッドです。[transports.ja.md](./transports.ja.md) を参照。

### stub

| 名前 | 用途 |
| --- | --- |
| `registerStub(name, image)` | stub イメージを直接渡す。**ブラウザ外では必須** |
| `fetchStub(name)` | モジュール隣から取得。ブラウザ専用 |
| `stubUrl(name)` | `fetchStub` が使う URL |
| `loadStub(loader, chip, { signal, image, stubName })` | `EspLoader#loadStub` の低レベル版 |

### プロトコル内部

`CMD`、`STUB_ONLY_COMMANDS`、`encodeRequest`、`decodeResponse`、`SlipDecoder`、`slipEncode`、`slipUnescape`、`CHIP_DETECT_MAGIC_REG`、`FLASH_SIZE_BY_ID`、`readDeviceInfo`、`readMac`、`VERSION`。

---

## 形式

### パーティションテーブル

| 名前 | 用途 |
| --- | --- |
| `parsePartitionTable(data, { offset })` | → `{ partitions, md5Valid, hasMd5, issues }` |
| `buildPartitionTable(partitions, { withMd5 })` | → `Uint8Array` |
| `validatePartitionTable(partitions, { flashSize })` | → `Issue[]`。重なり、境界、重複 |
| `describeFlashLayout(partitions, { flashSize, bootloaderOffset })` | 隙間を含めた全領域をアドレス順に |
| `findPartitionAt(partitions, address)` / `findPartitionByLabel(partitions, label)` | — |
| `findUnallocatedRegions(partitions, flashSize)` | — |
| `typeName(type)` / `subtypeName(type, subtype)` | — |

定数: `PARTITION_TABLE_OFFSET`、`PARTITION_TABLE_SIZE`、`PARTITION_ENTRY_SIZE`、`PARTITION_MAGIC`、`PARTITION_MD5_MAGIC`、`PARTITION_TYPE`、`MAX_PARTITIONS`。

### ファームウェアイメージ

| 名前 | 用途 |
| --- | --- |
| `parseEspImage(data)` | → ヘッダ、セグメント、チェックサム、SHA-256、app description |
| `parseAppDescription(data)` | `esp_app_desc_t` ブロック単体 |
| `verifyImageHash(data, image)` | `Promise<boolean\|null>`。WebCrypto を使うので非同期 |
| `memoryRegionFor(chip, address)` | `'IRAM'\|'DRAM'\|'IROM'\|'DROM'\|'RTC'\|'unknown'` |

定数: `ESP_IMAGE_MAGIC`、`IMAGE_CHIP_IDS`。

### OTA データ

`parseOtaData(data)` → 有効セクタ、起動スロット、シーケンス番号、issues。定数: `OTADATA_SECTOR_SIZE`。

### NVS

| 名前 | 用途 |
| --- | --- |
| `parseNvs(data, { strict })` | → `NvsStore` |
| `buildNvs(store, { size, version, selfCheck })` | → `Uint8Array`。**返す前に自分の出力を読み直す** |
| `diffNvs(before, after, { detectRenames })` | → `NvsChange[]` |
| `summarizeNvsDiff(changes)` | → `{ added, modified, deleted, renamed, total }` |
| `inferNvsType(value)` / `sameValue(a, b)` | — |
| `entryCrc32(entry)` / `pageHeaderCrc32(page)` / `entryState(page, index)` | 低レベル。ツール作成用 |

`NvsStore` のメンバ: `namespaces`、`entries`、`erasedEntries`、`pages`、`issues`、`isDirty`、`original`、`get(ns, key)`、`list(ns)`、`set(ns, key, value, type)`、`delete(ns, key)`、`rename(ns, key, newKey)`、`addNamespace(name)`、`deleteNamespace(name)`、`changes()`、`reset()`。

定数: `NVS_PAGE_SIZE`、`NVS_ENTRY_SIZE`、`NVS_ENTRY_COUNT`、`NVS_KEY_SIZE`、`NVS_MAX_KEY_LENGTH`、`NVS_MIN_PAGES`、`NVS_MAX_CHUNK_SIZE`、`NVS_TYPE`、`NVS_TYPE_NAMES`、`PAGE_STATE`、`PAGE_STATE_NAMES`、`ENTRY_STATE`。

### ファイルシステム

3形式とも同じ `FsImage` を返します: `{ type, files, geometry, issues }`。各ファイルは `{ path, size, read(), pageIndices, complete, directory? }` です。

| 名前 | 備考 |
| --- | --- |
| `parseSpiffs(data, { pageSize, blockSize, objNameLen, detectGeometry })` | ジオメトリは推定し採点する。ガイド参照 |
| `parseLittlefs(data, { blockSize })` | ジオメトリはスーパーブロックから |
| `parseFat(data, { wlDummySector })` | ESP-IDF の wear levelling 層越しに読む |

補助と定数: `spiffsLookupPages`、`SPIFFS_FLAG`、`SPIFFS_GEOMETRIES`、`SPIFFS_PAGE_HEADER_SIZE`、`SPIFFS_NAME_OFFSET`、`SPIFFS_OBJ_ID_IX_FLAG`、`ctzIndexOf`、`ctzPointerCount`、`LFS_TYPE`、`LITTLEFS_MAGIC`、`parseBpb`、`readFatEntry`、`wlMapSector`、`FAT_ATTR`、`FAT_ATTR_LONG_NAME`。

### ファイルシステムの編集と再構築

| 名前 | 備考 |
| --- | --- |
| `FsStore.from(image)` | 解析済みイメージを丸ごとコピーした編集可能なツリー |
| `new FsStore(type, geometry)` | 空の状態から作る |
| `buildFs(store, { size, source, selfCheck })` | → `Uint8Array`。store 自身の形式で構築する |
| `checkFsStore(store, type)` | → `Issue[]`。**対象形式が表現できないもの**を返す。容量は含まない（それは構築時の例外） |
| `normalizeFsPath(path)` | 絶対パス化・末尾スラッシュ除去。`..` は `FsPathError` |

`FsStore` のメンバ: `type`、`geometry`、`entries`、`paths`、`directories`、`size`、`byteLength`、`incomplete`、`has(path)`、`read(path)`、`write(path, contents)`、`mkdir(path)`、`delete(path)`、`rename(from, to)`、`clone()`。

`incomplete` は、元イメージから一部しか復元できなかったパスの一覧です。欠損部分はゼロとして読めてしまうため、再構築するとその欠損が確定します。`checkFsStore` が警告するのはこれです。

**再構築は元のジオメトリでの再生成に限られます。** 任意パラメータでのフォーマットはしません。またコンパクションを伴うため、**同じファイルを持つ別のバイト列**になります。更新日時は引き継がれません。

ジオメトリを上書きしたい場合の形式別ビルダ:

| 名前 | 備考 |
| --- | --- |
| `buildSpiffs(store, { size, pageSize, blockSize, objNameLen, metaLength, selfCheck })` | — |
| `buildLittlefs(store, { size, blockSize, progSize, version, nameMax, fileMax, attrMax, inlineMax, selfCheck })` | — |
| `buildFat(store, { source, date, time, selfCheck })` | `source` は必須。パーティション末尾の wear levelling 状態は引き継ぐことしかできず、再生成できない |

自己検査。単体でも使えます。

| 名前 | 備考 |
| --- | --- |
| `readSpiffsViaIndex(data, options)` | → `FsImage`。`parseSpiffs` の全ページ走査ではなく、**デバイスと同じくオブジェクトインデックス経由**で読む。両者が食い違うのは、まさにインデックスが壊れているときだけ |
| `littlefsTraverse(data, { blockSize })` | → `{ blocks, pairs, issues }`。ブロックアロケータと同じく tail チェーンを辿る。チェーンから外れたペアは問題なく読めてしまい、次の書き込みで空き領域として払い出される |
| `verifyFsBuild(image, expected, format)` | 再構築したイメージが指示どおりに読み戻せなければ例外 |

追加の定数: `spiffsMagic`、`spiffsIndexOffsets`、`SPIFFS_META_LENGTH`、`SPIFFS_OBJ_NAME_LEN`、`SPIFFS_DATA_PAGE_FLAGS`、`SPIFFS_INDEX_PAGE_FLAGS`、`ctzBlockCount`、`LITTLEFS_PROG_SIZE`、`LITTLEFS_VERSION`、`longNameRecords`、`shortNameFor`、`shortNameChecksum`。

---

## 解析

| 名前 | 用途 |
| --- | --- |
| `analyzeBinary(data, ctx)` | 最も確信度の高い analyzer を実行 |
| `analyzeBinaryAs(id, data, ctx)` | 特定の analyzer を強制 |
| `detectFormat(data, ctx)` | 全候補を確信度の降順で |
| `registerAnalyzer(analyzer)` / `unregisterAnalyzer(id)` / `listAnalyzers()` | プラグイン。[analyzers.ja.md](./analyzers.ja.md) 参照 |
| `peakEntropy(data)` | 16KB 窓ごとの最大エントロピー |
| `classifyEntropy(entropy, ctx)` | `'encrypted'\|'possibly-encrypted'\|'high-entropy'\|'unknown'` |

`ctx` は `{ offset?, partition?, flashSize?, flashEncryptionEnabled? }` です。後ろ2つが「推測しない」ための鍵で、パーティションのサブタイプはマジックを持たない形式に名前を与え、チップ自身の暗号化状態の報告が高エントロピーの意味を決めます。

同梱 analyzer（検査や差し替えのためエクスポートしています）: `partitionTableAnalyzer`、`espImageAnalyzer`、`otaDataAnalyzer`、`nvsAnalyzer`、`spiffsAnalyzer`、`littlefsAnalyzer`、`fatAnalyzer`、`rawAnalyzer`。定数: `CONFIDENCE_THRESHOLD`、`HIGH_ENTROPY_THRESHOLD`。

---

## バイト操作

| 分類 | 名前 |
| --- | --- |
| 差分 | `diffBinary(a, b, { minGap })`、`diffBinaryStream`、`diffSummary`、`isUniform`、`entropy` |
| 検索 | `searchBytes`、`searchText`、`parseHexPattern`、`extractStrings` |
| ハッシュ | `crc32`、`espCrc32Le`、`md5`、`md5Hex`、`sha256`、`espChecksum`、`ESP_CHECKSUM_MAGIC` |
| 読み書き | `ByteReader`、`ByteWriter` |
| 整形 | `toHexAddress`、`bytesToHex`、`hexToBytes`、`parseAddress`、`hexDump`、`toPrintableAscii`、`formatByteSize`、`decodeCString`、`encodeCString` |

`espCrc32Le` は `crc32` とは別物です。**ROM は seed と反転の扱いが異なり**、otadata はこちらで検証します。標準の方を使うと、実機の otadata セクタがすべて壊れて見えます。

---

## チップ

`CHIPS`、`chipByName(name)`、`chipByImageId(id)`、`chipByMagic(value)`。

`ChipDef` は識別値、stub 名、RAM とフラッシュのブロックサイズ、bootloader オフセット、SPI レジスタ配置、メモリマップ、そして判断に必要な場合はシリコンリビジョンの読み方を持ちます。

---

## エラー

すべてのエラーは安定した `code` と `details` を持ちます。`message` は英語で開発者向けです。**ライブラリはユーザー向けの文章を作りません。** これがアプリケーション側で表現を用意できる理由です。

| クラス | `code` |
| --- | --- |
| `AlignmentError` | `BAD_ALIGNMENT` |
| `ChecksumError` | `CHECKSUM_MISMATCH` |
| `CommandFailedError` | `COMMAND_FAILED` |
| `FsCapacityError` | `FS_CAPACITY` |
| `FsPathError` | `FS_PATH` |
| `InvalidMagicError` | `INVALID_MAGIC` |
| `NvsCapacityError` | `NVS_CAPACITY` |
| `OperationAbortedError` | `ABORTED` |
| `OutOfRangeError` | `OUT_OF_RANGE` |
| `SecureDownloadModeError` | `SECURE_DOWNLOAD_MODE` |
| `StubLoadError` | `STUB_LOAD_FAILED` |
| `SyncFailedError` | `SYNC_FAILED` |
| `TransportClosedError` | `TRANSPORT_CLOSED` |
| `TransportTimeoutError` | `TRANSPORT_TIMEOUT` |
| `TruncatedDataError` | `TRUNCATED_DATA` |
| `UnknownChipError` | `UNKNOWN_CHIP` |
| `UnsupportedOperationError` | `REQUIRES_STUB` または `SECURE_DOWNLOAD_MODE` |

系統でまとめて捕まえるための基底クラス: `EspFlashError` ← `TransportError`、`ProtocolError`、`DeviceError`、`FormatError`。

**パーサは壊れたデータで例外を投げません。** 読めた分を返し、残りを `issues`（各 `{ level: 'error'|'warning', code, params }`）で説明します。この区別は意図的です。例外は「この呼び出しは続行できない」、issue は「あなたが尋ねたデータのここが問題だ」を意味し、**壊れたイメージこそいちばん見たいもの**だからです。
