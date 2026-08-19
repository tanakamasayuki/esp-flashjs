#!/usr/bin/env bash
#
# Captures fixture regions from a provisioned device.
#
#   PORT=/dev/ttyUSB0 ./tools/fixture-device/capture.sh
#   PORT=/dev/ttyACM0 CHIP=esp32s3 ./tools/fixture-device/capture.sh
#   PORT=/dev/ttyUSB0 WHOLE=0 ./tools/fixture-device/capture.sh   # one read per region
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
# "auto" measures instead of guessing; a number pins it.
#
# No fixed default is defensible. Measured on one CH340 link, 115200 read
# 256 KB twice out of four attempts while 460800 managed four out of four —
# slower was both less reliable and slower. Neither is the rate to hard-code,
# and the ordering is not transferable to another cable or host.
#
# Retrying does not remove the need to choose well. Retries rescue a rate that
# fails occasionally; at 921600 on that same link nothing got through at all,
# and no amount of retrying turns 0/4 into a capture.
BAUD="${BAUD:-auto}"

# Tried fastest first, so the first success is the best available. Covers both
# the conventional ladder and the rates firmware bridges implement.
#
# The list used to stop at 115200 on the grounds that nothing sensible is
# slower. Two ESP32 boards on USB-UART bridges then read nothing at any rate in
# it — the probe below asks for 256 KB, and neither board could carry that at
# any speed — so the script reported "something other than speed is wrong". It
# was speed: at 38400 both of them read 64 KB at a time without complaint.
BAUD_CANDIDATES="${BAUD_CANDIDATES:-1500000 921600 750000 500000 460800 250000 230400 115200 57600 38400}"

# Probe with a read big enough to be discriminating. 64 KB passes at rates that
# collapse over a megabyte; 256 KB is the size that separated them in testing.
BAUD_PROBE_SIZE="${BAUD_PROBE_SIZE:-0x40000}"

# How much to ask for in one esptool call, and how small to go before giving
# up. Declared here rather than next to the reader that uses them because
# choose_baud measures this link and may lower CHUNK_N as a result.
CHUNK_N=$(( ${CHUNK:-0x40000} ))
MIN_CHUNK_N=$(( ${MIN_CHUNK:-0x4000} ))
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CSV="$HERE/fixture_device/partitions.csv"

# esptool is distributed both as `esptool` and, historically, `esptool.py`.
# v5 still ships the latter but prints a deprecation warning on every run, so
# prefer the plain name and fall back only when it is absent.
if command -v esptool >/dev/null 2>&1; then
  ESPTOOL=(esptool)
elif command -v esptool.py >/dev/null 2>&1; then
  ESPTOOL=(esptool.py)
elif python3 -c "import esptool" >/dev/null 2>&1; then
  ESPTOOL=(python3 -m esptool)
else
  echo "esptool not found. Install it with: pip install esptool" >&2
  exit 1
fi

run() { "${ESPTOOL[@]}" --port "$PORT" --baud "$BAUD" --after "$NO_RESET" "$@"; }

# ---------------------------------------------------------------------------
# Choose a line rate
# ---------------------------------------------------------------------------

# Probed on every port, including the chip's own USB.
#
# It was tempting to skip native-USB ports on the grounds that there is no UART
# in the path and the rate is therefore nominal. Measurement says otherwise: on
# both an ESP32-S3 and an ESP32-P4 over USB-Serial/JTAG, 256 KB took 26 s at
# 115200 and 3.4 s at 1500000 — a factor of nearly eight. Whatever the rate
# means on that path, it is not decoration.
# A link that cannot carry the probe size at any rate is not necessarily a link
# that cannot be read. Some can only manage a fraction of it per transfer, and
# the chunking below copes with that perfectly well once it knows — so the
# probe shrinks and tries again rather than concluding the port is broken. The
# size that finally works becomes the chunk size, since it is a measurement of
# this link and a better number than the default.
choose_baud() {
  local candidate size
  size=$((BAUD_PROBE_SIZE))
  while [ "$size" -ge "$((MIN_CHUNK_N))" ]; do
    echo "measuring the fastest rate this link carries ($size bytes per try)" >&2
    for candidate in $BAUD_CANDIDATES; do
      printf '  %8s ' "$candidate" >&2
      if "${ESPTOOL[@]}" --port "$PORT" --baud "$candidate" --after "$NO_RESET" \
           "$CMD_READ_FLASH" 0x0 "$(printf '0x%x' "$size")" "$CHUNK_TMP" >/dev/null 2>&1 \
         && [ "$(wc -c <"$CHUNK_TMP")" -eq "$size" ]; then
        echo "ok" >&2
        BAUD="$candidate"
        if [ "$size" -lt "$CHUNK_N" ]; then
          CHUNK_N="$size"
          echo "  this link tops out at $size bytes per read; using that as the chunk size" >&2
        fi
        return 0
      fi
      echo "no" >&2
    done
    size=$((size / 4))
  done
  echo "error: no rate carried even $((MIN_CHUNK_N)) bytes from $PORT." >&2
  echo "This is not speed; see the guidance in the README." >&2
  return 1
}


