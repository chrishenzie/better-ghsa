'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/parse-detail.js');
  require('../common/merge.js');
  require('../common/chips.js');
}

/**
 * @typedef {import('../common/merge.js').MergedState} MergedState
 * @typedef {import('../common/merge.js').MergeWarning} MergeWarning
 * @typedef {import('../common/merge.js').WarningKind} WarningKind
 */

(() => {
  /**
   * What the chip says about a snapshot the merge would not take. Each phrase
   * names the condition and stands alone, and no chip is placed where the merge
   * had nothing to say. A marked comment holding no snapshot and one holding a
   * snapshot that failed validation read the same: both are a state comment
   * this extension cannot use.
   *
   * The untrusted phrase leads with what the extension did, because a snapshot
   * an outsider wrote is the one case here that a reader has to act on. It says
   * what the extension can see, which is that the author carries no member
   * badge, and not why they wrote it: nothing on the page says that.
   *
   * @type {Record<WarningKind, string>}
   */
  const CHIP_TEXT = {
    untrusted: 'Ignored: non-member state',
    'invalid payload': 'Unable to parse tracking state',
    'not a snapshot': 'Unable to parse tracking state',
    'unsupported schema': 'Tracking state from a newer extension',
  };

  /**
   * The Primer state color each chip takes. A snapshot from outside the
   * organization is a claim on the advisory's triage state by someone who
   * cannot make one, so it is the loudest of the four.
   *
   * @type {Record<WarningKind, 'attention' | 'danger'>}
   */
  const CHIP_TONE = {
    untrusted: 'danger',
    'invalid payload': 'attention',
    'not a snapshot': 'attention',
    'unsupported schema': 'attention',
  };

  /**
   * The comment a warning names, if the document still carries it.
   *
   * @param {Document} doc
   * @param {string} elementId
   * @returns {Element | null}
   */
  function commentGroup(doc, elementId) {
    const group = doc.getElementById(elementId);
    if (group === null) return null;
    return group.matches('div.timeline-comment-group[id^="advisory-comment-"]') ? group : null;
  }

  /**
   * @param {Document} doc
   * @param {MergeWarning} alert
   * @returns {Element}
   */
  function buildChip(doc, alert) {
    const parse = globalThis.bghsa.parseDetail;
    const node = globalThis.bghsa.chips.buildChip(doc, {
      text: CHIP_TEXT[alert.kind],
      tone: CHIP_TONE[alert.kind],
    });
    node.setAttribute(parse.EXTENSION_CHIP_ATTRIBUTE, alert.kind);
    // A warning with nothing to add carries no tooltip, so hovering the chip
    // does not repeat the words already on it.
    if (alert.message !== '') node.setAttribute('title', alert.message);
    return node;
  }

  /**
   * Puts `node` beside the comment's author role badge, which is where
   * REQUIREMENTS.md section 4's role labels sit. A badge GitHub wrapped in a
   * tooltip is passed as a whole, so the chip does not inherit that tooltip. A
   * comment carrying no badge takes the chip at the end of its header.
   *
   * @param {Element} group
   * @param {Element} node
   * @returns {boolean} whether the chip was placed.
   */
  function placeChip(group, node) {
    const parse = globalThis.bghsa.parseDetail;
    const header = group.querySelector('div.timeline-comment-header');
    if (header === null) return false;
    const badge = Array.from(header.querySelectorAll('span.Label')).find(
      (label) =>
        label.closest('.comment-body') === null &&
        !label.hasAttribute(parse.EXTENSION_CHIP_ATTRIBUTE)
    );
    if (badge === undefined) {
      header.append(node);
      return true;
    }
    const wrapper = badge.closest('span.tooltipped');
    const outer = wrapper !== null && header.contains(wrapper) ? wrapper : badge;
    const host = outer.parentElement;
    if (host === null) return false;
    host.insertBefore(node, outer.nextSibling);
    return true;
  }

  /**
   * Marks the comments whose snapshots the merge would not take.
   * REQUIREMENTS.md section 8 puts this on the comment rather than in the panel:
   * the panel does not list the snapshots it read, and the reader wants to know
   * which comment the extension is talking about.
   *
   * A comment already carrying the chip it should carry is left as it is, so a
   * second pass over an unchanged document changes nothing and cannot feed the
   * mutation observer that calls it.
   *
   * @param {Document} doc
   * @param {MergedState} merged
   * @returns {Element[]} the chips the document carries afterwards.
   */
  function markComments(doc, merged) {
    const attribute = globalThis.bghsa.parseDetail.EXTENSION_CHIP_ATTRIBUTE;

    // One comment draws at most one warning, because the merge stops reading a
    // snapshot at the first thing wrong with it.
    /** @type {Map<string, MergeWarning>} */
    const wanted = new Map();
    for (const alert of merged.warnings) {
      if (!wanted.has(alert.elementId)) wanted.set(alert.elementId, alert);
    }

    for (const existing of doc.querySelectorAll(`[${attribute}]`)) {
      const group = existing.closest('div.timeline-comment-group[id^="advisory-comment-"]');
      const alert = group === null ? undefined : wanted.get(group.id);
      if (group !== null && alert !== undefined && existing.getAttribute(attribute) === alert.kind) {
        wanted.delete(group.id);
        continue;
      }
      existing.remove();
    }

    for (const [elementId, alert] of wanted) {
      const group = commentGroup(doc, elementId);
      if (group === null) continue;
      placeChip(group, buildChip(doc, alert));
    }

    return Array.from(doc.querySelectorAll(`[${attribute}]`));
  }

  const exported = { CHIP_TEXT, CHIP_TONE, buildChip, placeChip, markComments };

  globalThis.bghsa.comments = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
