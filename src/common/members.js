'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependency is named here.
if (typeof require === 'function') require('./schema.js');

/**
 * The `browser.storage.local` entry holding the logins this extension has seen
 * carrying a member badge on each organization. It is its own entry and not
 * part of the per-advisory cache: a member badge says who belongs to the
 * organization, which outlives the advisory it was read on.
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
 * The organization a member belongs to, which is the owner half of
 * `owner/repo`. `AdvisoryRef` satisfies it, and so does `RepositoryRef`.
 *
 * @typedef {object} OrganizationRef
 * @property {string} owner
 */

/**
 * The logins seen carrying a member badge, keyed by the organization
 * lowercased and then by the login lowercased, and held as the login was
 * spelled where it was read. Membership is per organization, so a login badged
 * on one organization's advisories is not a member of another. GitHub treats
 * an organization name case-insensitively, and a login names one account
 * whatever its case, so both keys are folded and the spelling is held as it was
 * read.
 *
 * @type {Map<string, Map<string, string>>}
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

/**
 * @param {OrganizationRef | null | undefined} ref
 * @returns {string | null} the key this organization's members are held under,
 *   and null where the page did not say which organization it is.
 */
function keyOf(ref) {
  if (ref === null || ref === undefined) return null;
  const owner = String(ref.owner ?? '').trim().toLowerCase();
  return owner === '' ? null : owner;
}

/**
 * @param {string} key
 * @param {readonly unknown[]} logins
 * @returns {boolean} whether the set grew.
 */
function take(key, logins) {
  let grew = false;
  for (const login of logins) {
    if (typeof login !== 'string') continue;
    const name = login.trim();
    if (name === '') continue;
    const fold = name.toLowerCase();
    let held = seen.get(key);
    if (held === undefined) {
      held = new Map();
      seen.set(key, held);
    }
    if (held.has(fold)) continue;
    held.set(fold, name);
    grew = true;
  }
  return grew;
}

/**
 * Takes logins into the set this session holds for an organization. Nothing is
 * awaited, so a caller rendering from a parsed record has the page's members
 * the moment it has read them.
 *
 * @param {OrganizationRef | null | undefined} ref The organization the logins
 *   carry a member badge on.
 * @param {readonly unknown[]} logins
 * @returns {boolean} whether the set grew.
 */
function remember(ref, logins) {
  const key = keyOf(ref);
  return key === null ? false : take(key, logins);
}

/**
 * @param {OrganizationRef | null | undefined} ref
 * @returns {string[]} the logins seen carrying a member badge on this
 *   organization, oldest first.
 */
function known(ref) {
  const key = keyOf(ref);
  const held = key === null ? undefined : seen.get(key);
  return held === undefined ? [] : [...held.values()];
}

/**
 * @param {OrganizationRef | null | undefined} ref
 * @param {string | null | undefined} login
 * @returns {boolean} whether this login has been seen carrying a member badge
 *   on this organization.
 */
function isKnown(ref, login) {
  if (typeof login !== 'string') return false;
  const key = keyOf(ref);
  const held = key === null ? undefined : seen.get(key);
  return held === undefined ? false : held.has(login.trim().toLowerCase());
}

/** @returns {void} empties the set this session holds, leaving storage alone. */
function clear() {
  seen.clear();
}

/**
 * @param {unknown} value The entry as storage handed it back.
 * @returns {Map<string, string[]>} the logins it holds, by organization, and
 *   none where it holds something else. The entry is data an older version of
 *   this extension wrote, so its shape is checked and never assumed. A version
 *   before membership was per organization wrote one array of logins across
 *   every organization; that entry names no organization, is read as holding
 *   nothing, and is replaced the next time a session has a member to write.
 */
function organizationsOf(value) {
  /** @type {Map<string, string[]>} */
  const held = new Map();
  if (!globalThis.bghsa.schema.isPlainObject(value)) return held;
  for (const [key, logins] of Object.entries(value)) {
    if (!Array.isArray(logins)) continue;
    held.set(
      key,
      logins.filter((login) => typeof login === 'string' && login.trim() !== '')
    );
  }
  return held;
}

/**
 * @returns {Record<string, string[]>} the set this session holds, in the shape
 *   the entry takes.
 */
function entry() {
  /** @type {Record<string, string[]>} */
  const held = {};
  for (const [key, logins] of seen) held[key] = [...logins.values()];
  return held;
}

/**
 * @param {Map<string, string[]>} stored
 * @returns {boolean} whether this session holds an organization or a login the
 *   entry does not.
 */
function ahead(stored) {
  for (const [key, logins] of seen) {
    const held = stored.get(key);
    if (held === undefined) return true;
    const stock = new Set(held.map((login) => login.trim().toLowerCase()));
    for (const fold of logins.keys()) if (!stock.has(fold)) return true;
  }
  return false;
}

/**
 * Reads the stored logins into this session's set and writes the set back
 * where it holds a login the entry does not. The entry accumulates across
 * advisories and across sessions, and every page that carries a member badge
 * adds to its organization.
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
  /** @type {Map<string, string[]>} */
  let stored;
  try {
    stored = organizationsOf((await storage.get(MEMBERS_KEY))[MEMBERS_KEY]);
  } catch {
    return false;
  }
  let grew = false;
  for (const [key, logins] of stored) grew = take(key, logins) || grew;
  if (!ahead(stored)) return grew;
  try {
    await storage.set({ [MEMBERS_KEY]: entry() });
  } catch {
    return grew;
  }
  return grew;
}

globalThis.bghsa.members = {
  MEMBERS_KEY,
  setStorage,
  storageOf,
  keyOf,
  known,
  isKnown,
  remember,
  clear,
  sync,
};

if (typeof module !== 'undefined') {
  module.exports = globalThis.bghsa.members;
}
