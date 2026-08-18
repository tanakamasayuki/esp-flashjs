#!/usr/bin/env bash
#
# Captures fixture regions from a provisioned device.
#
#   PORT=/dev/ttyUSB0 ./tools/fixture-device/capture.sh
#   PORT=/dev/ttyACM0 CHIP=esp32s3 ./tools/fixture-device/capture.sh
#
# Reads only the regions listed in fixture_device/partitions.csv, so nothing
# outside the known layout is captured. The device must have been flashed with
# fixture_device.ino first, and must have printed "FIXTURE COMPLETE".
#
# Everything written here is deterministic content from that sketch. The MAC
# address lives in eFuse and is not in any of these regions, so the output is
# safe to commit.

set -euo pipefail

: "${PORT:?Set PORT, e.g. PORT=/dev/ttyUSB0 $0}"
BAUD="${BAUD:-921600}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CSV="$HERE/fixture_device/partitions.csv"

# esptool is distributed both as `esptool.py` and, more recently, `esptool`.
if command -v esptool.py >/dev/null 2>&1; then
  ESPTOOL=(esptool.py)
elif command -v esptool >/dev/null 2>&1; then
  ESPTOOL=(esptool)
elif python3 -c "import esptool" >/dev/null 2>&1; then
  ESPTOOL=(python3 -m esptool)
else
  echo "esptool not found. Install it with: pip install esptool" >&2
  exit 1
fi

run() { "${ESPTOOL[@]}" --port "$PORT" --baud "$BAUD" "$@"; }

# ---------------------------------------------------------------------------
# Identify the chip, so the output lands in a per-chip directory.
# ---------------------------------------------------------------------------
if [ -z "${CHIP:-}" ]; then
  echo "Detecting chip on $PORT ..."
  CHIP="$(run chip-id 2>/dev/null | sed -n 's/^Detecting chip type\.*[[:space:]]*//p' | tail -1)"
  [ -z "$CHIP" ] && CHIP="$(run chip-id 2>/dev/null | sed -n 's/^Chip is \([^ ]*\).*/\1/p' | tail -1)"
  [ -z "$CHIP" ] && { echo "Could not detect the chip. Pass CHIP=esp32 explicitly." >&2; exit 1; }
fi

# Normalize "ESP32-S3" and similar into a directory-friendly name.
SLUG="$(printf '%s' "$CHIP" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
OUT="${OUT:-$REPO/test/fixtures/hardware/$SLUG}"
mkdir -p "$OUT"

echo "chip : $CHIP"
echo "port : $PORT @ $BAUD"
echo "out  : $OUT"
echo

# ---------------------------------------------------------------------------
# Regions. The boot area first, then every partition from the fixture table.
# ---------------------------------------------------------------------------
# The bootloader starts at a different offset per chip; capture from 0 so the
# same command works everywhere and the difference is visible in the dump.
declare -a NAMES=(bootarea partition-table)
declare -a OFFSETS=(0x0 0x8000)
declare -a SIZES=(0x8000 0xc00)

while IFS=, read -r name type subtype offset size flags; do
  name="$(echo "$name" | xargs)"
  [ -z "$name" ] && continue
  case "$name" in \#*) continue ;; esac
  NAMES+=("$name")
  OFFSETS+=("$(echo "$offset" | xargs)")
  SIZES+=("$(echo "$size" | xargs)")
done < "$CSV"

FAILED=0
for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"
  offset="${OFFSETS[$i]}"
  size="${SIZES[$i]}"
  file="$OUT/$name.bin"

  printf '%-16s %-10s %-10s ' "$name" "$offset" "$size"
  if run read-flash "$offset" "$size" "$file" >/dev/null 2>&1 ||
     run read_flash "$offset" "$size" "$file" >/dev/null 2>&1; then
    printf 'ok  %s bytes\n' "$(wc -c < "$file" | xargs)"
  else
    printf 'FAILED\n'
    rm -f "$file"
    FAILED=$((FAILED + 1))
  fi
done

# ---------------------------------------------------------------------------
# A manifest, so a fixture can always be traced back to the device it came from.
# ---------------------------------------------------------------------------
{
  echo "# ESP FlashJS hardware fixture"
  echo "chip:      $CHIP"
  echo "captured:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "esptool:   $(run version 2>/dev/null | head -1 || echo unknown)"
  echo "sketch:    tools/fixture-device/fixture_device/fixture_device.ino"
  echo "layout:    tools/fixture-device/fixture_device/partitions.csv"
  echo
  echo "# sha256"
  (cd "$OUT" && sha256sum ./*.bin 2>/dev/null || shasum -a 256 ./*.bin)
} > "$OUT/MANIFEST.txt"

echo
cat "$OUT/MANIFEST.txt"
echo
if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED region(s) failed. Reading flash needs the stub loader; make sure"
  echo "nothing else holds $PORT and try a lower BAUD."
  exit 1
fi
echo "Done. Review the files, then commit $OUT"