# ---------------------------------------------------------------------------
# Identify the chip, so the output lands in a per-chip directory.
# ---------------------------------------------------------------------------
# esptool 4.x names its subcommands with underscores (chip_id, read_flash);
# 5.x switched to hyphens. Probe once instead of guessing at every call.
if "${ESPTOOL[@]}" --help 2>&1 | grep -q -- 'read-flash'; then
  CMD_CHIP_ID=chip-id; CMD_READ_FLASH=read-flash; CMD_ERASE_FLASH=erase-flash
else
  CMD_CHIP_ID=chip_id; CMD_READ_FLASH=read_flash; CMD_ERASE_FLASH=erase_flash
fi

# esptool resets the chip when it is done, which boots the application — and
# this fixture's application rewrites NVS and all three filesystems on every
# boot. With one invocation per chunk that means the device re-provisions
# itself underneath the capture, racing the reads. An ESP32 captured this way
# came back with 95 of its 150 keys, two thirds of its entries erased, and a
# partition table that still verified perfectly. Leave the chip in the stub.
if [ "$CMD_READ_FLASH" = read-flash ]; then NO_RESET=no-reset; else NO_RESET=no_reset; fi

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
  echo "Detecting chip on $PORT ..."
  if ! CHIP="$(detect_chip)"; then
    echo "Could not detect the chip. Pass CHIP=esp32 explicitly." >&2
    exit 1
  fi
fi

# Normalize "ESP32-S3" and similar into a directory-friendly name.
SLUG="$(printf '%s' "$CHIP" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
OUT="${OUT:-$REPO/test/fixtures/hardware/$SLUG}"
mkdir -p "$OUT"

echo "chip : $CHIP"
echo "port : $PORT"
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
declare -a TYPES=(data data)

while IFS=, read -r name type subtype offset size flags; do
  name="$(echo "$name" | xargs)"
  [ -z "$name" ] && continue
  case "$name" in \#*) continue ;; esac
  NAMES+=("$name")
  OFFSETS+=("$(echo "$offset" | xargs)")
  SIZES+=("$(echo "$size" | xargs)")
  TYPES+=("$(echo "$type" | xargs)")
done < "$CSV"

# App partitions are kept head-only.
#
# Everything the image parser needs — magic, segment table, chip id, the
# SHA-256 marker, the app description block — lives in the first few KB. The
# rest is compiled code: environment-specific, and the only part of the whole
# fixture set that does not compress. Measured across three chips, app0 is 96%
# of what these fixtures cost the repository; the erased app1 costs 1 KB
# whether it is 64 KB or 1.25 MB, so the same rule covers it for free.
APP_HEAD_N=$(( ${APP_HEAD:-0x10000} ))
declare -a KEEP=()
for i in "${!NAMES[@]}"; do
  n=$(( ${SIZES[$i]} ))
  if [ "${TYPES[$i]}" = app ] && [ "$n" -gt "$APP_HEAD_N" ]; then n="$APP_HEAD_N"; fi
  KEEP+=("$n")
done

LOG_FILE="$OUT/capture.log"
: > "$LOG_FILE"
ERR_TMP="$(mktemp)"
# Chunk staging is scratch, so it lives outside $OUT. Putting it there meant an
# interrupted capture left a stray .chunk.bin among the files to be committed.
CHUNK_TMP="$(mktemp)"
trap 'rm -f "$ERR_TMP" "$CHUNK_TMP"' EXIT

# Reads fail intermittently on some USB paths. A whole capture is minutes of
# work, so a transient failure retries rather than losing the region.
ATTEMPTS="${ATTEMPTS:-3}"

# How long to let another process finish with the port before giving up.
PORT_WAIT="${PORT_WAIT:-20}"

