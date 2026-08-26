'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

/**
 * The `browser.storage.local` entry holding the logins this extension has seen
 * carrying a member badge. It is its own entry and not part of the
 * per-advisory cache: a member badge says who belongs to the organization,
 * which outlives the advisory it was read on.
 */
const MEMBERS_KEY = 'members';

/**
 * The part of `browser.storage.local` this file uses. `chrome.storage.local`
 * satisfies it too, and so does a stand-in a test hands to
 * {@link setStorage}.
 *
 * @typedef {object} MemberStorage
 * @property {(key: string) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 */

/**
 * The logins seen carrying a member badge, keyed by the lowercased login and
 * held as the login was spelled where it was read. Logins differ in case
 * between the places GitHub renders them and name one account.
 *
 * @type {Map<string, string>}
 */
const seen = new Map();

/**
 * The storage a caller put in place of the browser's, and null while the
 * browser's own is what to use.
 *
 * @type {MemberStorage | null}
 */
let injected = null;

/**
 * @returns {MemberStorage | null} `storage.local` under whichever name this
 *   browser gives the extension API, and null where there is none, which is
 *   every environment outside a browser.
 */
function browserStorage() {
  const global = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
  for (const name of ['browser', 'chrome']) {
    const api = /** @type {{ storage?: { local?: MemberStorage } } | undefined} */ (global[name]);
    const local = api?.storage?.local;
    if (local === undefined || local === null) continue;
    if (typeof local.get === 'function' && typeof local.set === 'function') return local;
  }
  return null;
}

/**
 * @param {MemberStorage | null} storage The storage to use, and null to go
 *   back to the browser's own.
 * @returns {void}
 */
function setStorage(storage) {
  injected = storage;
}

/** @returns {MemberStorage | null} the storage this file reads and writes. */
function storageOf() {
  return injected ?? browserStorage();
}

/** @returns {string[]} the logins seen carrying a member badge, oldest first. */
function known() {
  return [...seen.values()];
}

/**
 * @param {string | null | undefined} login
 * @returns {boolean} whether this login has been seen carrying a member badge.
 */
function isKnown(login) {
  if (typeof login !== 'string') return false;
  return seen.has(login.trim().toLowerCase());
}

/**
 * Takes logins into the set this session holds. Nothing is awaited, so a
 * caller rendering from a parsed record has the page's members the moment it
 * has read them.
 *
 * @param {readonly (string | null | undefined)[]} logins
 * @returns {boolean} whether the set grew.
 */
function remember(logins) {
  let grew = false;
  for (const login of logins) {
    if (typeof login !== 'string') continue;
    const name = login.trim();
    if (name === '') continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.set(key, name);
    grew = true;
  }
  return grew;
}

/** @returns {void} empties the set this session holds, leaving storage alone. */
function clear() {
  seen.clear();
}

/**
 * @param {unknown} value The entry as storage handed it back.
 * @returns {string[]} the logins it holds, and none where it holds something
 *   else. The entry is data an older version of this extension wrote, so its
 *   shape is checked and never assumed.
 */
function loginsOf(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((login) => typeof login === 'string' && login.trim() !== '');
}

/**
 * Reads the stored logins into this session's set and writes the set back
 * where it holds a login the entry does not. The entry accumulates across
 * advisories and across sessions, and every page that carries a member badge
 * adds to it.
 *
 * Storage failing costs the panel nothing: the set still holds what this
 * session has read, and this runs again on the next page.
 *
 * @param {MemberStorage | null} [storage]
 * @returns {Promise<boolean>} whether storage taught this session a login it
 *   did not have, which is when what was drawn from the set is out of date.
 */
async function sync(storage = storageOf()) {
  if (storage === null) return false;
  /** @type {string[]} */
  let stored;
  try {
    stored = loginsOf((await storage.get(MEMBERS_KEY))[MEMBERS_KEY]);
  } catch {
    return false;
  }
  const grew = remember(stored);
  const held = new Set(stored.map((login) => login.trim().toLowerCase()));
  if ([...seen.keys()].every((key) => held.has(key))) return grew;
  try {
    await storage.set({ [MEMBERS_KEY]: known() });
  } catch {
    return grew;
  }
  return grew;
}

globalThis.bghsa.members = {
  MEMBERS_KEY,
  setStorage,
  storageOf,
  known,
  isKnown,
  remember,
  clear,
  sync,
};

if (typeof module !== 'undefined') {
  module.exports = globalThis.bghsa.members;
}
