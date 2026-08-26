'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/dom.js');
  require('../common/trust.js');
  require('../common/parse-detail.js');
  require('../common/derive.js');
  require('./preserve.js');
}

/** The id of the sentinel element the extension owns. */
const PANEL_ID = 'bghsa-detail-panel';

/** The id of the extension's global stylesheet. */
const STYLE_ID = 'bghsa-style';

/** Every rule the extension adds to the page. */
const STYLE_TEXT = [
  '.bghsa-chips { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }',
  '.bghsa-label { flex: 0 0 9rem; }',
  '.bghsa-missing { font-style: italic; }',
  '.bghsa-tone-attention { color: var(--fgColor-default);' +
    ' background-color: var(--bgColor-attention);' +
    ' border-color: var(--bgColor-attention); }',
  '.bghsa-tone-danger { color: var(--fgColor-default);' +
    ' background-color: var(--bgColor-danger);' +
    ' border-color: var(--bgColor-danger); }',
].join('\n');

/** The text shown in place of a value that could not be read. */
const MISSING = 'missing';

/** How every surface builds an element. */
const element = globalThis.bghsa.dom.element;

/**
 * @param {string | null} value
 * @returns {string} `value`, or the missing marker.
 */
function shown(value) {
  return value === null || value === '' ? MISSING : value;
}

/**
 * The names of the values the extension could not read from the page. An empty
 * list means every value it set out to read is in hand.
 *
 * @param {import('../common/parse-detail.js').ParsedDetail} advisory
 * @param {import('../common/derive.js').DerivedState} derived
 * @returns {string[]}
 */
function missingValues(advisory, derived) {
  /** @type {string[]} */
  const missing = [];
  if (advisory.ghsaId === null) missing.push('advisory id');
  if (advisory.state === null) missing.push('state');
  if (advisory.severity === null) missing.push('severity');
  if (advisory.reporter === null) missing.push('reporter');
  if (advisory.reportedAt === null) missing.push('report time');
  if (advisory.descriptionOriginal === null) missing.push('description provenance');
  if (derived.patch.incomplete) missing.push('pull request state');
  return missing;
}

/**
 * A chip. A tone names a Primer state token, and a chip with no tone is
 * neutral.
 *
 * @param {Document} doc
 * @param {string} text
 * @param {'attention' | 'danger'} [tone]
 * @returns {Element}
 */
function chip(doc, text, tone) {
  const classes = ['Label', 'Label--secondary'];
  if (tone !== undefined) classes.push(`bghsa-tone-${tone}`);
  return element(doc, 'span', classes.join(' '), text);
}

/**
 * A chip carrying one named value. A value that could not be read is marked
 * and toned, so it does not read as a value the page holds.
 *
 * @param {Document} doc
 * @param {string} label
 * @param {string | null} value
 * @returns {Element}
 */
function valueChip(doc, label, value) {
  const unread = value === null || value === '';
  const node = chip(doc, `${label}: ${shown(value)}`, unread ? 'attention' : undefined);
  if (unread) node.classList.add('bghsa-missing');
  return node;
}

/**
 * @param {Document} doc
 * @param {string} label
 * @returns {{ row: Element, body: Element }} a Box row and the element its
 *   value goes in.
 */
function row(doc, label) {
  const container = element(doc, 'div', 'Box-row d-flex flex-items-baseline');
  container.append(element(doc, 'div', 'text-bold bghsa-label', label));
  const body = element(doc, 'div', 'flex-auto');
  container.append(body);
  return { row: container, body };
}

/**
 * @param {Document} doc
 * @param {string} text
 * @returns {Element}
 */
function warning(doc, text) {
  return element(doc, 'div', 'flash flash-warn mt-2 bghsa-warning', text);
}

/**
 * The chip row, which is visible whatever else the panel shows. A derived
 * signal is a chip only while it is firing, because it is there to say that
 * something needs attention.
 *
 * @param {Document} doc
 * @param {import('../common/parse-detail.js').ParsedDetail} advisory
 * @param {import('../common/derive.js').DerivedState} derived
 * @returns {Element}
 */
