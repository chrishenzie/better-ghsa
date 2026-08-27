'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

(() => {
  /**
   * The names a browser gives the extension API. Chrome gives `chrome`,
   * Firefox gives both and prefers `browser`, and a page outside an extension
   * gives neither.
   */
  const NAMES = ['browser', 'chrome'];

  /**
   * What a caller needs of `storage.local` before an API answers for it. Every
   * caller reads and writes; the cache also evicts, and asks for `remove`.
   */
  const REQUIRED = ['get', 'set'];

  /**
   * The extension API this browser offers, chosen by what its `storage.local`
   * can do. A name whose `storage.local` is missing a method the caller needs
   * is passed over rather than settled on, so a shim standing in for `browser`
   * does not hide a working `chrome` behind it.
   *
   * @param {readonly string[]} [required] The methods `storage.local` has to
   *   carry.
   * @returns {Record<string, any> | undefined} the API, and undefined where no
   *   name answers, which is every environment outside a browser.
   */
  function api(required = REQUIRED) {
    const global = /** @type {Record<string, any>} */ (/** @type {unknown} */ (globalThis));
    for (const name of NAMES) {
      const found = global[name];
      const local = found?.storage?.local;
      if (local === undefined || local === null) continue;
      if (required.every((method) => typeof local[method] === 'function')) return found;
    }
    return undefined;
  }

  /**
   * `storage.local`, from the API {@link api} chooses. The caller casts it to
   * the part of the WebExtension storage contract that file uses.
   *
   * @param {readonly string[]} [required] The methods it has to carry.
   * @returns {Record<string, any> | null} the store, and null where there is
   *   none, which is every environment outside a browser.
   */
  function local(required = REQUIRED) {
    return api(required)?.storage?.local ?? null;
  }

  const exported = {
    api,
    local,
  };

  globalThis.bghsa.storage = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
