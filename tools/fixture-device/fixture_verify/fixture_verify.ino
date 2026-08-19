// ESP FlashJS — rebuild verifier
//
// The companion to fixture_device. That sketch *writes* the filesystems; this
// one only mounts what is already there and reports it, so it can be left on
// the board while a host rewrites a partition underneath it.
//
// Why a separate sketch: everything this project knows about writing a
// filesystem image was worked out by reading images and reasoning about
// headers. A round trip through our own parser cannot tell a correct image
// from one that is wrong in the same way the parser is — and that failure has
// already happened here once, with SPIFFS page flags. The only test that
// settles it is whether the chip's own driver mounts the result and reads the
// same bytes back. That is what this prints.
//
// Board settings: Partition Scheme = Custom (partitions.csv next to
// fixture_device is picked up automatically by the arduino-esp32 core).
//
// Flash this, then run:
//
//   node tools/hardware-check.mjs /dev/ttyUSB0 --rebuild
//
// IMPORTANT: nothing here formats anything. `begin(false, ...)` is deliberate
// — mounting with format-on-failure would erase the very image under test and
// then report success on the empty filesystem it made.

#include <SPIFFS.h>
#include <LittleFS.h>
#include <FFat.h>

// Written out longhand rather than pulled from a ROM function, so that the
// number this prints cannot agree with the host through a shared
// implementation. Standard CRC-32: polynomial 0xEDB88320, reflected, seeded
// and finished with all ones.
static uint32_t crc32Update(uint32_t crc, const uint8_t *data, size_t length) {
  for (size_t i = 0; i < length; i++) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; bit++) {
      crc = (crc & 1) ? (0xEDB88320UL ^ (crc >> 1)) : (crc >> 1);
    }
  }
  return crc;
}

static void reportFile(File &file, const char *path) {
  uint32_t crc = 0xFFFFFFFFUL;
  uint32_t size = 0;
  uint8_t buffer[512];
  for (;;) {
    int read = file.read(buffer, sizeof(buffer));
    if (read <= 0) break;
    crc = crc32Update(crc, buffer, (size_t)read);
    size += (uint32_t)read;
  }
  crc ^= 0xFFFFFFFFUL;

  Serial.print("F ");
  Serial.print(path);
  Serial.print(' ');
  Serial.print(size);
  Serial.print(' ');
  Serial.println(crc, HEX);
}

static void walk(fs::FS &target, const char *path, int depth) {
  if (depth > 8) return;

  File dir = target.open(path);
  if (!dir) return;

  File entry = dir.openNextFile();
  while (entry) {
    // arduino-esp32 returns a full path from name() on some cores and a bare
    // name on others. Taking path() when it is there keeps the two comparable.
    String full = entry.path();
    if (full.length() == 0) full = String(path) + "/" + entry.name();

    if (entry.isDirectory()) {
      Serial.print("D ");
      Serial.println(full);
      walk(target, full.c_str(), depth + 1);
    } else {
      reportFile(entry, full.c_str());
    }
    entry.close();
    entry = dir.openNextFile();
  }
}

static void report(const char *label, bool mounted, fs::FS &target) {
  Serial.print("FS ");
  Serial.print(label);
  Serial.println(mounted ? " mounted" : " UNMOUNTABLE");
  if (mounted) walk(target, "/", 0);
  Serial.print("FS ");
  Serial.print(label);
  Serial.println(" end");
}

void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println();
  Serial.println("VERIFY BEGIN");
  Serial.print("chip: ");
  Serial.println(ESP.getChipModel());

  // Labels are passed explicitly for the same reason fixture_device passes
  // them: arduino-esp32 defaults LittleFS to the partition named "spiffs", so
  // the defaults would mount the wrong image and read it with the wrong driver.
  bool spiffs = SPIFFS.begin(false, "/spiffs", 10, "spiffs");
  report("spiffs", spiffs, SPIFFS);
  if (spiffs) SPIFFS.end();

  bool littlefs = LittleFS.begin(false, "/littlefs", 10, "littlefs");
  report("littlefs", littlefs, LittleFS);
  if (littlefs) LittleFS.end();

  bool ffat = FFat.begin(false, "/ffat", 10, "ffat");
  report("ffat", ffat, FFat);
  if (ffat) FFat.end();

  Serial.println("VERIFY END");
}

void loop() {
  delay(10000);
}
