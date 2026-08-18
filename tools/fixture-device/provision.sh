#!/usr/bin/env bash
#
# Provisions a board and captures its flash as a test fixture, end to end.
#
#   PORT=/dev/ttyUSB0 ./tools/fixture-device/provision.sh
#
# Compiles the sketch, uploads it, waits for it to finish writing, reads the
# regions back, and checks the result actually looks provisioned.
#
# Assumes `arduino-cli` and `esptool` are already installed and on PATH. Run
# with CHECK_ONLY=1 to verify the environment without touching the board.
#
# THE BOARD IS ERASED. Do not run this on anything you want to keep.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SKETCH="$HERE/fixture_device"
CSV="$SKETCH/partitions.csv"

BAUD="${BAUD:-921600}"
MONITOR_BAUD="${MONITOR_BAUD:-115200}"
WAIT_SECONDS="${WAIT_SECONDS:-90}"
CORE="${CORE:-esp32:esp32}"

log()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
log "1. Checking prerequisites"

command -v arduino-cli >/dev/null 2>&1 || die "arduino-cli not found on PATH."
info "arduino-cli $(arduino-cli version | head -1)"

if command -v esptool.py >/dev/null 2>&1; then
  ESPTOOL=(esptool.py)
elif command -v esptool >/dev/null 2>&1; then
  ESPTOOL=(esptool)
elif python3 -c "import esptool" >/dev/null 2>&1; then
  ESPTOOL=(python3 -m esptool)
else
  die "esptool not found. Install it with: pip install esptool"
fi
info "esptool ${ESPTOOL[*]}"

arduino-cli core list 2>/dev/null | grep -q "^${CORE%%:*}:${CORE##*:}" \
  || die "The $CORE core is not installed. Install it with:
    arduino-cli core update-index --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
    arduino-cli core install $CORE --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json"
info "core $(arduino-cli core list | grep "^${CORE%%:*}:${CORE##*:}" | tr -s ' ')"

[ -f "$SKETCH/fixture_device.ino" ] || die "Sketch missing: $SKETCH/fixture_device.ino"
[ -f "$CSV" ] || die "Partition table missing: $CSV"

if [ "${CHECK_ONLY:-0}" = "1" ]; then
  log "Environment looks usable. Re-run without CHECK_ONLY to provision."
  exit 0
fi

: "${PORT:?Set PORT, e.g. PORT=/dev/ttyUSB0 $0}"
[ -e "$PORT" ] || die "$PORT does not exist. Is the board plugged in?"
info "port $PORT"

# ---------------------------------------------------------------------------
# 2. Identify the chip, so the right FQBN and output directory are used
# ---------------------------------------------------------------------------
log "2. Identifying the board"

# esptool 4.x names its subcommands with underscores (chip_id, read_flash);
# 5.x switched to hyphens. Probe once instead of guessing at every call.
if "${ESPTOOL[@]}" --help 2>&1 | grep -q -- 'read-flash'; then
  CMD_CHIP_ID=chip-id; CMD_READ_FLASH=read-flash; CMD_ERASE_FLASH=erase-flash
else
  CMD_CHIP_ID=chip_id; CMD_READ_FLASH=read_flash; CMD_ERASE_FLASH=erase_flash
fi

# Detection must never take the script down before it can explain itself, so
# the output is captured whole and parsed afterwards. Piping into `head` here
# used to raise SIGPIPE, which `pipefail` turned into a silent exit.
detect_chip() {
  local raw name
  raw="$("${ESPTOOL[@]}" --port "$PORT" "$CMD_CHIP_ID" 2>&1 || true)"
  name="$(printf '%s\n' "$raw" | awk '
    /^Chip is /   { sub(/^Chip is /, ""); sub(/[ (].*/, ""); print; exit }
    /^Chip type:/ { sub(/^Chip type:[ \t]*/, ""); sub(/[ (].*/, ""); print; exit }
    /^Detecting chip type/ { line = $0; sub(/.*\.\.\.[ \t]*/, "", line);
                             if (line != "") { print line; exit } }
  ')"
  if [ -z "$name" ]; then
    printf '%s\n' "$raw" >&2
    return 1
  fi
  printf '%s' "$name"
}

if [ -z "${CHIP:-}" ]; then
  if ! CHIP="$(detect_chip)"; then
    die "Could not identify the chip on $PORT (esptool output above).
    Common causes: another program holds the port, the board needs BOOT held
    down, or it is not an Espressif chip. You can skip detection with CHIP=esp32."
  fi
fi
SLUG="$(printf '%s' "$CHIP" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
info "chip $CHIP  (slug $SLUG)"

case "$SLUG" in
  esp32|esp32d0wdv3|esp32d0wdq6|esp32u4wdh|esp32pico*) BOARD=esp32 ;;
  esp32s2*)  BOARD=esp32s2 ;;
  esp32s3*)  BOARD=esp32s3 ;;
  esp32c3*)  BOARD=esp32c3 ;;
  esp32c6*)  BOARD=esp32c6 ;;
  esp32h2*)  BOARD=esp32h2 ;;
  esp32p4*)  BOARD=esp32p4 ;;
  *) die "No FQBN mapping for '$CHIP'. Set FQBN=... explicitly." ;;
