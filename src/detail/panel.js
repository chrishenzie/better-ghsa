'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/dom.js');
  require('../common/text.js');
  require('../common/trust.js');
  require('../common/merge.js');
  require('../common/parse-detail.js');
  require('../common/derive.js');
  require('./tracking.js');
  require('./comments.js');
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
  '.bghsa-confirmed { display: flex; flex-direction: column; gap: 6px; }',
  '.bghsa-confirmation-name { flex: 0 0 13rem; }',
  '.bghsa-confirmation-note { color: var(--fgColor-muted); }',
  '.bghsa-since { color: var(--fgColor-muted); }',
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
  // The confirmations bind to these two, so a track cannot be judged without
  // them.
  if (advisory.title === null) missing.push('advisory title');
  if (advisory.description === null) missing.push('advisory description');
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
 * The CVE is on the list page. The advisory page carries it already, so the
 * panel does not repeat it.
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
  if (derived.neverReviewed) header.append(chip(doc, 'Never reviewed', 'danger'));
  if (derived.newActivity) header.append(chip(doc, 'New activity', 'attention'));
  return header;
}

/**
 * The confirmation tracks, in the order the panel shows them. `warn` names the
 * track REQUIREMENTS.md section 8 warns on while it stands unconfirmed.
 *
 * @type {readonly { key: 'title' | 'description' | 'scoring', name: string,
 *   short: string, warn: boolean }[]}
 */
const CONFIRMATION_TRACKS = [
  { key: 'title', name: 'Advisory title', short: 'advisory title', warn: false },
  {
    key: 'description',
    name: 'Advisory description',
    short: 'advisory description',
    warn: false,
  },
  {
    key: 'scoring',
    name: 'Severity and CVSS vector',
    short: 'severity and CVSS vector',
    warn: true,
  },
];

/**
 * What the confirmation chip reads. A drifted track reverted to unconfirmed,
 * and reads as unconfirmed; who confirmed a different value is the note beside
 * it.
 *
 * @param {import('./tracking.js').Confirmation} state
 * @returns {string}
 */
function confirmationText(state) {
  if (state.status === 'confirmed') return 'Confirmed';
  if (state.status === 'unreadable') return 'Not checked';
  return 'Not confirmed';
}

/**
 * @param {import('./tracking.js').Confirmation} state
 * @param {boolean} warn Whether an unconfirmed track on this row is a warning.
 * @returns {'attention' | 'danger' | undefined}
 */
function confirmationTone(state, warn) {
  if (state.status === 'drifted') return 'danger';
  if (state.status === 'unreadable') return 'attention';
  if (state.status === 'unconfirmed' && warn) return 'attention';
  return undefined;
}

/**
 * Who acted and when, as a sentence. A record naming no login reads as a
 * maintainer, because the confirmation stands whether or not the login
 * survived.
 *
 * @param {import('./tracking.js').Confirmation} state
 * @param {string} action
 * @returns {string}
 */
function attribution(state, action) {
  const who = state.by === null ? 'A maintainer' : state.by;
  const at = globalThis.bghsa.text.formatTime(state.at);
  return at === null ? `${who} ${action}.` : `${who} ${action} on ${at}.`;
}

/**
 * @param {import('./tracking.js').Confirmation} state
 * @returns {string | null} what the panel says beside the chip.
 */
function confirmationNote(state) {
  if (state.status === 'confirmed') return attribution(state, 'confirmed this value');
  if (state.status === 'drifted') return attribution(state, 'confirmed a different value');
  if (state.status === 'unreadable') {
    return `${attribution(state, 'confirmed a value')} The value on the page could not be read.`;
  }
  return null;
}

/**
 * The confirmations, which are what the panel is for: whether the advisory
 * text was rewritten for publication and whether the score was approved.
 *
 * @param {Document} doc
 * @param {import('./tracking.js').TrackingView} tracking
 * @returns {Element}
 */