# Whatever was watching the sketch's serial output may still hold the port for
# a moment after it exits. Reading into that fails for a reason that has
# nothing to do with the device, so wait for it to be released first.
if command -v fuser >/dev/null 2>&1; then
  waited=0
  while fuser "$PORT" >/dev/null 2>&1; do
    [ "$waited" -eq 0 ] && printf 'waiting for %s to be released ' "$PORT"
    if [ "$waited" -ge "$PORT_WAIT" ]; then
      # Sharing a serial port with another process is not a slow start, it is
      # an unwinnable fight: both sides read each other's replies and every
      # transfer fails for reasons that look like a bad link. Refuse rather
      # than produce a page of misleading failures.
      printf '\n'
      echo "error: $PORT is still held by another process." >&2
      fuser -v "$PORT" >&2 2>&1 || true
      echo "Stop it and re-run. A serial port cannot be shared." >&2
      exit 1
    fi
    printf '.'
    waited=$((waited + 1))
    sleep 1
  done
  [ "$waited" -gt 0 ] && printf ' free\n'
  true
fi

if [ "$BAUD" = auto ]; then
  choose_baud || exit 1
fi
echo "baud : $BAUD"
echo

# esptool's own message is the only thing that explains a failure. This script
# used to discard it, which turned every problem into the word FAILED and made
# the cause unknowable.
read_exact() {
  local name="$1" offset="$2" size="$3" file="$4"
  local want=$((size)) attempt rc got
  for attempt in $(seq 1 "$ATTEMPTS"); do
    if [ "$attempt" -gt 1 ]; then
      printf 'retry%d ' "$attempt"
      sleep 2
    fi
    rc=0
    run "$CMD_READ_FLASH" "$offset" "$size" "$file" >"$ERR_TMP" 2>&1 || rc=$?
    got=0
    [ -f "$file" ] && got="$(wc -c <"$file")"
    {
      printf '=== %s %s %s attempt %s: exit %s, %s/%s bytes\n' \
        "$name" "$offset" "$size" "$attempt" "$rc" "$got" "$want"
      cat "$ERR_TMP"
      echo
    } >>"$LOG_FILE"
    # A short file is worse than a missing one: it would be committed as a
    # fixture and quietly disagree with the device.
    [ "$rc" -eq 0 ] && [ "$got" -eq "$want" ] && return 0
    rm -f "$file"
  done
  return 1
}

# Reads a byte range in chunks, retrying and subdividing as needed.
#
# esptool's read is all-or-nothing: one dropped byte anywhere and the entire
# transfer is discarded. On a link that drops bytes at all — a usbip
# passthrough, a long cable, a marginal bridge — a 4 MB read therefore never
# completes, however many times it is retried, while a 256 KB read succeeds
# routinely. Chunking makes progress monotonic; halving a chunk that keeps
# failing adapts to a worse link without anyone having to tune a number.
# Assembled beside the destination and moved into place only once the whole
# range is there. Writing straight to $dest truncates it at the first chunk, so
# a capture that then failed left a 0-byte file where a good fixture used to
# be — the previous one destroyed by the attempt to replace it, which is the
# worst possible outcome for a tool whose entire job is producing those files.
read_range() {
  local label="$1" base="$2" total="$3" dest="$4"
  local part="$CHUNK_TMP"
  local staging="$dest.partial"
  local pos=0 want="$CHUNK_N" len
  : > "$staging"
  while [ "$pos" -lt "$total" ]; do
    len=$(( want < total - pos ? want : total - pos ))
    printf '  %-10s +%-8s ' "$(printf '0x%06x' $((base + pos)))" "$(printf '0x%x' "$len")"
    if read_exact "$label" "$(printf '0x%x' $((base + pos)))" "$(printf '0x%x' "$len")" "$part"; then
      cat "$part" >> "$staging"
      pos=$((pos + len))
      printf 'ok  %d%%\n' $((pos * 100 / total))
    elif [ "$want" -le "$MIN_CHUNK_N" ]; then
      printf 'FAILED\n'
      rm -f "$part" "$staging"
      return 1
    else
      want=$((want / 2))
      printf 'FAILED - halving chunk to 0x%x\n' "$want"
    fi
  done
  mv -f "$staging" "$dest"
  return 0
}

show_error() {
  grep -Eiv '^\s*$|deprecat' "$ERR_TMP" | tail -4 | sed 's/^/                 | /'
}

FAILED=0

