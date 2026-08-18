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

#include <Preferences.h>
#include <SPIFFS.h>
#include <LittleFS.h>
#include <FFat.h>

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
static const uint16_t MANY_KEYS = 150;  // > 126 entries, so pages must spill

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

  // Larger than one page, so the file spans several blocks.
  f = fs.open("/big.bin", FILE_WRITE);
  if (f) {
    for (uint16_t i = 0; i < 4096; i++) f.write((uint8_t)(i & 0xff));
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

void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println();
  Serial.println("ESP FlashJS fixture provisioner");
  Serial.print("chip: ");
  Serial.println(ESP.getChipModel());
  Serial.print("flash: ");
  Serial.println(ESP.getFlashChipSize());

  provisionNvs();

  if (SPIFFS.begin(true)) {
    SPIFFS.format();
    SPIFFS.end();
    SPIFFS.begin(true);
    writeTree(SPIFFS, "SPIFFS");
    SPIFFS.end();
  } else {
    Serial.println("\n=== SPIFFS: unavailable");
  }

  if (LittleFS.begin(true)) {
    LittleFS.format();
    LittleFS.end();
    LittleFS.begin(true);
    writeTree(LittleFS, "LittleFS");
    LittleFS.end();
  } else {
    Serial.println("\n=== LittleFS: unavailable");
  }

  // FAT needs a wear-levelling layer, and small partitions cannot host it.
  if (FFat.begin(true)) {
    FFat.format();
    FFat.end();
    FFat.begin(true);
    writeTree(FFat, "FatFS");
    FFat.end();
  } else {
    Serial.println("\n=== FatFS: unavailable (partition may be too small)");
  }

  Serial.println();
  Serial.println("FIXTURE COMPLETE - safe to capture now");
}

void loop() {
  delay(10000);
}
