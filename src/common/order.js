'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./text.js');
}

/**
 * @typedef {object} OrderEntry
 * @property {string | null} ghsaId
 * @property {string | null} state The state GitHub holds the advisory in, as it
 *   names it.
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

/**
 * What the waiting state is read from. It is the three fields of an
 * {@link OrderEntry} that answer it, and no more, so a surface holding a parsed
 * advisory and its tracking state can ask for the waiting state without
 * assembling a row.
 *
 * @typedef {Pick<OrderEntry, 'neverReviewed' | 'newActivity' | 'triage'>} WaitingEntry
 */

(() => {
  /**
   * The groups the list table orders within a state by, as REQUIREMENTS.md
   * section 9 names them.
   */
  const GROUPS = {
    EMBARGO_OVERDUE: 'embargo overdue',
    NEW_ACTIVITY: 'new activity',
    BLOCKED_ON_US: 'blocked on us',
    NEVER_REVIEWED: 'never reviewed',
    BLOCKED_ON_REPORTER: 'blocked on the reporter',
  };

  /**
   * The groups of a draft advisory, most urgent first. Never reviewed is not
   * among them: a maintainer moved the advisory to draft, so it has been
   * reviewed.
   *
   * @type {readonly string[]}
   */
  const DRAFT_GROUPS = [
    GROUPS.EMBARGO_OVERDUE,
    GROUPS.NEW_ACTIVITY,
    GROUPS.BLOCKED_ON_US,
    GROUPS.BLOCKED_ON_REPORTER,
  ];

  /**
   * The groups of an advisory in triage, most urgent first. This is a different
   * order from {@link DRAFT_GROUPS} and not the same order with an exception:
   * blocked on us and new activity swap ends, and never reviewed sits between
   * them.
   *
   * @type {readonly string[]}
   */
  const TRIAGE_GROUPS = [
    GROUPS.EMBARGO_OVERDUE,
    GROUPS.BLOCKED_ON_US,
    GROUPS.NEVER_REVIEWED,
    GROUPS.NEW_ACTIVITY,
    GROUPS.BLOCKED_ON_REPORTER,
  ];

  /**
   * The waiting state one row's chip carries, in the order the chip prefers
   * them. This says what an advisory is waiting on, which the filter and the
   * chip show; it is not what the default order sorts by.
   *
   * @type {readonly string[]}
   */
  const WAITING_STATES = [
    GROUPS.NEVER_REVIEWED,
    GROUPS.NEW_ACTIVITY,
    GROUPS.BLOCKED_ON_US,
    GROUPS.BLOCKED_ON_REPORTER,
  ];

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
   * A value this reader does not know is waiting on us: it takes a maintainer
   * to say otherwise. An advisory carrying no stored triage value is waiting on
   * nobody, because this reads triage values and it has none.
   *
   * @param {string | null | undefined} triage
   * @returns {'us' | 'reporter' | null} null where no triage value is stored.
   */
  function classifyTriage(triage) {
    if (typeof triage !== 'string' || triage.trim() === '') return null;
    return BLOCKED_ON[triage.trim().toLowerCase()] ?? 'us';
  }

  /**
   * Whether the advisory is waiting on a maintainer, by REQUIREMENTS.md section
   * 9.
   *
   * An advisory carrying no stored triage value answers to this in draft alone,
   * where a maintainer accepted it and has not said where it stands. In triage
   * it answers to never reviewed, which draft does not hold.
   *
   * @param {OrderEntry} entry
   * @returns {boolean}
   */
  function blockedOnUs(entry) {
    const blocked = classifyTriage(entry.triage);
    if (blocked === null) return stateOf(entry) === 'draft';
    return blocked === 'us';
  }

  /**
   * @param {OrderEntry} entry
   * @returns {boolean} whether the advisory carries no stored triage value.
   */
  function untriaged(entry) {
    return classifyTriage(entry.triage) === null;
  }

  /**
   * Which state's group order an advisory takes.
   *
   * Only draft and triage reach this table. A state this reader cannot read, and
   * the published and closed states the done page holds, take the triage order,
   * the way an unknown triage value counts as blocked on us.
   *
   * @param {OrderEntry} entry
   * @returns {'draft' | 'triage'}
   */
  function stateOf(entry) {
    if (typeof entry.state !== 'string') return 'triage';
    return entry.state.trim().toLowerCase() === 'draft' ? 'draft' : 'triage';
  }

  /**
   * @param {'draft' | 'triage'} state
   * @returns {readonly string[]} the groups of that state, most urgent first.
   */
  function groupsFor(state) {
    return state === 'draft' ? DRAFT_GROUPS : TRIAGE_GROUPS;
  }

  /**
   * Whether an advisory answers to one group.
   *
   * @type {Readonly<Record<string, (entry: OrderEntry) => boolean>>}
   */
  const MEMBER_OF = {
    [GROUPS.EMBARGO_OVERDUE]: (entry) => entry.embargoOverdue,
    [GROUPS.NEW_ACTIVITY]: (entry) => entry.newActivity,
    [GROUPS.BLOCKED_ON_US]: (entry) => blockedOnUs(entry),
    [GROUPS.NEVER_REVIEWED]: (entry) => entry.neverReviewed || untriaged(entry),
    [GROUPS.BLOCKED_ON_REPORTER]: (entry) => classifyTriage(entry.triage) === 'reporter',
  };

  /**
   * The group an advisory sorts in, which is the first of its state's groups it
   * answers to.
   *
   * Every advisory reaches a group. A triage value names us or the reporter,
   * and those two are groups of both states; no triage value takes blocked on
   * us in draft and never reviewed in triage.
   *
   * @param {OrderEntry} entry
   * @returns {string} one of {@link GROUPS}.
   */
  function groupOf(entry) {
    const groups = groupsFor(stateOf(entry));
    const found = groups.find((group) => MEMBER_OF[group]?.(entry) === true);
    return found ?? GROUPS.BLOCKED_ON_REPORTER;
  }

  /**
   * @param {OrderEntry} entry
   * @returns {number} how far down its state's groups the advisory sits, and the
   *   length of that list for a group it does not hold.
   */
  function groupRank(entry) {
    const groups = groupsFor(stateOf(entry));
    const rank = groups.indexOf(groupOf(entry));
    return rank === -1 ? groups.length : rank;
  }

  /**
   * The waiting state one advisory shows, which is the first of
   * {@link WAITING_STATES} it answers to.
   *
   * Never reviewed here is section 6's derived value, which member activity
   * says, and the ordering group of the same name is the absence of a stored
   * triage value. An advisory a member has touched and nobody has triaged shows
   * blocked on us and sorts in never reviewed.
   *
   * @param {WaitingEntry} entry
   * @returns {string}
   */
  function waitingStateOf(entry) {
    if (entry.neverReviewed) return GROUPS.NEVER_REVIEWED;
    if (entry.newActivity) return GROUPS.NEW_ACTIVITY;
    return classifyTriage(entry.triage) === 'reporter'
      ? GROUPS.BLOCKED_ON_REPORTER
      : GROUPS.BLOCKED_ON_US;
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
   * The default order of the list table, by REQUIREMENTS.md section 9.
   *
   * State comes first: every draft sorts above every advisory in triage. Within
   * a state the advisory takes the first group it answers to, and the two states
   * name their groups in different orders, so the group key is an index into the
   * state's own list. Within a group the severities a maintainer confirmed come
   * first, highest first, then the severities nobody has confirmed, highest
   * first, then the longest waiting, and the identifier settles what is left.
   *
   * @param {OrderEntry} a
   * @param {OrderEntry} b
   * @returns {number}
   */
  function compare(a, b) {
    const draft = Number(stateOf(b) === 'draft') - Number(stateOf(a) === 'draft');
    if (draft !== 0) return draft;

    const group = groupRank(a) - groupRank(b);
    if (group !== 0) return group;

    const confirmed = confirmedRank(b) - confirmedRank(a);
    if (confirmed !== 0) return confirmed;

    const unconfirmed = unconfirmedRank(b) - unconfirmedRank(a);
    if (unconfirmed !== 0) return unconfirmed;

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
    GROUPS,
    WAITING_STATES,
    severityRank,
    classifyTriage,
    blockedOnUs,
    stateOf,
    groupsFor,
    groupOf,
    groupRank,
    waitingStateOf,
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