esac

# PartitionScheme=custom makes the core use the partitions.csv beside the
# sketch instead of one of its built-in layouts.
OPTS="PartitionScheme=custom"
# On chips with native USB the sketch's Serial only reaches a USB port when the
# CDC-on-boot option is on. Set USB_CDC=1 when the board is connected that way.
if [ "${USB_CDC:-0}" = "1" ]; then
  OPTS="$OPTS,CDCOnBoot=cdc"
fi
FQBN="${FQBN:-$CORE:$BOARD:$OPTS}"
info "fqbn $FQBN"

# ---------------------------------------------------------------------------
# 3. Erase, so nothing from a previous life survives into the fixture
# ---------------------------------------------------------------------------
log "3. Erasing flash"
"${ESPTOOL[@]}" --port "$PORT" "$CMD_ERASE_FLASH"

# ---------------------------------------------------------------------------
# 4. Build and upload
# ---------------------------------------------------------------------------
log "4. Compiling"
BUILD="$HERE/.build/$SLUG"
mkdir -p "$BUILD"
arduino-cli compile --fqbn "$FQBN" --build-path "$BUILD" "$SKETCH"

log "5. Uploading"
arduino-cli upload --fqbn "$FQBN" --port "$PORT" --input-dir "$BUILD" "$SKETCH"

# ---------------------------------------------------------------------------
# 6. Wait for the sketch to report it has finished writing
# ---------------------------------------------------------------------------
log "6. Waiting for the sketch to finish"

# A board with native USB re-enumerates after upload, so the port can vanish
# and come back.
for _ in $(seq 1 30); do
  [ -e "$PORT" ] && break
  sleep 1
done
[ -e "$PORT" ] || die "$PORT did not come back after upload."

configure_port() {
  if stty -F "$PORT" "$MONITOR_BAUD" raw -echo 2>/dev/null; then return 0; fi
  stty -f "$PORT" "$MONITOR_BAUD" raw -echo 2>/dev/null   # BSD and macOS
}
configure_port || info "could not configure $PORT; reading anyway"

# Capturing early would bake a half-written state into the fixture, so this
# waits for the sketch's own completion marker.
if timeout "$WAIT_SECONDS" grep -q -m1 "FIXTURE COMPLETE" < "$PORT"; then
  info "sketch reported FIXTURE COMPLETE"
else
  info "did not see FIXTURE COMPLETE within ${WAIT_SECONDS}s"
  info "on a native-USB board this usually means Serial goes elsewhere; try USB_CDC=1"
  info "continuing anyway, then verifying the result"
  sleep 10
fi

# ---------------------------------------------------------------------------
# 7. Capture
# ---------------------------------------------------------------------------
log "7. Capturing regions"
PORT="$PORT" CHIP="$CHIP" BAUD="$BAUD" "$HERE/capture.sh"

# ---------------------------------------------------------------------------
# 8. Verify the dump actually looks provisioned
# ---------------------------------------------------------------------------
log "8. Verifying"
OUT="${OUT:-$REPO/test/fixtures/hardware/$SLUG}"
node "$HERE/verify-fixture.mjs" "$OUT" "$CSV"

log "Done"
info "fixture: $OUT"
info "review MANIFEST.txt, then commit the directory"
