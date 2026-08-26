'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/dom.js');
  require('../common/trust.js');
  require('../common/parse-detail.js');
  require('../common/derive.js');
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
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A snapshot field as one line of text. Anything this reader has no display for
 * is shown as its JSON source, so nothing the snapshot carries is hidden.
 *
 * @param {unknown} value
 * @returns {string | null} null when the field is absent.
 */
function fieldText(value) {
  if (value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    return value.map((entry) => fieldText(entry) ?? 'null').join(', ');
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The names of the values the panel displays that could not be read. An empty
 * list means the panel shows everything it set out to show.
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
 * @param {Document} doc
 * @param {string} text
 * @param {string} [tone] A Primer `Label--*` modifier.
 * @returns {Element}
 */
function chip(doc, text, tone) {
  return element(doc, 'span', `Label ${tone ?? 'Label--secondary'}`, text);
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
 * The chip row, which is visible whatever else the panel shows.
 *
 * @param {Document} doc
 * @param {import('../common/parse-detail.js').ParsedDetail} advisory
 * @param {import('../common/derive.js').DerivedState} derived
 * @returns {Element}
 */
function buildChips(doc, advisory, derived) {
  const header = element(doc, 'div', 'Box-header bghsa-chips');
  header.append(element(doc, 'strong', 'mr-2', 'Better GHSA'));
  header.append(chip(doc, `State: ${shown(advisory.state)}`));
  header.append(chip(doc, `Severity: ${shown(advisory.severityLabel)}`));
  const cve = derived.cve;
  header.append(chip(doc, `CVE: ${cve.id === null ? cve.state : cve.id}`));
  header.append(
    chip(
      doc,
      `Never reviewed: ${derived.neverReviewed ? 'yes' : 'no'}`,
      derived.neverReviewed ? 'Label--danger' : 'Label--secondary'
    )
  );
  header.append(
    chip(
      doc,
      `New activity: ${derived.newActivity ? 'yes' : 'no'}`,
      derived.newActivity ? 'Label--attention' : 'Label--secondary'
    )
  );
  return header;
}

/**
 * The comment thread, one line per comment, carrying the role GitHub badged
 * that comment's author with and whether that author's snapshots count.
 *
 * @param {Document} doc
 * @param {import('../common/parse-detail.js').ParsedDetail} advisory
 * @returns {Element}
 */
function buildComments(doc, advisory) {
  const { row: container, body } = row(doc, 'Comments');
  if (advisory.comments.length === 0) {
    body.append(element(doc, 'div', 'color-fg-muted', 'No comments.'));
    return container;
  }
  const list = element(doc, 'ul', 'list-style-none');
  for (const comment of advisory.comments) {
    const item = element(doc, 'li', 'bghsa-comment');
    item.append(element(doc, 'span', 'text-bold', shown(comment.author)));
    item.append(doc.createTextNode(' '));
    item.append(chip(doc, shown(comment.role)));
    item.append(
      doc.createTextNode(
        ` ${comment.trusted ? 'trusted' : 'not trusted'} · ${shown(comment.at)}`
      )
    );
    list.append(item);
  }
  body.append(list);
  return container;
}

/**
 * The private fork's pull requests, the branch each targets, and whether a
 * branch has a merged one.
 *
 * @param {Document} doc
 * @param {import('../common/derive.js').PatchState} patch
 * @returns {Element}
 */
function buildPatches(doc, patch) {
  const { row: container, body } = row(doc, 'Patches');
  if (!patch.hasFork) {
    body.append(element(doc, 'div', 'color-fg-muted', 'No private fork.'));
    return container;
  }
  if (patch.pullRequests.length === 0) {
    body.append(element(doc, 'div', 'color-fg-muted', 'The private fork has no pull request.'));
  }
  const list = element(doc, 'ul', 'list-style-none');
  for (const pull of patch.pullRequests) {
    const item = element(doc, 'li', 'bghsa-pull');
    const number = pull.number === null ? MISSING : `#${pull.number}`;
    if (pull.url === null) {
      item.append(element(doc, 'span', 'text-bold', number));
    } else {
      const link = element(doc, 'a', 'text-bold', number);
      link.setAttribute('href', pull.url);
      item.append(link);
    }
    item.append(
      doc.createTextNode(
        ` ${pull.title} → ${shown(pull.baseRef)} (${shown(pull.state)})`
      )
    );
    list.append(item);
  }
  body.append(list);
  for (const branch of patch.branches) {
    const numbers = branch.pullRequests.map((number) => `#${number}`).join(', ');
    body.append(
      element(
        doc,
        'div',
        'bghsa-branch',
        `${branch.branch}: ${numbers === '' ? MISSING : numbers}`
      )
    );
  }
  if (patch.incomplete) {
    body.append(warning(doc, 'A pull request named a state this extension does not read.'));
  }
  return container;
}

/**
 * One state comment as the advisory carries it. Nothing here decides which
 * snapshot wins; every one present is shown.
 *
 * @param {Document} doc
 * @param {import('../common/parse-detail.js').ParsedComment} comment
 * @param {import('../common/parse-detail.js').SnapshotReport} snapshot
 * @returns {Element}
 */
function buildStateComment(doc, comment, snapshot) {
  const { row: container, body } = row(doc, 'State comment');
  body.append(
    element(
      doc,
      'div',
      'text-bold bghsa-state-author',
      `${shown(comment.author)} (${shown(comment.role)}) · ${shown(comment.at)}`
    )
  );

  const fields = element(doc, 'ul', 'list-style-none');
  /** @type {[string, unknown][]} */
  const entries = [];
  const payload = isPlainObject(snapshot.parsed) ? snapshot.parsed : {};
  entries.push(['schema', snapshot.version]);
  entries.push(['seq', snapshot.seq]);
  entries.push(['written by', snapshot.by]);
  for (const key of ['at', 'triage', 'triageSince', 'owners', 'backports']) {
    entries.push([key, payload[key]]);
  }
  const embargo = payload['embargo'];
  if (isPlainObject(embargo)) entries.push(['embargo lifts', embargo['lift']]);
  const closure = payload['closure'];
  if (isPlainObject(closure)) {
    entries.push(['closure reason', closure['reason']]);
    entries.push(['duplicate of', closure['duplicateOf']]);
  }
  const confirmed = payload['confirmed'];
  if (isPlainObject(confirmed)) entries.push(['confirmed', Object.keys(confirmed)]);

  for (const [name, value] of entries) {
    const text = fieldText(value ?? undefined);
    if (text === null) continue;
    fields.append(element(doc, 'li', 'bghsa-field', `${name}: ${text}`));
  }
  body.append(fields);

  if (!comment.trusted) {
    body.append(
      warning(
        doc,
        `${shown(comment.author)} carries no member or owner badge on this comment, so this state comment is not trusted.`
      )
    );
  }
  for (const problem of snapshot.problems) {
    body.append(warning(doc, `This state comment failed validation: ${problem}.`));
  }
  if (snapshot.unrecognized.length > 0) {
    body.append(
      warning(
        doc,
        `This state comment holds a value this extension does not interpret: ${snapshot.unrecognized.join(', ')}.`
      )
    );
  }
  return container;
}

/**
 * The panel, built from a parsed advisory and its derived state. It reads
 * nothing from the document beyond the document itself, which creates the
 * nodes.
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

  const advisoryRow = row(doc, 'Advisory');
  advisoryRow.body.textContent =
    advisory.ref === null
      ? shown(advisory.ghsaId)
      : `${shown(advisory.ghsaId)} in ${advisory.ref.owner}/${advisory.ref.repo}`;
  panel.append(advisoryRow.row);

  const reporterRow = row(doc, 'Reporter');
  reporterRow.body.textContent = `${shown(advisory.reporter)} reported ${shown(advisory.reportedAt)}`;
  panel.append(reporterRow.row);

  const descriptionRow = row(doc, 'Description');
  descriptionRow.body.textContent =
    advisory.descriptionOriginal === null
      ? `Provenance ${MISSING}.`
      : advisory.descriptionOriginal
        ? "The reporter's original text."
        : 'Edited since it was reported.';
  panel.append(descriptionRow.row);

  const cveRow = row(doc, 'CVE');
  cveRow.body.textContent =
    derived.cve.id === null
      ? `${derived.cve.state} (selection: ${shown(derived.cve.selection)})`
      : `${derived.cve.id} (${derived.cve.state})`;
  panel.append(cveRow.row);

  panel.append(buildComments(doc, advisory));
  panel.append(buildPatches(doc, derived.patch));

  for (const comment of advisory.comments) {
    if (comment.stateComment === null) continue;
    panel.append(buildStateComment(doc, comment, comment.stateComment));
  }

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