# One esptool run for the entire flash, sliced locally afterwards.
#
# Reading region by region means a reset, a sync and a stub upload per region
# — nine independent chances for the link to drop during one capture. Reading
# once spends the same time on the wire and risks it only once, and the stub
# verifies the whole image with a single MD5. Set WHOLE=0 to go back to
# per-region reads when only one region is wanted.
if [ "${WHOLE:-1}" = "1" ]; then
  TOTAL=0
  for i in "${!NAMES[@]}"; do
    end=$(( $((OFFSETS[i])) + $((SIZES[i])) ))
    [ "$end" -gt "$TOTAL" ] && TOTAL="$end"
  done
  IMAGE="$OUT/flash.bin"

  printf '%-16s %-10s %-10s\n' "whole image" "0x0" "$(printf '0x%x' "$TOTAL")"
  if read_range "whole" 0 "$TOTAL" "$IMAGE"; then
    printf '  read %s bytes\n' "$TOTAL"
    for i in "${!NAMES[@]}"; do
      name="${NAMES[$i]}"
      off=$(( $((OFFSETS[i])) ))
      sz=${KEEP[$i]}
      # tail/head rather than dd: dd's byte-granular skip is a GNU extension,
      # and the partition table is not a whole number of blocks.
      #
      # `head` exits as soon as it has enough, which SIGPIPEs `tail`. Under
      # pipefail that aborts the whole capture after the first slice, so the
      # pipeline's status is deliberately ignored and the result is checked by
      # length instead — which is the check that actually matters.
      ( set +o pipefail; tail -c "+$((off + 1))" "$IMAGE" | head -c "$sz" ) > "$OUT/$name.bin"
      got="$(wc -c < "$OUT/$name.bin")"
      if [ "$got" -ne "$sz" ]; then
        printf '  %-14s %-10s %-10s SLICE FAILED  %s/%s bytes\n' \
          "$name" "${OFFSETS[$i]}" "${SIZES[$i]}" "$got" "$sz"
        FAILED=$((FAILED + 1))
        continue
      fi
      printf '  %-14s %-10s %-10s sliced  %s bytes%s\n' \
        "$name" "${OFFSETS[$i]}" "${SIZES[$i]}" "$got" \
        "$([ "$got" -lt $(( ${SIZES[$i]} )) ] && echo '  (head only)')"
    done
    # 4 MB of mostly 0xff that every region already covers.
    [ "${KEEP_IMAGE:-0}" = "1" ] || rm -f "$IMAGE"
  else
    printf 'FAILED\n'
    show_error
    FAILED=1
  fi
else
for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"
  offset="${OFFSETS[$i]}"
  size="${SIZES[$i]}"
  file="$OUT/$name.bin"

  printf '%-16s %-10s %-10s\n' "$name" "$offset" "$size"
  if read_range "$name" "$((offset))" "${KEEP[$i]}" "$file"; then
    printf '  ok  %s bytes\n' "$(wc -c < "$file" | xargs)"
  else
    printf '  FAILED\n'
    show_error
    FAILED=$((FAILED + 1))
  fi
done
fi

# ---------------------------------------------------------------------------
# A manifest, so a fixture can always be traced back to the device it came from.
# ---------------------------------------------------------------------------
{
  echo "# ESP FlashJS hardware fixture"
  echo "chip:      $CHIP"
  echo "captured:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "esptool:   $("${ESPTOOL[@]}" version 2>/dev/null | awk 'NR==1' || echo unknown)"
  echo "sketch:    tools/fixture-device/fixture_device/fixture_device.ino"
  echo "layout:    tools/fixture-device/fixture_device/partitions.csv"
  # Say so explicitly: a 64 KB app0.bin next to a 1.25 MB app0 partition looks
  # like a truncated capture unless the file records that it was deliberate.
  echo "app regions: first $APP_HEAD_N bytes only (the rest is compiled code)"
  echo
  echo "# sha256"
  # A glob that matches nothing expands to itself, which made the checksum
  # tool complain about a literal "*.bin" whenever every region failed.
  ( cd "$OUT" && for f in ./*.bin; do
      [ -e "$f" ] || continue
      sha256sum "$f" 2>/dev/null || shasum -a 256 "$f"
    done )
} > "$OUT/MANIFEST.txt"

echo
cat "$OUT/MANIFEST.txt"
echo
if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED region(s) failed after $ATTEMPTS attempts each."
  echo "Full esptool output: $LOG_FILE"
  exit 1
fi
echo "Done. Review the files, then commit $OUT"
