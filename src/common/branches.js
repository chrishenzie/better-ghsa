'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependency is named here.
if (typeof require === 'function') require('./schema.js');

/**
 * The part of `browser.storage.local` this file uses. `chrome.storage.local`
 * satisfies it too, and so does a stand-in a test hands to
 * {@link setStorage}.
 *
 * @typedef {object} BranchStorage
 * @property {(key: string) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 */

/**
 * The repository a branch set belongs to. `AdvisoryRef` satisfies it.
 *
 * @typedef {object} RepositoryRef
 * @property {string} owner
 * @property {string} repo
 */

(() => {
  /**
   * The `browser.storage.local` entry holding the release branches this
   * extension has seen on each repository. It is its own entry and not part of
   * the per-advisory cache: a repository's branches are the same for every
   * advisory on that repository and outlive the advisory they were read on.
   */
  const BRANCHES_KEY = 'branches';

  /** What the name of a release branch begins with. */
  const RELEASE_PREFIX = 'release/';

  /**
   * What a branch name looks like once the version is all that is left of it:
   * dot-separated runs of digits, behind an optional `v`.
   */
  const VERSION_PATTERN = /^v?(\d+(?:\.\d+)*)$/;

  /**
   * The release branches seen, keyed by the repository as `owner/repo`
   * lowercased. GitHub treats a repository name case-insensitively and a branch
   * name case-sensitively, so the key is folded and the names are held as they
   * were read.
   *
   * @type {Map<string, Set<string>>}
   */
  const seen = new Map();

  /**
   * The storage a caller put in place of the browser's, and null while the
   * browser's own is what to use.
   *
   * @type {BranchStorage | null}
   */
  let injected = null;

  /**
   * @returns {BranchStorage | null} `storage.local` under whichever name this
   *   browser gives the extension API, and null where there is none, which is
   *   every environment outside a browser.
   */
  function browserStorage() {
    const global = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
    for (const name of ['browser', 'chrome']) {
      const api = /** @type {{ storage?: { local?: BranchStorage } } | undefined} */ (global[name]);
      const local = api?.storage?.local;
      if (local === undefined || local === null) continue;
      if (typeof local.get === 'function' && typeof local.set === 'function') return local;
    }
    return null;
  }

  /**
   * @param {BranchStorage | null} storage The storage to use, and null to go
   *   back to the browser's own.
   * @returns {void}
   */
  function setStorage(storage) {
    injected = storage;
  }

  /** @returns {BranchStorage | null} the storage this file reads and writes. */
  function storageOf() {
    return injected ?? browserStorage();
  }

  /**
   * @param {RepositoryRef | null | undefined} ref
   * @returns {string | null} the key this repository's branches are held under,
   *   and null where the page did not say which repository it is.
   */
  function keyOf(ref) {
    if (ref === null || ref === undefined) return null;
    const owner = String(ref.owner ?? '').trim().toLowerCase();
    const repo = String(ref.repo ?? '').trim().toLowerCase();
    return owner === '' || repo === '' ? null : `${owner}/${repo}`;
  }

  /**
   * @param {unknown} name
   * @returns {boolean} whether this is the name of a release branch.
   */
  function isRelease(name) {
    return (
      typeof name === 'string' &&
      name.startsWith(RELEASE_PREFIX) &&
      name.length > RELEASE_PREFIX.length
    );
  }

  /**
   * @param {string} branch
   * @returns {number[] | null} the version the branch name carries, most
   *   significant component first, and null where it carries none. `release/`
   *   is not part of the version, and neither is a leading `v`.
   */
  function versionOf(branch) {
    const tail = branch.startsWith(RELEASE_PREFIX) ? branch.slice(RELEASE_PREFIX.length) : branch;
    const match = VERSION_PATTERN.exec(tail);
    if (match === null) return null;
    return /** @type {string} */ (match[1]).split('.').map(Number);
  }

  /**
   * Orders two branch names as the candidate list offers them: by version
   * descending, so `release/2.10` comes before `release/2.9`. String order puts
   * those two the other way round, because it compares `1` against `9` and stops
   * there.
   *
   * A component a version does not carry counts below every component another
   * one does, so `release/2.10.1` comes before `release/2.10`.
   *
   * A name that carries no version has no place in that order. It sorts after
   * every name that does, and names carrying no version sort among themselves by
   * code point, so a maintainer reading the list twice reads it the same way.
   *
   * @param {string} left
   * @param {string} right
   * @returns {number} negative where `left` is offered first.
   */
  function compare(left, right) {
    const first = versionOf(left);
    const second = versionOf(right);
    if (first === null || second === null) {
      if (first !== null) return -1;
      if (second !== null) return 1;
    } else {
      for (let index = 0; index < Math.max(first.length, second.length); index += 1) {
        const one = first[index] ?? -1;
        const two = second[index] ?? -1;
        if (one !== two) return two - one;
      }
    }
    return left < right ? -1 : left > right ? 1 : 0;
  }

  /**
   * @param {readonly string[]} names
   * @returns {string[]} those names in the order the candidate list offers them.
   */
  function order(names) {
    return [...names].sort(compare);
  }

  /**
   * @param {string} key
   * @param {readonly unknown[]} names
   * @returns {boolean} whether the set grew.
   */
  function take(key, names) {
    let grew = false;
    for (const name of names) {
      if (typeof name !== 'string') continue;
      const branch = name.trim();
      if (!isRelease(branch)) continue;
      let held = seen.get(key);
      if (held === undefined) {
        held = new Set();
        seen.set(key, held);
      }
      if (held.has(branch)) continue;
      held.add(branch);
      grew = true;
    }
    return grew;
  }

  /**
   * Takes release branch names into the set this session holds. Nothing is
   * awaited, so a caller rendering from a parsed record has this page's branches
   * the moment it has read them.
   *
   * A name that is not a release branch is left out: the panel offers backport
   * targets, and REQUIREMENTS.md section 6 has those be release branches.
   *
   * @param {RepositoryRef | null | undefined} ref The repository the names
   *   belong to.
   * @param {readonly unknown[]} names
   * @returns {boolean} whether the set grew.
   */
  function remember(ref, names) {
    const key = keyOf(ref);
    return key === null ? false : take(key, names);
  }

  /**
   * @param {RepositoryRef | null | undefined} ref
   * @returns {string[]} the release branches seen on this repository, in the
   *   order the candidate list offers them.
   */
  function known(ref) {
    const key = keyOf(ref);
    const held = key === null ? undefined : seen.get(key);
    return held === undefined ? [] : order([...held]);
  }

  /** @returns {void} empties the set this session holds, leaving storage alone. */
  function clear() {
    seen.clear();
  }

  /**
   * @param {unknown} value The entry as storage handed it back.
   * @returns {Map<string, string[]>} the branches it holds, by repository, and
   *   none where it holds something else. The entry is data an older version of
   *   this extension wrote, so its shape is checked and never assumed.
   */
  function repositoriesOf(value) {
    /** @type {Map<string, string[]>} */
    const held = new Map();
    if (!globalThis.bghsa.schema.isPlainObject(value)) return held;
    for (const [key, names] of Object.entries(value)) {
      if (!Array.isArray(names)) continue;
      held.set(
        key,
        names.filter((name) => typeof name === 'string' && name.trim() !== '')
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
    for (const [key, names] of seen) held[key] = [...names];
    return held;
  }

  /**
   * @param {Map<string, string[]>} stored
   * @returns {boolean} whether this session holds a repository or a branch the
   *   entry does not.
   */
  function ahead(stored) {
    for (const [key, names] of seen) {
      const held = stored.get(key);
      if (held === undefined) return true;
      const stock = new Set(held);
      for (const name of names) if (!stock.has(name)) return true;
    }
    return false;
  }

  /**
   * Reads the stored branches into this session's set and writes the set back
   * where it holds a branch the entry does not. The entry accumulates across
   * advisories and across sessions, because a repository's release branches are
   * the same on every advisory it has.
   *
   * Storage failing costs the panel nothing: the set still holds what this
   * session has read, and this runs again on the next page.
   *
   * @param {BranchStorage | null} [storage]
   * @returns {Promise<boolean>} whether storage taught this session a branch it
   *   did not have, which is when what was drawn from the set is out of date.
   */
  async function sync(storage = storageOf()) {
    if (storage === null) return false;
    /** @type {Map<string, string[]>} */
    let stored;
    try {
      stored = repositoriesOf((await storage.get(BRANCHES_KEY))[BRANCHES_KEY]);
    } catch {
      return false;
    }
    let grew = false;
    for (const [key, names] of stored) grew = take(key, names) || grew;
    if (!ahead(stored)) return grew;
    try {
      await storage.set({ [BRANCHES_KEY]: entry() });
    } catch {
      return grew;
    }
    return grew;
  }

  const exported = {
    BRANCHES_KEY,
    setStorage,
    storageOf,
    keyOf,
    isRelease,
    versionOf,
    compare,
    order,
    remember,
    known,
    clear,
    sync,
  };

  globalThis.bghsa.branches = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
