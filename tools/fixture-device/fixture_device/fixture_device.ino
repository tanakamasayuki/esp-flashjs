// ESP FlashJS — fixture provisioner
//
// Writes a known, deterministic set of contents so a flash dump can be
// committed as a test fixture.
//
// Why this exists: every parser bug found so far survived the test suite
// because the fixtures were produced by the same code being tested, so a wrong
// constant agreed with itself. Bytes that came off a real device cannot do
// that. Nothing written here is secret, so the dump is safe to commit.
//
// Board settings: Partition Scheme = Custom (partitions.csv next to this
// sketch is picked up automatically by the arduino-esp32 core).
//
// After flashing, open the serial monitor at 115200 and wait for
// "FIXTURE COMPLETE" before capturing, then run ../capture.sh.
//
// The sketch runs in two acts, because a core dump can only be produced by
// actually crashing:
//
//   boot 1  provision NVS and the three filesystems, then abort() on purpose.
//           The panic handler writes a core dump into the coredump partition
//           and reboots.
//   boot 2  esp_reset_reason() is ESP_RST_PANIC, so provisioning is skipped.
//           The device reports what it wrote, and prints FIXTURE COMPLETE.
//
// A capture is therefore taken on the second boot, and "FIXTURE COMPLETE"
// still means exactly what it meant before: everything is in flash, nothing is
// still being written. Power-cycling starts the cycle over, which re-provisions
// and re-crashes and ends up in the same place.

#include <Preferences.h>
#include <SPIFFS.h>
#include <LittleFS.h>
#include <FFat.h>

#include <esp_core_dump.h>
#include <esp_system.h>

// Anything the tests assert on must be reproducible byte for byte, so every
// value here is a fixed constant. No timestamps, no random data, no MAC.
static const char *STR_VALUE = "hello NVS";
static const uint16_t SMALL_BLOB = 64;
// These two are budgeted against the nvs partition, not chosen freely.
//
// A 20 KB nvs is 5 pages of 126 entries, and IDF keeps one page free for
// garbage collection, so 504 entries are usable. Blob payload costs one entry
// per 32 bytes: the original 9000-byte blob alone took 285, which with 200
// keys filled the partition exactly. Two keys did not fit, and — worse — the
// GC that ran to make room reclaimed the erased entries, destroying the very
// overwrite-and-delete cases this fixture exists to capture.
//
// The sizes below cost roughly 330 of 504, leaving the erased entries in place
// while still crossing every boundary that matters.
static const uint16_t BIG_BLOB = 5000;  // > 4032, so still BLOB_IDX + chunks
static const uint16_t MANY_KEYS = 150;

/** Bytes in /big.bin, on every filesystem. See writeTree for why this size. */
static const uint16_t BIG_FILE = 20000;

static uint8_t bigBlob[BIG_BLOB];

static void banner(const char *what) {
  Serial.print("\n=== ");
  Serial.println(what);
}

static void provisionNvs() {
  banner("NVS");
  Preferences p;

  // Every primitive type, so the type table is exercised end to end.
  p.begin("types", false);
  p.clear();
  p.putUChar("u8", 0x12);
  p.putChar("i8", -5);
  p.putUShort("u16", 0x1234);
  p.putShort("i16", -300);
  p.putUInt("u32", 0x12345678);
  p.putInt("i32", -70000);
  p.putULong64("u64", 0x1122334455667788ULL);
  p.putLong64("i64", -5000000000LL);
  p.putString("str", STR_VALUE);
  p.putString("empty", "");
  p.end();
  Serial.println("  types: 10 keys");

  p.begin("blobs", false);
  p.clear();
  uint8_t small[SMALL_BLOB];
  for (uint16_t i = 0; i < SMALL_BLOB; i++) small[i] = (uint8_t)i;
  p.putBytes("small", small, SMALL_BLOB);

  for (uint16_t i = 0; i < BIG_BLOB; i++) bigBlob[i] = (uint8_t)(i & 0xff);
  p.putBytes("big", bigBlob, BIG_BLOB);

  // An overwrite leaves the old entry behind, marked erased. Reading the newer
  // one instead is the whole point of the page sequence number.
  p.putInt("rewritten", 1);
  p.putInt("rewritten", 2);

  // A delete leaves only the erased entry.
  p.putInt("deleted", 42);
  p.remove("deleted");
  p.end();
  Serial.println("  blobs: small(64) big(9000) rewritten deleted");

  // Enough keys to fill a page and continue on the next, which also drives a
  // page into the FULL state.
  p.begin("many", false);
  p.clear();
  char key[16];
  for (uint16_t i = 0; i < MANY_KEYS; i++) {
    snprintf(key, sizeof(key), "k%03u", i);
    p.putUInt(key, i);
  }
  p.end();
  Serial.print("  many: ");
  Serial.print(MANY_KEYS);
  Serial.println(" keys");
}

