'use strict';

/**
 * A stand-in for `browser.storage.local`, and what it recorded.
 *
 * @typedef {object} FakeStorage
 * @property {Record<string, unknown>} entries What it holds now.
 * @property {(string | string[] | null | undefined)[]} reads The keys of every
 *   `get`, in the order they were asked.
 * @property {Record<string, unknown>[]} writes A copy of the items of every
 *   `set`, in the order they were written.
 * @property {(string | string[])[]} removals The keys of every `remove`.
 * @property {(keys: string | string[] | null | undefined) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string | string[]) => Promise<void>} remove
 */

/**
 * A stand-in for `browser.storage.local`, backed by an object the test can
 * read. It answers to every storage shape the extension declares: `CacheStorage`
 * and `ForgetStorage` (`get`, `set`, `remove`, and `get(null)` answering with
 * everything), and `AllowlistStorage`, `BranchStorage` and `MemberStorage`
 * (`get` on one key, and `set`).
 *
 * What is stored is a copy, as `browser.storage.local` stores a structured
 * clone. A fake that held the caller's own object would let the code read back
 * changes it never wrote, and a test of what survives a page load would pass
 * without a write.
 *
 * It records what it was asked, always. A test that reads none of the
 * recordings pays nothing for them.
 *
 * Every method is a plain property, so a test that needs a failure part way
 * through replaces one after seeding:
 *
 *     const storage = fakeStorage();
 *     await cache.putAdvisory(REF, record, { storage, at: 0 });
 *     storage.set = async () => { throw new Error('QuotaExceededError'); };
 *
 * @param {Record<string, unknown>} [held] What earlier sessions left behind.
 * @returns {FakeStorage}
 */
function fakeStorage(held = {}) {
  /** @type {Record<string, unknown>} */
  const entries = structuredClone(held);
  /** @type {(string | string[] | null | undefined)[]} */
  const reads = [];
  /** @type {Record<string, unknown>[]} */
  const writes = [];
  /** @type {(string | string[])[]} */
  const removals = [];
  return {
    entries,
    reads,
    writes,
    removals,
    get: async (keys) => {
      reads.push(keys);
      if (keys === null || keys === undefined) return structuredClone(entries);
      /** @type {Record<string, unknown>} */
      const answer = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (Object.hasOwn(entries, key)) answer[key] = structuredClone(entries[key]);
      }
      return answer;
    },
    set: async (items) => {
      writes.push(structuredClone(items));
      Object.assign(entries, structuredClone(items));
    },
    remove: async (keys) => {
      removals.push(keys);
      for (const key of Array.isArray(keys) ? keys : [keys]) delete entries[key];
    },
  };
}

module.exports = { fakeStorage };
