// @ts-check
/**
 * Chip definitions.
 *
 * Values here were taken from the esptool target classes. Two identification
 * mechanisms coexist:
 *
 *   - Older parts (ESP32, ESP32-S2) are identified by a magic word at
 *     `CHIP_DETECT_MAGIC_REG`.
 *   - ESP32-S3 and everything after report a chip id through
 *     `GET_SECURITY_INFO`, and no longer carry a unique magic value.
 *
 * `usesMagicValue` records which applies. See `detectChip()` in loader.js.
 *
 * @module protocol/chips
 */

export const CHIP_DETECT_MAGIC_REG = 0x40001000;

/**
 * @typedef {object} MemoryRegion
 * @property {number} start
 * @property {number} end
 * @property {string} name
 */

/**
 * @typedef {object} ChipDef
 * @property {string} name
 * @property {number} imageChipId    IMAGE_CHIP_ID, also the GET_SECURITY_INFO chip id.
 * @property {boolean} usesMagicValue
 * @property {number|null} magicValue
 * @property {string} stub           Base name of the stub JSON file.
 * @property {number} flashWriteSize
 * @property {number} ramBlockSize
 * @property {number} bootloaderOffset
 * @property {number} macEfuseReg
 * @property {number} spiRegBase
 * @property {number} spiUsrOffs
 * @property {number} spiUsr1Offs
 * @property {number} spiUsr2Offs
 * @property {number} spiMosiDlenOffs
 * @property {number} spiMisoDlenOffs
 * @property {number} spiW0Offs
 * @property {boolean} spiAddrRegMsb
 * @property {MemoryRegion[]} memoryMap
 * @property {string[]} features     Stable ids; the UI translates them.
 */

/** Register offsets shared by every chip after the original ESP32. */
const MODERN_SPI = {
  spiUsrOffs: 0x18,
  spiUsr1Offs: 0x1c,
  spiUsr2Offs: 0x20,
  spiMosiDlenOffs: 0x24,
  spiMisoDlenOffs: 0x28,
  spiW0Offs: 0x58,
  spiAddrRegMsb: false,
};

/**
 * @param {number} iromStart
 * @param {number} iromEnd
 * @param {number} dromStart
 * @param {number} dromEnd
 * @returns {MemoryRegion[]}
 */
function mapOf(iromStart, iromEnd, dromStart, dromEnd) {
  return [
    { start: iromStart, end: iromEnd, name: 'IROM' },
    { start: dromStart, end: dromEnd, name: 'DROM' },
  ];
}