// Files are identical across the three filesystems, so a test can compare what
// each one reports without accounting for different content.
static void writeTree(fs::FS &fs, const char *label) {
  banner(label);

  File f = fs.open("/hello.txt", FILE_WRITE);
  if (!f) {
    Serial.println("  FAILED to open /hello.txt");
    return;
  }
  f.print("hello from ");
  f.print(label);
  f.print('\n');
  f.close();

  // Sized to force every format to chain storage units together.
  //
  // 4096 bytes was not enough: FAT here uses 4096-byte clusters and LittleFS
  // 4096-byte blocks, so the file fit in exactly one of each and the chain
  // following — the most error-prone part of all three parsers — was never
  // exercised. A FAT12 entry read as whole bytes instead of twelve bits still
  // passed. At 20000 bytes it spans five FAT clusters, five LittleFS blocks
  // through a real skip-list, and eighty SPIFFS pages.
  f = fs.open("/big.bin", FILE_WRITE);
  if (f) {
    for (uint16_t i = 0; i < BIG_FILE; i++) f.write((uint8_t)(i & 0xff));
    f.close();
  }

  // A nested path, to show whether the format stores directories at all.
  fs.mkdir("/sub");
  f = fs.open("/sub/nested.txt", FILE_WRITE);
  if (f) {
    f.print("nested\n");
    f.close();
  }

  // An empty file, which several formats represent differently.
  f = fs.open("/empty.txt", FILE_WRITE);
  if (f) f.close();

  File dir = fs.open("/");
  File entry = dir.openNextFile();
  while (entry) {
    Serial.print("  ");
    Serial.print(entry.name());
    Serial.print("  ");
    Serial.println(entry.size());
    entry = dir.openNextFile();
  }
}

/**
 * What the device itself says about the core dump it just wrote.
 *
 * This is the only report in the whole fixture pipeline that this project
 * cannot influence: the address, the length and the checksum verdict all come
 * from ESP-IDF reading its own bytes back. A core dump parser written later
 * has to agree with these numbers, and if it does not, it is the parser that
 * is wrong. Printing them now costs nothing and is the difference between a
 * fixture and a fixture with a known-good answer beside it.
 *
 * @return true when a valid dump is in flash.
 */
static bool reportCoreDump() {
  banner("Core dump");

  size_t addr = 0;
  size_t size = 0;
  esp_err_t found = esp_core_dump_image_get(&addr, &size);
  if (found != ESP_OK) {
    Serial.print("  MISSING: ");
    Serial.println(esp_err_to_name(found));
    Serial.println("  Is there a 'coredump' partition in partitions.csv?");
    return false;
  }

  Serial.print("  flash offset  0x");
  Serial.println((uint32_t)addr, HEX);
  Serial.print("  length        ");
  Serial.print((uint32_t)size);
  Serial.println("  (bytes, including the trailing checksum)");

  // Re-reads the whole image and recomputes the checksum. ESP_OK here means
  // the bytes now in flash are the bytes the panic handler intended to write.
  esp_err_t intact = esp_core_dump_image_check();
  Serial.print("  checksum      ");
  Serial.println(intact == ESP_OK ? "valid" : esp_err_to_name(intact));

  // Guarded because ESP-IDF only declares these two for a flash-resident dump
  // in ELF format. That is how every chip in this table is configured, but a
  // board built the other way should fail with a clear message at runtime
  // rather than with a compile error in a sketch that is otherwise fine.
#if CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH && CONFIG_ESP_COREDUMP_DATA_FORMAT_ELF
  char reason[128] = {0};
  if (esp_core_dump_get_panic_reason(reason, sizeof(reason)) == ESP_OK) {
    Serial.print("  panic reason  ");
    Serial.println(reason);
  }

  esp_core_dump_summary_t summary;
  if (esp_core_dump_get_summary(&summary) == ESP_OK) {
    Serial.print("  crashed task  ");
    Serial.println(summary.exc_task);
    Serial.print("  exception pc  0x");
    Serial.println(summary.exc_pc, HEX);
    Serial.print("  dump version  ");
    Serial.println(summary.core_dump_version);
  }
#else
  Serial.println("  (this build stores core dumps in some other format)");
#endif

  return intact == ESP_OK;
}

