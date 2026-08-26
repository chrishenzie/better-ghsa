'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

(() => {
  /**
   * @param {string | null | undefined} value
   * @returns {string} `value` with runs of whitespace collapsed to one space and
   *   the ends trimmed.
   */
  function collapse(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  /**
   * @param {string} value
   * @returns {string | null} `value`, or null when it is empty after trimming.
   */
  function orNull(value) {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }

  const exported = {
    collapse,
    orNull,
  };

  globalThis.bghsa.text = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
