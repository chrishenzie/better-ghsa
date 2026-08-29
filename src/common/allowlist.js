'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependency is named here.
if (typeof require === 'function') require('./storage.js');

/**
 * The part of `browser.storage.local` this file uses. `chrome.storage.local`
 * satisfies it too, and so does a stand-in a test hands to {@link setStorage}.
 *
 * This is declared here rather than read from `src/common/cache.js`, which
 * declares the same shape, because the gate has to answer before the cache has
 * loaded.
 *
 * @typedef {object} AllowlistStorage
 * @property {(keys: string | string[] | null) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 */

(() => {
  /**
   * The key the list is stored under in `browser.storage.local`.
   *
   * Nothing is stored under it on a fresh install, and an absent value is an
   * empty list, so the extension runs nowhere until a maintainer names a
   * repository in the settings page. REQUIREMENTS.md section 12.
   */
  const STORAGE_KEY = 'allowlist';

  /**
   * What an entry looks like: `owner/repo`, as GitHub allows each half to be
   * spelled. An owner is alphanumeric with interior hyphens; a repository name
   * also takes dots and underscores.
   */
  const OWNER = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d]))*$/;
  const REPO = /^[a-z\d._-]+$/;

  /** The longest owner and repository name GitHub accepts. */
  const MAX_OWNER = 39;
  const MAX_REPO = 100;

  /**
   * The list, and null until storage has answered. Null is what makes an
   * unloaded gate closed rather than open: {@link isAllowed} is synchronous and
   * reads this, so before the read lands every repository is off the list.
   *
   * @type {readonly string[] | null}
   */
  let entries = null;

  /**
   * The read in flight, so concurrent callers share one, and null when none has
   * been started or the last one has landed.
   *
   * @type {Promise<readonly string[]> | null}
   */
  let reading = null;

  /**
   * The storage a caller put in place of the browser's, and null while the
   * browser's own is what to use.
   *
   * @type {AllowlistStorage | null}
   */
  let injected = null;

  /**
   * Whoever wants to hear that the list has changed. The gate in
   * `src/content.js` is one: a repository taken off the list has to stop the
   * extension on a page already showing it.
   *
   * @type {Set<(entries: readonly string[]) => void>}
   */
  const listeners = new Set();

  /** Whether {@link watch} has already subscribed to the browser's changes. */
  let watching = false;

  /**
   * @returns {AllowlistStorage | null} `storage.local`, and null where there is
   *   none, which is every environment outside a browser.
   */
  function browserStorage() {
    return /** @type {AllowlistStorage | null} */ (globalThis.bghsa.storage.local());
  }

  /** @returns {AllowlistStorage | null} the storage this file reads and writes. */
  function storageOf() {
    return injected ?? browserStorage();
  }

  /**
   * @param {AllowlistStorage | null} storage The storage to use, and null to go
   *   back to the browser's own.
   * @returns {void} puts the list back to unloaded, because the answer held in
   *   memory came from the storage being replaced.
   */
  function setStorage(storage) {
    injected = storage;
    entries = null;
    reading = null;
  }

  /**
   * @param {unknown} value
   * @returns {string} the entry as it is compared and stored: trimmed, and
   *   lowercased because GitHub treats owner and repository names
   *   case-insensitively and the comparison here does too.
   */
  function normalize(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  /**
   * Whether a typed entry names a repository. It is a shape test, not an
   * existence test: nothing here asks GitHub whether the repository is real.
   *
   * @param {unknown} value
   * @returns {boolean}
   */
  function isValid(value) {
    const entry = normalize(value);
    const parts = entry.split('/');
    if (parts.length !== 2) return false;
    const [owner, repo] = parts;
    if (owner === undefined || repo === undefined) return false;
    if (owner.length === 0 || owner.length > MAX_OWNER) return false;
    if (repo.length === 0 || repo.length > MAX_REPO) return false;
    if (repo === '.' || repo === '..') return false;
    return OWNER.test(owner) && REPO.test(repo);
  }

  /**
   * @param {unknown} value What storage answered with, which is data an older
   *   version of this extension wrote and is never assumed to be a list.
   * @returns {readonly string[]} the entries in it, normalized, valid, and
   *   deduplicated.
   */
  function sanitize(value) {
    if (!Array.isArray(value)) return [];
    /** @type {string[]} */
    const kept = [];
    for (const item of value) {
      if (!isValid(item)) continue;
      const entry = normalize(item);
      if (!kept.includes(entry)) kept.push(entry);
    }
    return kept;
  }

  /** @returns {readonly string[]} the list, empty while it is unloaded. */
  function current() {
    return entries ?? [];
  }

  /** @returns {boolean} whether storage has answered yet. */
  function loaded() {
    return entries !== null;
  }

  /**
   * @param {readonly string[]} next
   * @returns {void} holds the list and tells whoever asked to hear, where it
   *   differs from the one held. A listener that throws does not keep the next
   *   from hearing.
   */
  function adopt(next) {
    const before = entries;
    entries = next;
    if (before !== null && before.length === next.length && before.every((e, i) => e === next[i])) {
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // A listener that cannot take the change is not a reason to keep the
        // rest from hearing it.
      }
    }
  }

  /**
   * Reads the list from storage, once. Concurrent callers share the read, and a
   * caller after it has landed gets the answer without another read.
   *
   * A storage that is absent or that fails answers empty, which is the closed
   * gate: the extension does nothing rather than acting on a repository it
   * cannot confirm anybody listed.
   *
   * @returns {Promise<readonly string[]>}
   */
  function load() {
    if (entries !== null) return Promise.resolve(entries);
    if (reading !== null) return reading;
    const storage = storageOf();
    reading = (async () => {
      if (storage === null) return [];
      try {
        const held = await storage.get(STORAGE_KEY);
        return sanitize(held?.[STORAGE_KEY]);
      } catch {
        return [];
      }
    })().then((next) => {
      reading = null;
      adopt(next);
      return next;
    });
    return reading;
  }

  /**
   * Whether the extension runs on a repository. The comparison is
   * case-insensitive, matching GitHub's treatment of owner and repository
   * names.
   *
   * This is synchronous, and storage is not. Until {@link load} has landed the
   * list is unknown, and an unknown answer is no: the alternative injects a
   * surface and fills the cache on a repository nobody listed. REQUIREMENTS.md
   * section 12.
   *
   * @param {string} nameWithOwner `owner/repo`
   * @returns {boolean}
   */
  function isAllowed(nameWithOwner) {
    if (entries === null) return false;
    const wanted = normalize(nameWithOwner);
    if (wanted === '') return false;
    return entries.includes(wanted);
  }

  /**
   * @param {readonly unknown[]} next The list to store. Entries are normalized,
   *   invalid ones are dropped, and duplicates collapse.
   * @returns {Promise<readonly string[]>} what was stored.
   */
  async function save(next) {
    const kept = sanitize(next);
    const storage = storageOf();
    if (storage !== null) await storage.set({ [STORAGE_KEY]: [...kept] });
    adopt(kept);
    return kept;
  }

  /**
   * @param {unknown} value A repository as a maintainer typed it.
   * @returns {Promise<{ ok: boolean, entry: string, reason: string | null }>}
   *   what was added, and why nothing was where it was not.
   */
  async function add(value) {
    const entry = normalize(value);
    if (entry === '') return { ok: false, entry, reason: 'empty' };
    if (!isValid(entry)) return { ok: false, entry, reason: 'malformed' };
    const held = await load();
    if (held.includes(entry)) return { ok: false, entry, reason: 'duplicate' };
    await save([...held, entry]);
    return { ok: true, entry, reason: null };
  }

  /**
   * @param {unknown} value
   * @returns {Promise<readonly string[]>} the list without that repository.
   */
  async function remove(value) {
    const entry = normalize(value);
    const held = await load();
    return save(held.filter((held_) => held_ !== entry));
  }

  /**
   * @param {(entries: readonly string[]) => void} listener
   * @returns {() => void} stops the listener hearing.
   */
  function subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /**
   * Takes the list from the browser whenever another page of this extension
   * writes it, so a settings page open beside an advisory changes what that
   * advisory's page does without either being reloaded.
   *
   * @returns {boolean} whether this call subscribed. False where the browser
   *   offers no change events, which is every environment outside a browser,
   *   and where a previous call already did.
   */
  function watch() {
    if (watching) return false;
    // The API the change is watched on is the one the read came from, so a
    // shim under one name does not have this listening to a store nothing here
    // reads.
    const onChanged = globalThis.bghsa.storage.api()?.storage?.onChanged;
    if (typeof onChanged?.addListener !== 'function') return false;
    watching = true;
    onChanged.addListener(
      /**
       * @param {Record<string, { newValue?: unknown }>} changes
       * @param {string} [area]
       * @returns {void}
       */
      (changes, area) => {
        if (area !== undefined && area !== 'local') return;
        if (changes === null || typeof changes !== 'object') return;
        if (!Object.hasOwn(changes, STORAGE_KEY)) return;
        adopt(sanitize(changes[STORAGE_KEY]?.newValue));
      }
    );
    return true;
  }

  const exported = {
    STORAGE_KEY,
    normalize,
    isValid,
    current,
    loaded,
    load,
    isAllowed,
    save,
    add,
    remove,
    subscribe,
    watch,
    setStorage,
    storageOf,
  };

  globalThis.bghsa.allowlist = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
