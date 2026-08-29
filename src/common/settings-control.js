'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

(() => {
  /** The id of the control the extension owns, and the only mark it leaves. */
  const CONTROL_ID = 'bghsa-settings-control';

  /** What the control reads. */
  const LABEL = 'Better GHSA settings';

  /**
   * The settings page, by the path the manifest names it under. The manifest
   * also lists this path in `web_accessible_resources`, because a navigation
   * started from a github.com page to an extension page is blocked unless the
   * page is listed there.
   */
  const SETTINGS_PAGE = 'src/settings/settings.html';

  /**
   * @returns {Record<string, any> | undefined} the extension API under whichever
   *   name this browser gives it, and undefined outside a browser. The test is
   *   for the one member this file calls, so a stand-in carrying that member
   *   answers and a global named `chrome` that is not the extension API does
   *   not.
   */
  function extensionApi() {
    const global = /** @type {Record<string, any>} */ (/** @type {unknown} */ (globalThis));
    for (const name of ['browser', 'chrome']) {
      if (typeof global[name]?.runtime?.getURL === 'function') return global[name];
    }
    return undefined;
  }

  /**
   * The settings page's address in this browser.
   *
   * It is asked for at the moment the control is built and kept in the isolated
   * world, never in an attribute, so nothing on github.com reads it out of the
   * page. On Firefox that is what keeps it out of reach: the address carries a
   * UUID the browser generates once for the installation and then keeps, so a
   * page that never sees it cannot build it. On Chrome the address is built from
   * the extension's id, which is public, so there the manifest's listing of the
   * page is a listing a github.com script can act on.
   *
   * @returns {string | null} the URL, and null outside a browser.
   */
  function settingsUrl() {
    const runtime = extensionApi()?.runtime;
    if (runtime === undefined) return null;
    try {
      const url = runtime.getURL(SETTINGS_PAGE);
      return typeof url === 'string' && url !== '' ? url : null;
    } catch {
      return null;
    }
  }

  /**
   * The extension's own block on this page: the table on the advisory list, the
   * panel on an advisory, and null before either has drawn.
   *
   * Each surface is asked under the id it draws itself with, so a surface that
   * is not loaded is one this does not look for.
   *
   * @param {Document} doc
   * @returns {Element | null}
   */
  function ownBlock(doc) {
    const bghsa = globalThis.bghsa ?? {};
    for (const id of [bghsa.table?.ROOT_ID, bghsa.panel?.PANEL_ID]) {
      if (typeof id !== 'string') continue;
      const node = doc.getElementById(id);
      if (node?.parentElement != null) return node;
    }
    return null;
  }

  /**
   * Where the surface for this page puts itself, asked of the surface so the
   * two cannot drift apart, and null where the surface is not loaded or the
   * page offers it nowhere. Which surface that is follows from the page: the
   * list container is on the advisory list and on no advisory.
   *
   * @param {Document} doc
   * @returns {{ parent: Element, before: Element } | null}
   */
  function surfaceAnchor(doc) {
    const bghsa = globalThis.bghsa ?? {};
    const surface = doc.querySelector('#advisories') !== null ? bghsa.table : bghsa.panel;
    try {
      return surface?.anchor?.(doc) ?? null;
    } catch {
      // A surface that cannot answer for the page is not a reason to leave the
      // control off it.
      return null;
    }
  }

  /**
   * Where the control goes, which is directly above the extension's own block on
   * every advisory page, listed repository or not.
   *
   * Above that block, so the control reads as the extension's and not as one
   * more control of GitHub's page, and above rather than below because each
   * surface reads the element after its own as the sign it is still in place: a
   * control between the block and that element is a move the surface would draw
   * itself again for.
   *
   * The block is not there to sit above before it has drawn, and on a
   * repository the allowlist does not carry it never draws at all, so the
   * second choice is the place the surface for this page takes. A block that
   * arrives afterwards lands at that place and so lands under the control.
   *
   * @param {Document} doc
   * @returns {{ parent: Element, before: Element } | null} null when the page
   *   offers nowhere to put it.
   */
  function anchor(doc) {
    const own = ownBlock(doc);
    if (own?.parentElement != null) return { parent: own.parentElement, before: own };
    const place = surfaceAnchor(doc);
    if (place !== null) return place;
    const container = doc.querySelector('#advisories');
    if (container !== null) {
      // The advisory list with no table surface loaded: above GitHub's filter,
      // under its own heading, which is the place that surface takes.
      const before = container.querySelector('repository-advisories-filter');
      if (before?.parentElement != null) return { parent: before.parentElement, before };
    }
    // An advisory with no panel surface loaded, or one carrying no description
    // for the panel to sit above: above the title. The header GitHub renders the
    // title into sits inside a live region it replaces whole, so the control
    // goes above the region and not inside it.
    const header = doc.querySelector('div.gh-header.js-repository-advisory-details');
    const before = header?.closest('div.js-socket-channel') ?? header;
    if (before?.parentElement != null) return { parent: before.parentElement, before };
    return null;
  }

  /**
   * @param {Document} doc
   * @param {string} url The settings page, held in this closure alone.
   * @returns {Element} the control, drawn in Primer's own classes so it reads as
   *   part of the page it sits on.
   */
  function build(doc, url) {
    const holder = doc.createElement('div');
    holder.id = CONTROL_ID;
    holder.className = 'd-flex flex-justify-end mb-2';
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm';
    button.textContent = LABEL;
    button.addEventListener('click', () => {
      // A new tab, because the advisory the maintainer is reading is not
      // something the extension navigates away from.
      (doc.defaultView ?? globalThis).open(url, '_blank');
    });
    holder.append(button);
    return holder;
  }

  /**
   * Puts the control on an advisory page, which every advisory list and every
   * advisory carries whether or not the allowlist carries the repository.
   * REQUIREMENTS.md section 12. On a repository the allowlist does not carry it
   * is the only thing the extension does there: it reads nothing off the
   * advisory, sends nothing, and stores nothing.
   *
   * Placing is keyed on the control's own id, so a second call leaves one
   * control, and the surface drawing itself again beside it leaves one too.
   * GitHub replacing the content frame takes the control with it, and the next
   * call after that navigation puts one back.
   *
   * @param {Document} [doc]
   * @returns {Element | null} the control, and null where the page offers no
   *   anchor or the browser offers no address for the settings page.
   */
  function show(doc = globalThis.document) {
    const held = doc.getElementById(CONTROL_ID);
    if (held !== null) return held;
    const url = settingsUrl();
    if (url === null) return null;
    const place = anchor(doc);
    if (place === null) return null;
    const control = build(doc, url);
    place.parent.insertBefore(control, place.before);
    return control;
  }

  /**
   * Takes the control off a page that is no longer an advisory page at all,
   * which is the one page an advisory control has no business on.
   *
   * @param {Document} [doc]
   * @returns {boolean} whether a control came off.
   */
  function hide(doc = globalThis.document) {
    const held = doc.getElementById(CONTROL_ID);
    if (held === null) return false;
    held.remove();
    return true;
  }

  const exported = {
    CONTROL_ID,
    SETTINGS_PAGE,
    show,
    hide,
  };

  globalThis.bghsa.settingsControl = exported;

  if (typeof module !== 'undefined') module.exports = exported;
})();