function buildChips(doc, advisory, derived) {
  const header = element(doc, 'div', 'Box-header bghsa-chips');
  header.append(element(doc, 'strong', 'mr-2', 'Better GHSA'));
  header.append(valueChip(doc, 'State', advisory.state));
  header.append(valueChip(doc, 'Severity', advisory.severityLabel));
  const cve = derived.cve;
  header.append(chip(doc, `CVE: ${cve.id === null ? cve.state : cve.id}`));
  if (derived.neverReviewed) header.append(chip(doc, 'Never reviewed', 'danger'));
  if (derived.newActivity) header.append(chip(doc, 'New activity', 'attention'));
  return header;
}

/**
 * The reasons a press left the advisory as it was, and so can be pressed again
 * safely. Every other outcome may have created the comment, and pressing again
 * would create a second one.
 *
 * @type {readonly string[]}
 */
const RETRYABLE = ['allowlist', 'provenance', 'unreadable', 'unverifiable', 'no-form'];

/**
 * Runs the write the button asks for and reports what happened. The button
 * stays disabled once a press has reached GitHub, because a press whose result
 * the extension could not confirm may still have created the comment.
 *
 * @param {Document} doc
 * @param {import('../common/parse-detail.js').ParsedDetail} advisory
 * @param {Element} button
 * @param {import('./preserve.js').PreserveOptions} [options]
 * @returns {Promise<import('../common/write.js').WriteResult>}
 */
async function press(doc, advisory, button, options) {
  const note = button.parentElement?.querySelector('.bghsa-preserve-note') ?? null;
  button.setAttribute('disabled', '');
  button.setAttribute('aria-disabled', 'true');
  if (note !== null) note.textContent = 'Writing the comment.';

  const outcome = await globalThis.bghsa.preserve.preserve(advisory, { doc, ...options });

  if (outcome.ok) {
    button.remove();
    if (note !== null) note.textContent = 'The original report is preserved.';
    return outcome;
  }
  if (note !== null) note.textContent = '';
  const retryable = outcome.reason !== null && RETRYABLE.includes(outcome.reason);
  const banner = warning(
    doc,
    retryable
      ? outcome.message
      : `${outcome.message} Reload the page to see whether the comment was created.`
  );
  banner.classList.add('bghsa-preserve-result');
  button.parentElement?.append(banner);
  if (retryable) {
    button.removeAttribute('disabled');
    button.removeAttribute('aria-disabled');
  }
  return outcome;
}

/**
 * The row the preservation button lives in. An advisory that already carries
 * the comment gets no button, because the extension writes one per advisory.
 *
 * @param {Document} doc
 * @param {import('../common/parse-detail.js').ParsedDetail} advisory
 * @returns {Element}
 */
function buildPreserve(doc, advisory) {
  const state = globalThis.bghsa.preserve.offered(advisory);
  const built = row(doc, 'Original report');
  if (!state.available) {
    built.body.textContent = state.message;
    return built.row;
  }
  const button = element(doc, 'button', 'btn btn-sm bghsa-preserve', 'Preserve original report');
  button.setAttribute('type', 'button');
  built.body.append(button);
  built.body.append(element(doc, 'span', 'ml-2 bghsa-preserve-note', state.message));
  button.addEventListener('click', () => {
    void press(doc, advisory, button);
  });
  return built.row;
}

/**
 * The panel, built from a parsed advisory and its derived state. It reads
 * nothing from the document beyond the document itself, which creates the
 * nodes and, once the preservation button is pressed, carries the comment form
 * the write clones.
 *
 * @param {Document} doc
 * @param {import('../common/parse-detail.js').ParsedDetail} advisory
 * @param {import('../common/derive.js').DerivedState} derived
 * @returns {Element}
 */
function buildPanel(doc, advisory, derived) {
  const panel = element(doc, 'div', 'Box mb-3 bghsa-panel');
  panel.id = PANEL_ID;
  panel.setAttribute('data-bghsa-panel', '1');
  panel.append(buildChips(doc, advisory, derived));

  const missing = missingValues(advisory, derived);
  if (missing.length > 0) {
    const banner = warning(
      doc,
      `Incomplete: this extension could not read ${missing.join(', ')}.`
    );
    banner.classList.add('bghsa-banner');
    banner.classList.remove('mt-2');
    panel.append(banner);
  }

  if (derived.patch.incomplete) {
    panel.append(warning(doc, 'A pull request named a state this extension does not read.'));
  }

  const descriptionRow = row(doc, 'Description');
  if (advisory.descriptionOriginal === null) {
    descriptionRow.body.append(doc.createTextNode('Provenance '));
    descriptionRow.body.append(element(doc, 'span', 'bghsa-missing', MISSING));
    descriptionRow.body.append(doc.createTextNode('.'));
  } else {
    descriptionRow.body.textContent = advisory.descriptionOriginal
      ? "The reporter's original text."
      : 'Edited since it was reported.';
  }
  panel.append(descriptionRow.row);
  panel.append(buildPreserve(doc, advisory));

  return panel;
}