/** @type {ChipDef[]} */
export const CHIPS = [
  {
    name: 'ESP32',
    imageChipId: 0,
    usesMagicValue: true,
    magicValue: 0x00f01d83,
    stub: 'esp32',
    flashWriteSize: 0x400,
    ramBlockSize: 0x1800,
    bootloaderOffset: 0x1000,
    macEfuseReg: 0x3ff5a000 + 0x004,
    spiRegBase: 0x3ff42000,
    spiUsrOffs: 0x1c,
    spiUsr1Offs: 0x20,
    spiUsr2Offs: 0x24,
    spiMosiDlenOffs: 0x28,
    spiMisoDlenOffs: 0x2c,
    spiW0Offs: 0x80,
    spiAddrRegMsb: true,
    memoryMap: [
      { start: 0x400d0000, end: 0x40400000, name: 'IROM' },
      { start: 0x3f400000, end: 0x3f800000, name: 'DROM' },
      { start: 0x40070000, end: 0x400d0000, name: 'IRAM' },
      { start: 0x3ffae000, end: 0x40000000, name: 'DRAM' },
      { start: 0x50000000, end: 0x50002000, name: 'RTC' },
    ],
    features: ['wifi', 'bt', 'ble'],
  },
  {
    name: 'ESP32-S2',
    imageChipId: 2,
    usesMagicValue: true,
    magicValue: 0x000007c6,
    stub: 'esp32s2',
    flashWriteSize: 0x400,
    ramBlockSize: 0x1800,
    bootloaderOffset: 0x1000,
    macEfuseReg: 0x3f41a044,
    spiRegBase: 0x3f402000,
    ...MODERN_SPI,
    memoryMap: mapOf(0x40080000, 0x40b80000, 0x3f000000, 0x3f3f0000),
    features: ['wifi'],
  },
  {
    name: 'ESP32-S3',
    imageChipId: 9,
    usesMagicValue: false,
    magicValue: null,
    stub: 'esp32s3',
    flashWriteSize: 0x400,
    ramBlockSize: 0x1800,
    bootloaderOffset: 0x0,
    macEfuseReg: 0x60007000 + 0x044,
    spiRegBase: 0x60002000,
    ...MODERN_SPI,
    memoryMap: mapOf(0x42000000, 0x44000000, 0x3c000000, 0x3e000000),
    features: ['wifi', 'bt', 'ble'],
  },
  {
    name: 'ESP32-C3',
    imageChipId: 5,
    usesMagicValue: false,
    magicValue: null,
    stub: 'esp32c3',
    flashWriteSize: 0x400,
    ramBlockSize: 0x1800,
    bootloaderOffset: 0x0,
    macEfuseReg: 0x60008800 + 0x044,
    spiRegBase: 0x60002000,
    ...MODERN_SPI,
    memoryMap: mapOf(0x42000000, 0x42800000, 0x3c000000, 0x3c800000),
    features: ['wifi', 'ble'],
  },
  {
    name: 'ESP32-C2',
    imageChipId: 12,
    usesMagicValue: false,
    magicValue: null,
    stub: 'esp32c2',
    flashWriteSize: 0x400,
    ramBlockSize: 0x1800,
    bootloaderOffset: 0x0,
    macEfuseReg: 0x60008800 + 0x040,
    spiRegBase: 0x60002000,
    ...MODERN_SPI,
    memoryMap: mapOf(0x42000000, 0x42400000, 0x3c000000, 0x3c400000),
    features: ['wifi', 'ble'],
  },
  {
    name: 'ESP32-C6',
    imageChipId: 13,
    usesMagicValue: false,
    magicValue: null,
    stub: 'esp32c6',
    flashWriteSize: 0x400,
    ramBlockSize: 0x1800,
    bootloaderOffset: 0x0,
    macEfuseReg: 0x600b0800 + 0x044,
    spiRegBase: 0x60003000,
    ...MODERN_SPI,
    memoryMap: mapOf(0x42000000, 0x42800000, 0x42800000, 0x43000000),
    features: ['wifi', 'ble', 'ieee802154'],
  },
  {
    name: 'ESP32-C61',
    imageChipId: 20,
    usesMagicValue: false,
    magicValue: null,
    stub: 'esp32c61',
    flashWriteSize: 0x400,
    ramBlockSize: 0x1800,
    bootloaderOffset: 0x0,
    macEfuseReg: 0x600b4800 + 0x044,
    spiRegBase: 0x60003000,
    ...MODERN_SPI,
    memoryMap: mapOf(0x42000000, 0x42800000, 0x42800000, 0x43000000),
    features: ['wifi', 'ble'],
  },
  {
    name: 'ESP32-C5',
    imageChipId: 23,
    usesMagicValue: false,
    magicValue: null,
    stub: 'esp32c5',
    flashWriteSize: 0x400,
    ramBlockSize: 0x1800,
    bootloaderOffset: 0x2000,
    macEfuseReg: 0x600b4800 + 0x044,
    spiRegBase: 0x60003000,
    ...MODERN_SPI,
    memoryMap: mapOf(0x42000000, 0x44000000, 0x42000000, 0x44000000),
    features: ['wifi', 'ble', 'ieee802154'],
  },
  {
    name: 'ESP32-H2',
    imageChipId: 16,
    usesMagicValue: false,
    magicValue: null,
    stub: 'esp32h2',
    flashWriteSize: 0x400,
    ramBlockSize: 0x1800,
    bootloaderOffset: 0x0,
    macEfuseReg: 0x600b0800 + 0x044,
    spiRegBase: 0x60003000,
    ...MODERN_SPI,
    memoryMap: mapOf(0x42000000, 0x42800000, 0x42800000, 0x43000000),
    features: ['ble', 'ieee802154'],
  },
  {
    name: 'ESP32-P4',
    imageChipId: 18,
    usesMagicValue: false,
    magicValue: null,
    stub: 'esp32p4',
    flashWriteSize: 0x400,
    ramBlockSize: 0x1800,
    bootloaderOffset: 0x2000,
    macEfuseReg: 0x5012d000 + 0x044,
    spiRegBase: 0x5008d000,
    ...MODERN_SPI,
    memoryMap: mapOf(0x40000000, 0x4c000000, 0x40000000, 0x4c000000),
    features: [],
  },
];

/** @type {Map<number, ChipDef>} */
const BY_CHIP_ID = new Map(CHIPS.map((c) => [c.imageChipId, c]));

/** @type {Map<number, ChipDef>} */
const BY_MAGIC = new Map(
  CHIPS.filter((c) => c.usesMagicValue && c.magicValue !== null).map((c) => [
    /** @type {number} */ (c.magicValue),
    c,
  ]),
);

/**
 * @param {number} chipId
 * @returns {ChipDef|undefined}
 */
export function chipByImageId(chipId) {
  return BY_CHIP_ID.get(chipId);
}

/**
 * @param {number} magic
 * @returns {ChipDef|undefined}
 */
export function chipByMagic(magic) {
  return BY_MAGIC.get(magic >>> 0);
}

/**
 * @param {string} name Case-insensitive, e.g. "esp32-s3".
 * @returns {ChipDef|undefined}
 */
export function chipByName(name) {
  const wanted = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return CHIPS.find((c) => c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === wanted);
}

/**
 * Flash size lookup from the SPI flash RDID response byte.
 * @type {Record<number, number>}
 */
export const FLASH_SIZE_BY_ID = {
  0x12: 256 * 1024,
  0x13: 512 * 1024,
  0x14: 1024 * 1024,
  0x15: 2 * 1024 * 1024,
  0x16: 4 * 1024 * 1024,
  0x17: 8 * 1024 * 1024,
  0x18: 16 * 1024 * 1024,
  0x19: 32 * 1024 * 1024,
  0x1a: 64 * 1024 * 1024,
  0x1b: 128 * 1024 * 1024,
  0x20: 64 * 1024 * 1024,
  0x21: 128 * 1024 * 1024,
  0x32: 256 * 1024,
  0x33: 512 * 1024,
  0x34: 1024 * 1024,
  0x35: 2 * 1024 * 1024,
  0x36: 4 * 1024 * 1024,
  0x37: 8 * 1024 * 1024,
  0x38: 16 * 1024 * 1024,
  0x39: 32 * 1024 * 1024,
};
