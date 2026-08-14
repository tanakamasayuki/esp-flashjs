// @ts-check
/**
 * Device identification.
 *
 * Anything that cannot be read is reported as `"unknown"` or `null`. Nothing
 * here guesses: a wrong flash size silently truncates a dump, and a wrong
 * encryption state invites someone to overwrite a partition they should not.
 *
 * @module device/device-info
 */

/**
 * @typedef {import('../protocol/loader.js').EspLoader} EspLoader
 */

/**
 * @typedef {object} DeviceInfo
 * @property {string} chip
 * @property {string} revision
 * @property {string} mac
 * @property {number|null} flashSize
 * @property {number|null} flashId
 * @property {string[]} features           Stable ids; the UI translates them.
 * @property {boolean} secureDownloadMode
 * @property {boolean} secureBootEnabled
 * @property {boolean|null} flashEncryptionEnabled
 * @property {boolean} usingStub
 * @property {number} bootloaderOffset
 */

/**
 * @param {EspLoader} loader
 * @returns {Promise<DeviceInfo>}
 */
export async function readDeviceInfo(loader) {
  const chip = loader.requireChip();
  const security = loader.securityInfo;

  /** @type {DeviceInfo} */
  const info = {
    chip: chip.name,
    revision: 'unknown',
    mac: 'unknown',
    flashSize: null,
    flashId: null,
    features: chip.features,
    secureDownloadMode: loader.secureDownloadMode,
    secureBootEnabled: security?.secureBootEnabled ?? false,
    flashEncryptionEnabled: null,
    usingStub: loader.isStub,
    bootloaderOffset: chip.bootloaderOffset,
  };

  // Secure Download Mode blocks register reads entirely; report what is known
  // from the security info and stop.
  if (info.secureDownloadMode) return info;

  try {
    info.mac = await readMac(loader);
  } catch {
    /* leave as unknown */
  }

  try {
    const flashId = await loader.readFlashId();
    info.flashId = flashId;
    info.flashSize = await loader.detectFlashSize();
  } catch {
    /* leave as null */
  }

  if (security !== null) {
    // An odd popcount of flash_crypt_cnt means encryption is active. This is
    // the same rule IDF uses.
    info.flashEncryptionEnabled = popcount(security.flashCryptCnt) % 2 === 1;
  }

  return info;
}

/**
 * Reads the factory MAC address from eFuse.
 *
 * @param {EspLoader} loader
 * @returns {Promise<string>}
 */
export async function readMac(loader) {
  const chip = loader.requireChip();
  const mac0 = await loader.readReg(chip.macEfuseReg);
  const mac1 = await loader.readReg(chip.macEfuseReg + 4);

  // The MAC is stored little-endian across two words, with only the low 16
  // bits of the second word in use.
  const bytes = [
    (mac1 >> 8) & 0xff,
    mac1 & 0xff,
    (mac0 >> 24) & 0xff,
    (mac0 >> 16) & 0xff,
    (mac0 >> 8) & 0xff,
    mac0 & 0xff,
  ];

  if (bytes.every((b) => b === 0)) return 'unknown';
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(':');
}

/**
 * @param {number} value
 * @returns {number}
 */
function popcount(value) {
  let n = value >>> 0;
  let count = 0;
  while (n) {
    count += n & 1;
    n >>>= 1;
  }
  return count;
}