/**
 * Where the panel goes: in the main column, above the description Box, and
 * outside both live regions, because GitHub replaces each region's subtree on
 * its own.
 *
 * @param {Document} doc
 * @returns {{ parent: Element, before: Element } | null}
 */
function anchor(doc) {
  const header = doc.querySelector(
    'div.js-repository-advisory-details > div.Box-header.timeline-comment-header'
  );
  const box = header === null ? null : header.closest('div.Box');
  const region = box === null ? null : box.closest('div.js-socket-channel');
  const before = region ?? box;
  if (before === null || before.parentElement === null) return null;
  return { parent: before.parentElement, before };
}

/**
 * @param {Document} doc
 * @returns {void} adds the extension's stylesheet once.
 */
function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID) !== null) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
  (doc.head ?? doc.documentElement ?? doc.body)?.append(style);
}

/**
 * Places the panel. Placement is keyed on the sentinel element, so injecting
 * twice leaves one panel and re-injecting after GitHub replaced the subtree
 * puts one back.
 *
 * @param {Document} doc
 * @param {import('../common/parse-detail.js').ParsedDetail} advisory
 * @param {import('../common/derive.js').DerivedState} derived
 * @returns {Element | null} the panel, or null when the page offers no anchor.
 */
function injectPanel(doc, advisory, derived) {
  const panel = buildPanel(doc, advisory, derived);
  const existing = doc.getElementById(PANEL_ID);
  const place = anchor(doc);
  if (place !== null) {
    if (existing !== null) existing.remove();
    place.parent.insertBefore(panel, place.before);
  } else if (existing !== null) {
    existing.replaceWith(panel);
  } else {
    return null;
  }
  ensureStyle(doc);
  return panel;
}

/**
 * Whether the document needs the panel placed: it carries no sentinel, or it
 * carries one that no longer sits at the anchor because GitHub replaced the
 * subtree under it.
 *
 * @param {Document} doc
 * @returns {boolean}
 */
function outOfPlace(doc) {
  const panel = doc.getElementById(PANEL_ID);
  if (panel === null) return true;
  const place = anchor(doc);
  return place !== null && panel.nextElementSibling !== place.before;
}

/**
 * Reads the document and places the panel. Returns null when the document is
 * not an advisory detail page, or when it offers no anchor.
 *
 * @param {Document} doc
 * @returns {Element | null}
 */
function render(doc) {
  const advisory = globalThis.bghsa.parseDetail.parseDetail(doc);
  if (advisory === null) return null;
  return injectPanel(doc, advisory, globalThis.bghsa.derive.derive(advisory));
}

/**
 * Watches for GitHub replacing the subtree the panel sits in and places the
 * panel again when the sentinel is gone or has been left behind.
 *
 * The target is the document element. `#repo-content-turbo-frame` is the
 * subtree GitHub swaps when a link is followed with no document load, and the
 * document element contains it, so a swap of the frame's contents and a swap
 * of the frame element itself are both seen. A content script runs once per
 * document, so this observer is also what puts the panel on an advisory
 * reached from the advisory list without a reload.
 *
 * Each batch of mutations schedules at most one pass, and a pass that finds
 * the panel in place reads two elements and stops.
 *
 * @param {Document} doc
 * @returns {MutationObserver | null}
 */
function observe(doc) {
  const target = doc.documentElement ?? doc.body;
  if (target === null) return null;
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      if (outOfPlace(doc)) render(doc);
    }, 0);
  });
  observer.observe(target, { childList: true, subtree: true });
  return observer;
}

/**
 * @returns {void} renders the panel into this page and keeps it there.
 */
function start() {
  render(globalThis.document);
  observe(globalThis.document);
}

globalThis.bghsa.panel = {
  PANEL_ID,
  STYLE_ID,
  MISSING,
  missingValues,
  buildPreserve,
  press,
  buildPanel,
  anchor,
  outOfPlace,
  injectPanel,
  render,
  observe,
  start,
};

if (typeof module !== 'undefined') {
  module.exports = globalThis.bghsa.panel;
} else {
  start();
}
