'use strict';

/**
 * Opens the settings page the first time the extension is installed.
 *
 * The list of repositories the extension acts on is empty on a fresh install,
 * so until a maintainer names one the extension does nothing anywhere. An
 * extension that is silent on every page has to say why, and the settings page
 * is where it says it. REQUIREMENTS.md section 12.
 *
 * An update is not an install and opens nothing: the list is already set, and a
 * tab opening on every update is noise.
 */
(() => {
  const global = /** @type {Record<string, any>} */ (/** @type {unknown} */ (globalThis));
  const api = global['browser']?.runtime !== undefined ? global['browser'] : global['chrome'];
  const runtime = api?.runtime;
  if (runtime?.onInstalled?.addListener === undefined) return;

  runtime.onInstalled.addListener(
    /**
     * @param {{ reason?: string }} [details]
     * @returns {void}
     */
    (details) => {
      if (details?.reason !== 'install') return;
      try {
        // Firefox answers with a promise and Chrome takes a callback; neither
        // return value is read, and a rejection is not a reason to throw out of
        // a listener.
        void Promise.resolve(runtime.openOptionsPage?.()).catch(() => {});
      } catch {
        // A browser that will not open the page leaves the extension installed
        // and configurable from its own settings entry.
      }
    }
  );
})();
