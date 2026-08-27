'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./text.js');
}

/**
 * @typedef {object} OrderEntry
 * @property {string | null} ghsaId
 * @property {boolean} neverReviewed No org member has commented on or acted on
 *   the advisory.
 * @property {boolean} newActivity The reporter has spoken since the last member
 *   comment or member action.
 * @property {string | null} triage The stored triage value.
 * @property {boolean} embargoOverdue The embargo lift date has gone by and the
 *   advisory is not published.
 * @property {string | null} severity The severity the advisory carries.
 * @property {boolean} severityConfirmed Whether a maintainer confirmed that
 *   severity. A confirmation that no longer binds to the current value has
 *   already reverted to unconfirmed by the time it reaches here.
 * @property {string | null} waitingSince The time the advisory entered its
 *   current triage value.
 */

(() => {
  /**
   * The tiers the list table orders by, most urgent first.
   */
  const TIERS = {
    NEVER_REVIEWED: 1,
    NEW_ACTIVITY: 2,
    BLOCKED_ON_US: 3,
    BLOCKED_ON_REPORTER: 4,
  };

  /** @type {readonly string[]} */
  const TIER_NAMES = ['never reviewed', 'new activity', 'blocked on us', 'blocked on the reporter'];

  /**
   * Which side each triage value leaves the advisory waiting on. `evaluating` and
   * `awaiting maintainer input` both need a maintainer, and only `awaiting
   * reporter` hands the advisory back.
   *
   * @type {Readonly<Record<string, 'us' | 'reporter'>>}
   */
  const BLOCKED_ON = {
    evaluating: 'us',
    'awaiting reporter': 'reporter',
    'awaiting maintainer input': 'us',
  };

  /**
   * Severity as a number, highest first, so an unset severity ranks below every
   * severity that is set.
   *
   * @type {Readonly<Record<string, number>>}
   */
  const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1 };

  /**
   * @param {string | null | undefined} severity
   * @returns {number} the rank of `severity`, and 0 for one that is unset or that
   *   this reader does not know.
   */
  function severityRank(severity) {
    if (typeof severity !== 'string') return 0;
    return SEVERITY_RANK[severity.trim().toLowerCase()] ?? 0;
  }

  /**
   * Which side a triage value leaves the advisory waiting on.
   *
   * An advisory carrying no triage value, or one this reader does not know, is
   * waiting on us: it takes a maintainer to say otherwise.
   *
   * @param {string | null | undefined} triage
   * @returns {'us' | 'reporter'}
   */
  function classifyTriage(triage) {
    if (typeof triage !== 'string') return 'us';
    return BLOCKED_ON[triage.trim().toLowerCase()] ?? 'us';
  }

  /**
   * @param {OrderEntry} entry
   * @returns {boolean} whether the advisory is waiting on a maintainer.
   */
  function blockedOnUs(entry) {
    return classifyTriage(entry.triage) === 'us';
  }

  /**
   * The tier an advisory sorts in.
   *
   * @param {OrderEntry} entry
   * @returns {number} one of {@link TIERS}.
   */
  function tierOf(entry) {
    if (entry.neverReviewed) return TIERS.NEVER_REVIEWED;
    if (entry.newActivity) return TIERS.NEW_ACTIVITY;
    return blockedOnUs(entry) ? TIERS.BLOCKED_ON_US : TIERS.BLOCKED_ON_REPORTER;
  }

  /**
   * @param {number} tier
   * @returns {string} what the tier is called, and the empty string for a number
   *   that is not one.
   */
  function tierName(tier) {
    return TIER_NAMES[tier - 1] ?? '';
  }

  /**
   * @param {OrderEntry} entry
   * @returns {number} the severity a maintainer confirmed, and 0 where none is.
   */
  function confirmedRank(entry) {
    return entry.severityConfirmed ? severityRank(entry.severity) : 0;
  }

  /**
   * @param {OrderEntry} entry
   * @returns {number} the severity nobody has confirmed, and 0 where the severity
   *   is confirmed.
   */
  function unconfirmedRank(entry) {
    return entry.severityConfirmed ? 0 : severityRank(entry.severity);
  }

  /**
   * @param {OrderEntry} entry
   * @returns {number | null} the instant the advisory started waiting, and null
   *   for a time this reader cannot read.
   */
  function waitingAt(entry) {
    return globalThis.bghsa.text.instantOf(entry.waitingSince);
  }

  /**
   * Alphabetical, with a value the reader could not read after every value it
   * could. A surface reading a row it could not read every field of shows the
   * fields it did read, so the row is on the list with a hole in it, and the
   * hole sorts to the bottom rather than to the top of a queue worked from the
   * top.
   *
   * @param {string | null} left
   * @param {string | null} right
   * @returns {number}
   */
  function compareText(left, right) {
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }

  /**
   * Smallest first, with a value the reader could not read after every value it
   * could, as {@link compareText} orders one.
   *
   * @param {number | null} left
   * @param {number | null} right
   * @returns {number}
   */
  function compareNumber(left, right) {
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return left - right;
  }

  /**
   * Longest waiting first. An advisory whose waiting time went unread sorts after
   * every advisory whose waiting time is known.
   *
   * @param {OrderEntry} a
   * @param {OrderEntry} b
   * @returns {number}
   */
  function byWaiting(a, b) {
    return compareNumber(waitingAt(a), waitingAt(b));
  }

  /**
   * The last tie-break, so that the order does not depend on the order the rows
   * arrived in. Two entries carrying one identifier keep the order they came in.
   *
   * An advisory whose identifier went unread sorts below every advisory whose
   * identifier is known. Its link did not match `ADVISORY_HREF`, so the row
   * names no advisory to open and no cached read to draw from, and a maintainer
   * working the list from the top has nothing to do with it.
   *
   * @param {OrderEntry} a
   * @param {OrderEntry} b
   * @returns {number}
   */
  function byId(a, b) {
    return compareText(a.ghsaId, b.ghsaId);
  }

  /**
   * The default order of the list table: by tier, and within a tier by the rule
   * in REQUIREMENTS.md section 9.
   *
   * Inside the blocked-on-us tier an overdue embargo comes first, then the
   * severities a maintainer confirmed, highest first, then the severities nobody
   * has confirmed, highest first. Every tier then goes longest waiting first, and
   * the identifier settles what is left.
   *
   * @param {OrderEntry} a
   * @param {OrderEntry} b
   * @returns {number}
   */
  function compare(a, b) {
    const tier = tierOf(a);
    const byTier = tier - tierOf(b);
    if (byTier !== 0) return byTier;

    if (tier === TIERS.BLOCKED_ON_US) {
      const overdue = Number(b.embargoOverdue) - Number(a.embargoOverdue);
      if (overdue !== 0) return overdue;
      const confirmed = confirmedRank(b) - confirmedRank(a);
      if (confirmed !== 0) return confirmed;
      const unconfirmed = unconfirmedRank(b) - unconfirmedRank(a);
      if (unconfirmed !== 0) return unconfirmed;
    }

    const waiting = byWaiting(a, b);
    if (waiting !== 0) return waiting;

    return byId(a, b);
  }

  /**
   * @template {OrderEntry} T
   * @param {readonly T[]} entries
   * @returns {T[]} `entries` in the default order, leaving the argument as it was.
   */
  function sort(entries) {
    return entries.slice().sort(compare);
  }

  const exported = {
    TIERS,
    TIER_NAMES,
    BLOCKED_ON,
    SEVERITY_RANK,
    severityRank,
    classifyTriage,
    blockedOnUs,
    tierOf,
    tierName,
    compareText,
    compareNumber,
    compare,
    sort,
  };

  globalThis.bghsa.order = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
