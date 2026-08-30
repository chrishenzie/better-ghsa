'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The page's own script tags order these; under Node the dependencies are named
// here.
if (typeof require === 'function') {
  require('./schema.js');
  require('./allowlist.js');
  require('./members.js');
  require('./branches.js');
  require('./cache.js');
}

/**
 * The part of `browser.storage.local` this file uses. `chrome.storage.local`
 * satisfies it too, and so does a stand-in a test hands in.
 *
 * `get(null)` answers with every entry the extension holds, which is what the
 * clear reads to find the keys to take.
 *
 * @typedef {object} ForgetStorage
 * @property {(keys: string | string[] | null) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string | string[]) => Promise<void>} remove
 */

/**
 * @typedef {object} ForgetOptions
 * @property {ForgetStorage | null} [storage] The storage to read and write, and
 *   absent to use the one the cache names.
 */

/**
 * What one call took out of storage.
 *
 * @typedef {object} ForgetOutcome
 * @property {number} taken How many whole storage keys were removed.
 * @property {boolean} branches Whether the branches entry changed.
 * @property {boolean} members Whether the members entry changed.
 */

(() => {
  /**
   * @returns {ForgetStorage | null} the storage to read and write. The cache
   *   already answers for `browser.storage.local` under either of the names a
   *   browser gives the extension API, and it is the store most of these keys
   *   belong to, so this asks it rather than repeating the lookup.
   */
  function storageOf() {
    return /** @type {ForgetStorage | null} */ (
      /** @type {unknown} */ (globalThis.bghsa.cache.storageOf())
    );
  }

  /**
   * Every repository this file reads is normalized the way the allowlist
   * normalizes it, trimmed and lowercased, because that is how the allowlist
   * stores it and how every storage key here spells it.
   *
   * @param {unknown} value A repository as `owner/repo`.
   * @returns {string} the owner half, lowercased, and empty where the value
   *   names no repository. The members entry is keyed by this.
   */
  function ownerOf(value) {
    const entry = globalThis.bghsa.allowlist.normalize(value);
    const cut = entry.indexOf('/');
    return cut <= 0 ? '' : entry.slice(0, cut);
  }

  /**
   * The storage keys holding what was read of one repository.
   *
   * The advisory keys are matched on `adv:{owner}/{repo}:`, the colon included,
   * and the list and progress keys are compared whole. Neither an owner nor a
   * repository name may carry a `/` or a `:`, so `owner/repo:` ends at exactly
   * one repository: the trailing colon is what keeps `containerd/con` from
   * matching `containerd/containerd`, whose keys read `adv:containerd/
   * containerd:GHSA-...`. Matching `adv:{owner}/{repo}` without it would take
   * every repository whose name begins with this one's.
   *
   * @param {unknown} repository The repository, as `owner/repo`.
   * @param {readonly string[]} keys Every key storage holds.
   * @returns {string[]} the ones belonging to that repository, and none where
   *   the value names no repository.
   */
  function keysFor(repository, keys) {
    const entry = globalThis.bghsa.allowlist.normalize(repository);
    if (ownerOf(entry) === '') return [];
    const cache = globalThis.bghsa.cache;
    const advisories = `${cache.ADVISORY_PREFIX}${entry}:`;
    const list = `${cache.LIST_PREFIX}${entry}`;
    const progress = `${cache.PROGRESS_PREFIX}${entry}`;
    return keys.filter((key) => key === list || key === progress || key.startsWith(advisories));
  }

  /**
   * Reads every key storage holds. A storage that fails answers with none, and
   * the caller then takes nothing, which is the cache staying where it stands.
   *
   * @param {ForgetStorage} storage
   * @returns {Promise<Record<string, unknown>>}
   */
  async function held(storage) {
    try {
      return await storage.get(null);
    } catch {
      return {};
    }
  }

  /**
   * Takes keys out of storage. Failing costs the caller nothing: the entries
   * stay, and everything here is rederivable by reading the advisories again.
   *
   * @param {ForgetStorage} storage
   * @param {readonly string[]} keys
   * @returns {Promise<number>} how many were taken, and none where the removal
   *   failed.
   */
  async function discard(storage, keys) {
    if (keys.length === 0) return 0;
    try {
      await storage.remove([...keys]);
    } catch {
      return 0;
    }
    return keys.length;
  }

  /**
   * Takes one repository or one organization out of an entry that holds a map
   * of them, which is what the `members` and `branches` entries are. The entry
   * is written back without it, and taken away once it holds nothing.
   *
   * The entry is data an older version of this extension wrote, so its shape is
   * checked and never assumed: one holding something other than an object is
   * left where it stands.
   *
   * @param {ForgetStorage} storage
   * @param {string} key The entry's key.
   * @param {string} member The repository or organization to drop, lowercased.
   * @returns {Promise<boolean>} whether the entry changed.
   */
  async function prune(storage, key, member) {
    if (member === '') return false;
    /** @type {unknown} */
    let value;
    try {
      value = (await storage.get(key))[key];
    } catch {
      return false;
    }
    if (!globalThis.bghsa.schema.isPlainObject(value)) return false;
    /** @type {Record<string, unknown>} */
    const kept = {};
    let dropped = false;
    for (const [name, entry] of Object.entries(value)) {
      if (name.trim().toLowerCase() === member) dropped = true;
      else kept[name] = entry;
    }
    if (!dropped) return false;
    try {
      if (Object.keys(kept).length === 0) await storage.remove(key);
      else await storage.set({ [key]: kept });
    } catch {
      return false;
    }
    return true;
  }

  /**
   * @param {unknown} repository The repository being taken off the list.
   * @param {readonly unknown[]} remaining The repositories still on it.
   * @returns {boolean} whether any of them belongs to the same organization.
   *   The members entry is keyed by organization, not by repository, so it is
   *   this and not the repository that says whether the entry is still earning
   *   its keep. REQUIREMENTS.md section 2.
   */
  function organizationListed(repository, remaining) {
    const owner = ownerOf(repository);
    if (owner === '') return false;
    return remaining.some((entry) => ownerOf(entry) === owner);
  }

  /**
   * Empties everything the extension read: the advisory reads, the list reads,
   * the refresh progress, and the members and branches it observed. The
   * repository list is left alone, because clearing it would turn the extension
   * off. REQUIREMENTS.md section 2.
   *
   * Nothing here is authoritative. Every entry is rederivable by reading the
   * advisories again, so this costs reads and nothing else, and no confirmation
   * stands in front of it.
   *
   * @param {ForgetOptions} [options]
   * @returns {Promise<ForgetOutcome>}
   */
  async function everything(options = {}) {
    globalThis.bghsa.members.clear();
    globalThis.bghsa.branches.clear();
    const storage = options.storage ?? storageOf();
    if (storage === null) return { taken: 0, branches: false, members: false };
    const cache = globalThis.bghsa.cache;
    const keys = Object.keys(await held(storage));
    const members = keys.includes(globalThis.bghsa.members.MEMBERS_KEY);
    const branches = keys.includes(globalThis.bghsa.branches.BRANCHES_KEY);
    const wanted = keys.filter(
      (key) =>
        cache.isCacheKey(key) ||
        key === globalThis.bghsa.members.MEMBERS_KEY ||
        key === globalThis.bghsa.branches.BRANCHES_KEY
    );
    const taken = await discard(storage, wanted);
    return { taken, branches: branches && taken > 0, members: members && taken > 0 };
  }

  /**
   * Empties what was read of one repository, which is what taking it off the
   * list leaves behind: its advisory reads, its list reads, its refresh
   * progress, and the release branches observed on it.
   *
   * The organization's members are keyed by organization and not by repository,
   * so they go only where no repository from that organization is still listed.
   * REQUIREMENTS.md section 2.
   *
   * @param {unknown} entry The repository, as `owner/repo`.
   * @param {readonly unknown[]} [remaining] The repositories still on the list.
   * @param {ForgetOptions} [options]
   * @returns {Promise<ForgetOutcome>}
   */
  async function repository(entry, remaining = [], options = {}) {
    const wanted = globalThis.bghsa.allowlist.normalize(entry);
    const storage = options.storage ?? storageOf();
    if (storage === null || ownerOf(wanted) === '') {
      return { taken: 0, branches: false, members: false };
    }
    const taken = await discard(storage, keysFor(wanted, Object.keys(await held(storage))));
    const branches = await prune(storage, globalThis.bghsa.branches.BRANCHES_KEY, wanted);
    const members = organizationListed(wanted, remaining)
      ? false
      : await prune(storage, globalThis.bghsa.members.MEMBERS_KEY, ownerOf(wanted));
    return { taken, branches, members };
  }

  const exported = {
    storageOf,
    keysFor,
    everything,
    repository,
  };

  globalThis.bghsa.forget = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