function buildConfirmations(doc, tracking) {
  const container = element(doc, 'div', 'Box-row bghsa-confirmed');
  container.append(element(doc, 'div', 'text-bold', 'Confirmed by a maintainer'));
  for (const track of CONFIRMATION_TRACKS) {
    const state = tracking[track.key];
    const line = element(doc, 'div', 'bghsa-chips bghsa-confirmation');
    line.append(element(doc, 'span', 'bghsa-confirmation-name', track.name));
    line.append(chip(doc, confirmationText(state), confirmationTone(state, track.warn)));
    const note = confirmationNote(state);
    if (note !== null) line.append(element(doc, 'span', 'bghsa-confirmation-note', note));
    container.append(line);
  }
  return container;
}

/**
 * The warnings REQUIREMENTS.md section 8 requires: an unconfirmed score, and a
 * value that moved away from what was confirmed. Each drifted track is named
 * on its own line, so the reader is told which value moved.
 *
 * A drifted score raises the drift warning alone. That warning says the
 * confirmation no longer holds, which is what the unconfirmed warning would
 * say a second time.
 *
 * @param {Document} doc
 * @param {import('./tracking.js').TrackingView} tracking
 * @returns {Element[]}
 */
function confirmationWarnings(doc, tracking) {
  /** @type {Element[]} */
  const warnings = [];
  for (const track of CONFIRMATION_TRACKS) {
    if (tracking[track.key].status !== 'drifted') continue;
    warnings.push(warning(doc, `The ${track.short} changed after a maintainer confirmed it.`));
  }
  if (tracking.scoring.status === 'unconfirmed' || tracking.scoring.status === 'unreadable') {
    warnings.push(warning(doc, 'No maintainer has confirmed the severity and CVSS vector.'));
  }
  return warnings;
}

/**
 * A row carrying one chip per value.
 *
 * @param {Document} doc
 * @param {string} label
 * @param {string[]} values
 * @returns {Element}
 */
function chipRow(doc, label, values) {
  const built = row(doc, label);
  built.body.className = 'flex-auto bghsa-chips';
  for (const value of values) built.body.append(chip(doc, value));
  return built.row;
}

/**
 * The stored tracks. A track appears only where the snapshot says something
 * about it, so an advisory nobody has set a value on carries no rows here.
 *
 * @param {Document} doc
 * @param {import('./tracking.js').TrackingView} tracking
 * @returns {Element[]}
 */
function buildTracks(doc, tracking) {
  /** @type {Element[]} */
  const rows = [];

  if (tracking.triage !== null) {
    const built = row(doc, 'Triage');
    built.body.className = 'flex-auto bghsa-chips';
    built.body.append(chip(doc, tracking.triage));
    const since = globalThis.bghsa.text.formatTime(tracking.triageSince);
    if (since !== null) built.body.append(element(doc, 'span', 'bghsa-since', `since ${since}`));
    rows.push(built.row);
  }
  if (tracking.owners.length > 0) rows.push(chipRow(doc, 'Owners', tracking.owners));
  if (tracking.backports.length > 0) {
    rows.push(chipRow(doc, 'Backport targets', tracking.backports));
  }
  if (tracking.embargo) {
    const built = row(doc, 'Embargo');
    built.body.textContent =
      tracking.embargoLift === null
        ? 'In force, with no lift date recorded.'
        : `Lifts ${tracking.embargoLift}.`;
    rows.push(built.row);
  }
  if (tracking.closureReason !== null) {
    const built = row(doc, 'Closed as');
    built.body.className = 'flex-auto bghsa-chips';
    built.body.append(chip(doc, tracking.closureReason));
    if (tracking.closureDuplicateOf !== null) {
      built.body.append(
        element(doc, 'span', 'bghsa-since', `of ${tracking.closureDuplicateOf}`)
      );
    }
    rows.push(built.row);
  }
  return rows;
}

/**
 * The reasons a press left the advisory as it was, and so can be pressed again
 * safely. Every other outcome may have created the comment, and pressing again
 * would create a second one.
 *
 * @type {readonly string[]}
 */
const RETRYABLE = [
  'allowlist',
  'provenance',
  'unreadable',
  'unverifiable',
  'no-form',
  'mismatch',
  'fetch',
];

