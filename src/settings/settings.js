'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The page's own script tags order these; under Node the dependencies are named
// here.
if (typeof require === 'function') {
  require('../common/allowlist.js');
  require('../common/forget.js');
}

/**
 * The elements this page reads and writes.
 *
 * @typedef {object} SettingsElements
 * @property {HTMLFormElement | null} form
 * @property {HTMLInputElement | null} input
 * @property {Element | null} error
 * @property {Element | null} empty
 * @property {Element | null} list
 * @property {Element | null} clear
 * @property {Element | null} status
 */

(() => {
  /** What a typed entry that is not a repository is answered with. */
  const MALFORMED_MESSAGE = 'Enter a repository as owner/repo.';

  /** What a repository already on the list is answered with. */
  const DUPLICATE_MESSAGE = 'That repository is already listed.';

  /**
   * What a press of the clear is answered with. The clear changes nothing the
   * page draws, so without a word for it a maintainer cannot tell a press that
   * emptied the cache from one the page never heard.
   */
  const CLEARED_MESSAGE = 'Cache cleared';

  /**
   * @param {Document} doc
   * @returns {SettingsElements}
   */
  function elementsOf(doc) {
    return {
      form: /** @type {HTMLFormElement | null} */ (doc.getElementById('add-form')),
      input: /** @type {HTMLInputElement | null} */ (doc.getElementById('add-input')),
      error: doc.getElementById('add-error'),
      empty: doc.getElementById('empty'),
      list: doc.getElementById('list'),
      clear: doc.getElementById('clear-button'),
      status: doc.getElementById('clear-status'),
    };
  }

  /**
   * @param {Document} doc
   * @param {string | null} message The reason nothing was added, and null where
   *   there is none to show.
   * @returns {void}
   */
  function showError(doc, message) {
    const error = elementsOf(doc).error;
    if (error === null) return;
    error.textContent = message ?? '';
    if (message === null) error.setAttribute('hidden', '');
    else error.removeAttribute('hidden');
  }

  /**
   * @param {Document} doc
   * @param {boolean} cleared Whether to say the cache has been emptied. It
   *   comes down again the next time the maintainer works the list, so what the
   *   page says answers the last thing that was pressed.
   * @returns {void}
   */
  function showCleared(doc, cleared) {
    const status = elementsOf(doc).status;
    if (status === null) return;
    status.textContent = cleared ? CLEARED_MESSAGE : '';
    if (cleared) status.removeAttribute('hidden');
    else status.setAttribute('hidden', '');
  }

  /**
   * One row: the repository, and the control that takes it off the list.
   *
   * @param {Document} doc
   * @param {string} entry
   * @returns {Element}
   */
  function buildRow(doc, entry) {
    const row = doc.createElement('li');
    row.className = 'row';
    const name = doc.createElement('span');
    name.className = 'row-name';
    name.textContent = entry;
    row.append(name);
    const button = doc.createElement('button');
    button.className = 'button button-danger';
    button.type = 'button';
    button.dataset.entry = entry;
    // The name is in the row beside it, and a reader moving between rows by
    // control alone gets it from the label rather than the row.
    button.setAttribute('aria-label', `Remove ${entry}`);
    button.textContent = 'Remove';
    row.append(button);
    return row;
  }

  /**
   * Draws the list. The rows are rebuilt from the stored entries every time, so
   * what the page shows is what storage holds and never a row the page kept.
   *
   * @param {Document} doc
   * @param {readonly string[]} entries
   * @returns {void}
   */
  function render(doc, entries) {
    const { list, empty } = elementsOf(doc);
    if (list !== null) {
      list.replaceChildren(...entries.map((entry) => buildRow(doc, entry)));
    }
    if (empty !== null) {
      if (entries.length === 0) empty.removeAttribute('hidden');
      else empty.setAttribute('hidden', '');
    }
  }

  /**
   * Adds what is typed in the field. A malformed entry and one already listed
   * are refused with a reason and leave the field alone, so the maintainer can
   * correct what they typed.
   *
   * @param {Document} doc
   * @returns {Promise<boolean>} whether the list changed.
   */
  async function submit(doc) {
    showCleared(doc, false);
    const { input } = elementsOf(doc);
    const typed = input?.value ?? '';
    const outcome = await globalThis.bghsa.allowlist.add(typed);
    if (!outcome.ok) {
      if (outcome.reason === 'empty') showError(doc, null);
      else showError(doc, outcome.reason === 'duplicate' ? DUPLICATE_MESSAGE : MALFORMED_MESSAGE);
      return false;
    }
    showError(doc, null);
    if (input !== null) input.value = '';
    render(doc, globalThis.bghsa.allowlist.current());
    return true;
  }

  /**
   * @param {Document} doc
   * @param {string} entry
   * @returns {Promise<void>}
   */
  async function drop(doc, entry) {
    showError(doc, null);
    showCleared(doc, false);
    const entries = await globalThis.bghsa.allowlist.remove(entry);
    render(doc, entries);
    await globalThis.bghsa.forget.repository(entry, entries);
  }

  /**
   * Empties what the extension has read. The repository list is left alone, so
   * the extension goes on running where it was listed and fills the cache again
   * as those pages are read. REQUIREMENTS.md section 2.
   *
   * Nothing is asked first. Everything this takes is rederivable from the
   * advisories, so the cost of a press nobody meant is the reads that fill it
   * back in.
   *
   * @param {Document} doc
   * @returns {Promise<void>}
   */
  async function clear(doc) {
    showError(doc, null);
    await globalThis.bghsa.forget.everything();
    showCleared(doc, true);
  }

  /**
   * Puts the page in charge of the list: it draws what storage holds, adds and
   * removes on the controls, and redraws when the list changes underneath it,
   * which is what a second settings tab or a reset does.
   *
   * @param {Document} [doc]
   * @returns {Promise<void>}
   */
  async function start(doc = globalThis.document) {
    const { form, list, clear: control } = elementsOf(doc);
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      void submit(doc);
    });
    list?.addEventListener('click', (event) => {
      const target = /** @type {Element | null} */ (event.target);
      const button = target?.closest?.('button[data-entry]');
      const entry = button?.getAttribute('data-entry');
      if (entry === null || entry === undefined) return;
      void drop(doc, entry);
    });
    control?.addEventListener('click', () => {
      void clear(doc);
    });
    const allowlist = globalThis.bghsa.allowlist;
    allowlist.watch();
    allowlist.subscribe((entries) => {
      render(doc, entries);
    });
    render(doc, await allowlist.load());
  }

  const exported = {
    MALFORMED_MESSAGE,
    DUPLICATE_MESSAGE,
    CLEARED_MESSAGE,
    render,
    submit,
    drop,
    clear,
    start,
  };

  if (typeof module !== 'undefined') {
    module.exports = exported;
  } else {
    void start();
  }
})();
