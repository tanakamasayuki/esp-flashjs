// @ts-check
/**
 * Localization.
 *
 * The library never produces user-facing text: it returns stable `code` values
 * and parameter objects. Turning those into words happens here, which is what
 * lets a third-party app embed the library and keep its own wording.
 *
 * Adding a language means adding one JSON file and one entry in LOCALES. No
 * code changes.
 */

/** @typedef {{code: string, nativeName: string}} LocaleInfo */

/** @type {LocaleInfo[]} */
export const LOCALES = [
  { code: 'en', nativeName: 'English' },
  { code: 'ja', nativeName: '日本語' },
  { code: 'zh-Hans', nativeName: '简体中文' },
  { code: 'zh-Hant', nativeName: '繁體中文' },
];

/** English is the fallback and the only file guaranteed to hold every key. */
export const FALLBACK_LOCALE = 'en';

const STORAGE_KEY = 'esp-flashjs.locale';

/**
 * Browser tags that do not match a locale code directly.
 * Chinese is split by script rather than region: 简体 and 繁體 differ in
 * vocabulary, not just glyphs, so they are separate locales.
 * @type {Record<string, string>}
 */
const TAG_ALIASES = {
  'zh-cn': 'zh-Hans',
  'zh-sg': 'zh-Hans',
  'zh-my': 'zh-Hans',
  zh: 'zh-Hans',
  'zh-tw': 'zh-Hant',
  'zh-hk': 'zh-Hant',
  'zh-mo': 'zh-Hant',
};

/** @type {Record<string, string>} */
let messages = {};
/** @type {Record<string, string>} */
let fallbackMessages = {};
/** @type {string} */
let currentLocale = FALLBACK_LOCALE;
/** @type {Set<() => void>} */
const listeners = new Set();
/** @type {Set<string>} */
const reportedMissing = new Set();

/**
 * Chooses a locale from an explicit preference or the browser's settings.
 *
 * @param {string[]} [preferred] Defaults to `navigator.languages`.
 * @returns {string}
 */
export function resolveLocale(preferred) {
  const stored = readStoredLocale();
  if (stored) return stored;

  const tags = preferred ?? (typeof navigator !== 'undefined' ? [...navigator.languages] : []);
  const known = new Set(LOCALES.map((l) => l.code));

  for (const tag of tags) {
    const lower = tag.toLowerCase();

    // Exact match, case-insensitively: "zh-Hant".
    const exact = LOCALES.find((l) => l.code.toLowerCase() === lower);
    if (exact) return exact.code;

    // Region tags that imply a script: "zh-TW" means Traditional.
    if (TAG_ALIASES[lower]) return TAG_ALIASES[lower];

    // Language subtag alone: "ja-JP" means "ja".
    const base = lower.split('-')[0];
    if (TAG_ALIASES[base]) return TAG_ALIASES[base];
    if (known.has(base)) return base;
  }

  return FALLBACK_LOCALE;
}

/**
 * Loads the resolved locale plus the English fallback.
 *
 * @param {string} [locale] Overrides detection.
 * @returns {Promise<string>} The locale actually in use.
 */
export async function initI18n(locale) {
  const target = locale ?? resolveLocale();
  fallbackMessages = await loadCatalog(FALLBACK_LOCALE);
  messages = target === FALLBACK_LOCALE ? fallbackMessages : await loadCatalog(target);
  currentLocale = target;
  applyDocumentLanguage(target);
  notify();
  return target;
}

/**
 * Switches language and re-renders.
 *
 * @param {string} locale
 * @returns {Promise<void>}
 */
export async function setLocale(locale) {
  if (locale === currentLocale) return;
  messages = locale === FALLBACK_LOCALE ? fallbackMessages : await loadCatalog(locale);
  currentLocale = locale;
  writeStoredLocale(locale);
  applyDocumentLanguage(locale);
  notify();
}

/** @returns {string} */
export function getLocale() {
  return currentLocale;
}

/** @returns {LocaleInfo[]} */
export function availableLocales() {
  return LOCALES;
}

/**
 * Translates a key, interpolating `{name}` placeholders.
 *
 * An unknown key returns the key itself. A blank label is harder to diagnose
 * than a visibly wrong one, and it should never take down a screen.
 *
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function t(key, params) {
  let template = messages[key];
  if (template === undefined) {
    template = fallbackMessages[key];
    if (template !== undefined && !reportedMissing.has(key)) {
      reportedMissing.add(key);
      console.warn(`[i18n] "${key}" is missing from ${currentLocale}; using English.`);
    }
  }
  if (template === undefined) {
    if (!reportedMissing.has(key)) {
      reportedMissing.add(key);
      console.warn(`[i18n] unknown key "${key}".`);
    }
    return key;
  }
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

/**
 * Translates an Issue or an error from the library.
 *
 * @param {{code: string, params?: Record<string, unknown>}} issue
 * @param {string} [prefix] Namespace to try first, e.g. "error".
 * @returns {string}
 */
export function tIssue(issue, prefix) {
  const key = prefix ? `${prefix}.${issue.code}` : issue.code;
  const params = localizeIssueParams(issue.params, (k) => messages[k] ?? fallbackMessages[k]);
  const translated = t(key, params);
  return translated === key && prefix ? t(issue.code, params) : translated;
}

/**
 * Resolves parameters that name something the library has a display name for.
 *
 * The library never produces prose, so an issue carries identifiers: a
 * `format` parameter is `phy-init`, not "PHY init data". Interpolating it
 * straight into a sentence put the identifier on screen — "This looks like a
 * phy-init partition" — right next to a heading that had translated the same
 * thing properly.
 *
 * Only `format` is treated this way, and only when a display name exists. An
 * identifier with no name is shown as it is, which is still better than a
 * blank, and says plainly that a name is missing.
 *
 * @param {Record<string, unknown>|undefined} params
 * @param {(key: string) => string|undefined} lookup
 * @returns {Record<string, unknown>|undefined}
 */
export function localizeIssueParams(params, lookup) {
  if (!params || typeof params.format !== 'string') return params;
  const name = lookup(`analyze.format.${params.format}`);
  return name === undefined ? params : { ...params, format: name };
}

/**
 * Registers a callback fired whenever the language changes.
 * @param {() => void} listener
 * @returns {() => void} Unsubscribe.
 */
export function onLocaleChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * @param {string} locale
 * @returns {Promise<Record<string, string>>}
 */
async function loadCatalog(locale) {
  try {
    const response = await fetch(new URL(`./locales/${locale}.json`, import.meta.url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(`[i18n] could not load "${locale}":`, error);
    return locale === FALLBACK_LOCALE ? {} : fallbackMessages;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

/** @param {string} locale */
function applyDocumentLanguage(locale) {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

/** @returns {string|null} */
function readStoredLocale() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && LOCALES.some((l) => l.code === stored) ? stored : null;
  } catch {
    // Storage can be blocked outright; detection still works without it.
    return null;
  }
}

/** @param {string} locale */
function writeStoredLocale(locale) {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* not fatal */
  }
}