/**
 * Runs the write the button asks for and reports what happened. The button
 * stays disabled once a press has reached GitHub, because a press whose result
 * the extension could not confirm may still have created the comment. One
 * press leaves one result: the previous one is taken away first.
 *
 * @param {Document} doc
 * @param {import('../common/parse-detail.js').ParsedDetail} advisory
 * @param {Element} button
 * @param {import('./preserve.js').PreserveOptions} [options]
 * @returns {Promise<import('../common/write.js').WriteResult>}
 */
async function press(doc, advisory, button, options) {
  const host = button.parentElement;
  const note = host?.querySelector('.bghsa-preserve-note') ?? null;
  for (const stale of host?.querySelectorAll('.bghsa-preserve-result') ?? []) stale.remove();
  button.setAttribute('disabled', '');
  button.setAttribute('aria-disabled', 'true');
  if (note !== null) note.textContent = 'Writing the comment.';

  const outcome = await globalThis.bghsa.preserve.preserve(advisory, options);

  if (outcome.ok) {
    button.remove();
    if (note !== null) note.textContent = 'The original report is preserved.';
    return outcome;
  }
  // The comment is on the advisory, written from somewhere else. There is
  // nothing left to press.
  if (outcome.reason === 'preserved') {
    button.remove();
    if (note !== null) note.textContent = outcome.message;
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
  host?.append(banner);
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
 * The panel, built from a parsed advisory, its derived state, and the tracking
 * state the advisory's snapshots hold. It reads nothing from the document
 * beyond the document itself, which creates the nodes.
 *
 * @param {Document} doc
 * @param {import('../common/parse-detail.js').ParsedDetail} advisory
 * @param {import('../common/derive.js').DerivedState} derived
 * @param {import('./tracking.js').TrackingView} tracking
 * @returns {Element}
 */
function buildPanel(doc, advisory, derived, tracking) {
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

  panel.append(buildConfirmations(doc, tracking));
  for (const banner of confirmationWarnings(doc, tracking)) panel.append(banner);
  for (const track of buildTracks(doc, tracking)) panel.append(track);

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
  const header = doc.querySelector(globalThis.bghsa.parseDetail.DESCRIPTION_HEADER);
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
 * @param {import('./tracking.js').TrackingView} tracking
 * @returns {Element | null} the panel, or null when the page offers no anchor.
 */
function injectPanel(doc, advisory, derived, tracking) {
  const panel = buildPanel(doc, advisory, derived, tracking);
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
 * Reading is asynchronous because a confirmation is judged against a
 * fingerprint, and a digest is computed asynchronously.
 *
 * @param {Document} doc
 * @returns {Promise<Element | null>}
 */
async function render(doc) {
  const advisory = globalThis.bghsa.parseDetail.parseDetail(doc);
  if (advisory === null) return null;
  const merged = globalThis.bghsa.merge.mergeSnapshots(advisory.comments);
  const tracking = await globalThis.bghsa.tracking.readAdvisory(advisory, merged);
  const placed = injectPanel(doc, advisory, globalThis.bghsa.derive.derive(advisory), tracking);
  // The chips carry the extension's tone classes, and a page offering the
  // panel no anchor still gets them.
  ensureStyle(doc);
  globalThis.bghsa.comments.markComments(doc, merged);
  return placed;
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
      if (outOfPlace(doc)) void render(doc);
    }, 0);
  });
  observer.observe(target, { childList: true, subtree: true });
  return observer;
}

/**
 * @returns {void} renders the panel into this page and keeps it there.
 */
function start() {
  void render(globalThis.document);
  observe(globalThis.document);
}

globalThis.bghsa.panel = {
  PANEL_ID,
  STYLE_ID,
  MISSING,
  CONFIRMATION_TRACKS,
  missingValues,
  when,
  buildConfirmations,
  confirmationWarnings,
  buildTracks,
  buildPreserve,
  press,
  buildPanel,
  anchor,
  ensureStyle,
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
