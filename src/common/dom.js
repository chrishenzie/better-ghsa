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

  const exported = {
    element,
  };

  globalThis.bghsa.dom = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
