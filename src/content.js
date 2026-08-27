'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

/**
 * @typedef {object} AdvisoryLocation
 * @property {string} owner
 * @property {string} repo
 * @property {string | null} ghsaId The advisory, or null on the list page.
 */

(() => {
  /**
   * The advisory a github.com path points at.
   *
   * @param {string} pathname
   * @returns {AdvisoryLocation | null} null when the path is not an advisory page
   */
  function locate(pathname) {
    const parts = pathname.split('/').filter((part) => part !== '');
    const [owner, repo, security, advisories, ghsaId] = parts;
    if (owner === undefined || repo === undefined) return null;
    if (security !== 'security' || advisories !== 'advisories') return null;
    return { owner, repo, ghsaId: ghsaId ?? null };
  }

  /** Log the advisory this page is, and whether writes to it are permitted. */
  function report() {
    const here = locate(globalThis.location.pathname);
    if (here === null) return;
    const nameWithOwner = `${here.owner}/${here.repo}`;
    const subject = here.ghsaId === null ? 'advisory list' : here.ghsaId;
    const writes = globalThis.bghsa.allowlist.isAllowed(nameWithOwner)
      ? 'writes permitted'
      : 'writes refused';
    console.info(`[better-ghsa] ${nameWithOwner} ${subject}, ${writes}`);
  }

  /**
   * What GitHub gives when it has replaced the content frame without a document
   * load. The framework's own events are fired inside the frame and reach the
   * document; `popstate` and `pageshow` are fired at the window and cover a
   * history move and a return from the back-forward cache.
   *
   * Several names are watched because the fact that matters is the frame having
   * arrived and each of these announces it. Missing every name on a navigation
   * costs a page whose surface never starts; hearing several costs one more call
   * to {@link apply}, which returns without touching a document it has already
   * started.
   *
   * @type {readonly string[]}
   */
  const FRAME_EVENTS = [
    'turbo:load',
    'turbo:render',
    'turbo:frame-load',
    'turbo:frame-render',
    'soft-nav:end',
    'soft-nav:success',
    'pjax:end',
  ];

  /** @type {readonly string[]} */
  const WINDOW_EVENTS = ['popstate', 'pageshow'];

  /**
   * The documents whose surfaces have been started. A document is started once:
   * a surface holds its own observer from then on, and a second start would
   * connect a second one.
   *
   * @type {WeakSet<Document>}
   */
  const started = new WeakSet();

  /**
   * @returns {{ start: () => unknown }[]} the surfaces this extension puts on an
   *   advisory page, in the order they take it.
   */
  function surfaces() {
    const bghsa = globalThis.bghsa;
    return [bghsa.table, bghsa.panel].filter((surface) => typeof surface?.start === 'function');
  }

  /**
   * Starts the surfaces on a document the URL says is an advisory page, and
   * leaves every other page untouched: no surface drawn, no observer connected,
   * no storage read and no request sent. The content script matches every
   * github.com page, so this is what keeps the extension off the pages it has
   * nothing to say about.
   *
   * Both surfaces start together, because the advisory list and an advisory are
   * the two halves of one area and each surface's own pass decides which half it
   * is looking at. A move between the halves is then carried by observers that
   * are already connected, so it costs nothing when no navigation event arrives.
   *
   * @param {Document} [doc] The document to start on.
   * @returns {boolean} whether this call started the surfaces.
   */
  function apply(doc = globalThis.document) {
    if (locate(globalThis.location.pathname) === null) return false;
    if (started.has(doc)) return false;
    started.add(doc);
    report();
    for (const surface of surfaces()) {
      try {
        surface.start();
      } catch {
        // A surface that cannot take the page is not a reason to keep the next
        // one off it.
      }
    }
    return true;
  }

  /**
   * Listens for the frame becoming a page a surface belongs to. A document that
   * loaded as something else has no surface running and so nothing watching it,
   * which is why this listens rather than leaving the surfaces to notice.
   *
   * @param {Document} [doc] The document to listen on.
   * @returns {void}
   */
  function watch(doc = globalThis.document) {
    const view = doc?.defaultView ?? globalThis;
    const onNavigated = () => {
      apply(doc);
    };
    for (const name of FRAME_EVENTS) doc?.addEventListener?.(name, onNavigated);
    for (const name of WINDOW_EVENTS) view?.addEventListener?.(name, onNavigated);
  }

  /**
   * @returns {void} takes the page the extension loaded onto, and every page
   *   GitHub turns it into afterwards.
   */
  function start() {
    watch();
    apply();
  }

  globalThis.bghsa.content = { locate, report, FRAME_EVENTS, WINDOW_EVENTS, apply, watch, start };

  if (typeof module !== 'undefined') {
    module.exports = { locate, report, FRAME_EVENTS, WINDOW_EVENTS, apply, watch, start };
  } else {
    start();
  }
})();
