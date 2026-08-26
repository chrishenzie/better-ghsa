'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

(() => {
  /**
   * One element, as every surface builds one: a tag, the classes GitHub or this
   * extension styles it with, and the text it carries. A class of `''` leaves
   * the attribute off, and text left out leaves the element empty, so a
   * container and a leaf are built the same way.
   *
   * @param {Document} doc
   * @param {string} tag
   * @param {string} className
   * @param {string} [text]
   * @returns {Element}
   */
  function element(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className !== '') node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * How long a burst of mutations is gathered before a pass runs. A subtree
   * replacement arrives as one batch, and this covers a page that makes several
   * in a row.
   */
  const RENDER_DELAY_MS = 50;

  /**
   * @param {Node} node
   * @param {string} selector
   * @returns {boolean} whether `node` is one the extension put in the document,
   *   or sits inside one.
   */
  function ownedNode(node, selector) {
    const start = node.nodeType === 1 ? /** @type {Element} */ (node) : node.parentElement;
    return start !== null && start.closest(selector) !== null;
  }

  /**
   * Whether one mutation is the extension's own writing. A pass takes a surface
   * out and puts it back, adds its stylesheet, and writes inside it; reading
   * those as page changes would run a pass for every pass.
   *
   * A record whose target is one of the extension's nodes covers what a pass
   * changes inside the surface. A record naming only the extension's nodes
   * covers the surface, the stylesheet, and anything else it owns going into and
   * out of the nodes the page owns.
   *
   * @param {MutationRecord} record
   * @param {string} selector
   * @returns {boolean}
   */
  function ownWrite(record, selector) {
    if (ownedNode(record.target, selector)) return true;
    const touched = [...record.addedNodes, ...record.removedNodes];
    return touched.length > 0 && touched.every((node) => ownedNode(node, selector));
  }

  /**
   * What one surface tells a watcher about itself.
   *
   * @typedef {object} Watched
   * @property {() => string} ownedSelector What the nodes this surface put in
   *   the document match.
   * @property {(doc: Document) => boolean} outOfPlace Whether the surface is
   *   gone or has been left behind.
   * @property {() => Promise<void>} pass The loop its renders run through, which
   *   is what keeps a pass this asks for from overlapping one started elsewhere.
   */

  /**
   * Watches the document and runs a pass when something the extension did not
   * write changed, or the surface is gone or has been left behind.
   *
   * The target is the document element. `#repo-content-turbo-frame` is the
   * subtree GitHub swaps when a link is followed with no document load, and the
   * document element contains it, so a swap of the frame's contents and a swap
   * of the frame element itself are both seen. Live regions sit under it too. A
   * content script runs once per document, so this is also what puts a surface
   * on a page reached from another without a reload.
   *
   * Each burst schedules at most one pass, and a burst carrying nothing but the
   * extension's own writing schedules none.
   *
   * @param {Document} doc
   * @param {Watched} surface
   * @returns {MutationObserver | null} null where the document offers nothing to
   *   watch or no observer to watch it with.
   */
  function watch(doc, surface) {
    const target = doc.documentElement ?? doc.body;
    if (target === null) return null;
    // The content script's own constructor, with the document's view standing in
    // for it where there is no global one.
    const Observer = globalThis.MutationObserver ?? doc.defaultView?.MutationObserver;
    if (Observer === undefined || Observer === null) return null;
    let scheduled = false;
    const observer = new Observer((records) => {
      if (scheduled) return;
      const selector = surface.ownedSelector();
      const changed =
        records.some((record) => !ownWrite(record, selector)) || surface.outOfPlace(doc);
      if (!changed) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        void surface.pass();
      }, RENDER_DELAY_MS);
    });
    observer.observe(target, { childList: true, subtree: true });
    return observer;
  }

  const exported = {
    element,
    RENDER_DELAY_MS,
    watch,
  };

  globalThis.bghsa.dom = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