void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println();
  Serial.println("ESP FlashJS fixture provisioner");
  Serial.print("chip: ");
  Serial.println(ESP.getChipModel());
  Serial.print("flash: ");
  Serial.println(ESP.getFlashChipSize());

  // Act two. Coming back from our own crash means everything is already in
  // flash; provisioning again would only rewrite it and produce a second core
  // dump for no reason.
  if (esp_reset_reason() == ESP_RST_PANIC) {
    Serial.println("reset reason: panic - this is the boot after the deliberate crash");
    if (reportCoreDump()) {
      Serial.println();
      Serial.println("FIXTURE COMPLETE - safe to capture now");
    } else {
      Serial.println();
      Serial.println("FIXTURE INCOMPLETE - no valid core dump, do not capture");
    }
    return;
  }

  provisionNvs();

  // Every partition label is passed explicitly.
  //
  // arduino-esp32's LittleFS defaults its label to "spiffs", for historical
  // reasons: data partitions used to be called that. Relying on the defaults
  // meant LittleFS formatted the partition named "spiffs" and overwrote what
  // SPIFFS had just written there, while the partition named "littlefs" was
  // never touched at all. The capture looked plausible either way — one image
  // full of data, one erased — and only reading the bytes gave it away: the
  // "spiffs" image began with a LittleFS superblock.
  if (SPIFFS.begin(true, "/spiffs", 10, "spiffs")) {
    SPIFFS.format();
    SPIFFS.end();
    SPIFFS.begin(true, "/spiffs", 10, "spiffs");
    writeTree(SPIFFS, "SPIFFS");
    SPIFFS.end();
  } else {
    Serial.println("\n=== SPIFFS: unavailable");
  }

  if (LittleFS.begin(true, "/littlefs", 10, "littlefs")) {
    LittleFS.format();
    LittleFS.end();
    LittleFS.begin(true, "/littlefs", 10, "littlefs");
    writeTree(LittleFS, "LittleFS");
    LittleFS.end();
  } else {
    Serial.println("\n=== LittleFS: unavailable");
  }

  // FAT needs a wear-levelling layer, and small partitions cannot host it.
  if (FFat.begin(true, "/ffat", 10, "ffat")) {
    FFat.format();
    FFat.end();
    FFat.begin(true, "/ffat", 10, "ffat");
    writeTree(FFat, "FatFS");
    FFat.end();
  } else {
    Serial.println("\n=== FatFS: unavailable (partition may be too small)");
  }

  // Act one ends here, on purpose.
  //
  // A core dump partition is only interesting once something has written to
  // it, and the only thing that writes to it is a panic. abort() is used
  // rather than a null dereference or a divide by zero because it cannot be
  // optimised away and it reaches the panic handler by the same path on every
  // architecture in the table — the Xtensa chips and the RISC-V ones alike.
  //
  // Nothing after this line runs. The panic handler writes the dump, prints a
  // backtrace and reboots, and setup() starts again at the branch above.
  Serial.println();
  Serial.println("provisioned - crashing on purpose to write a core dump");
  Serial.println("(the panic and backtrace below are expected)");
  Serial.flush();
  delay(100);
  abort();
}

void loop() {
  delay(10000);
}
