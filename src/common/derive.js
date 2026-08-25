'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependency is named here.
if (typeof require === 'function') require('./trust.js');

/**
 * @param {(string | null)[]} times
 * @returns {string | null} the latest of the ISO times given, ignoring nulls.
 */
function latest(times) {
  /** @type {string | null} */
  let newest = null;
  for (const time of times) {
    if (time === null) continue;
    if (newest === null || time > newest) newest = time;
  }
  return newest;
}

/**
 * The logins the page shows to be org members. A role badge is the only member
 * signal the detail page carries, and it appears on comments alone, so a member
 * who acted without commenting is not visible here.
 *
 * @param {import('./parse-detail.js').ParsedDetail} advisory
 * @returns {string[]}
 */
function memberLogins(advisory) {
  const trust = globalThis.bghsa.trust;
  /** @type {string[]} */
  const members = [];
  for (const comment of advisory.comments) {
    if (!trust.isTrustedAuthor(comment.author, comment.role)) continue;
    const login = /** @type {string} */ (comment.author);
    if (!members.includes(login)) members.push(login);
  }
  return members;
}

/**
 * @typedef {object} CveState
 * @property {string | null} id The assigned CVE.
 * @property {boolean} assigned
 * @property {boolean} requested Whether the timeline records a CVE request.
 * @property {string | null} selection The advisory's stored CVE selection.
 * @property {'assigned' | 'requested' | 'not applicable' | 'none'} state
 */

/**
 * @param {import('./parse-detail.js').ParsedDetail} advisory
 * @returns {CveState}
 */
function cveState(advisory) {
  const id = advisory.cveId;
  const assigned = id !== null;
  const requested = advisory.timeline.some((event) => /\brequested a CVE\b/.test(event.text));
  /** @type {CveState['state']} */
  let state;
  if (assigned) state = 'assigned';
  else if (requested) state = 'requested';
  else if (advisory.cveSelection === 'not_applicable') state = 'not applicable';
  else state = 'none';
  return { id, assigned, requested, selection: advisory.cveSelection, state };
}

/**
 * @typedef {object} BranchPatch
 * @property {string} branch
 * @property {number[]} pullRequests The numbers targeting this branch.
 * @property {boolean} open Whether one of them is open.
 */

/**
 * @typedef {object} PatchState
 * @property {boolean} hasFork
 * @property {import('./parse-detail.js').ForkPullRequest[]} pullRequests
 * @property {BranchPatch[]} branches In the order the branches first appear.
 * @property {number[]} merged
 * @property {number[]} open
 * @property {number[]} closed
 */

/**
 * Which pull requests the private fork holds, which branches they target, and
 * which are merged.
 *
 * @param {import('./parse-detail.js').ParsedDetail} advisory
 * @returns {PatchState}
 */
function patchState(advisory) {
  const pullRequests = advisory.fork === null ? [] : advisory.fork.pullRequests;
  /** @type {BranchPatch[]} */
  const branches = [];
  /** @type {number[]} */
  const merged = [];
  /** @type {number[]} */
  const open = [];
  /** @type {number[]} */
  const closed = [];

  for (const pull of pullRequests) {
    if (pull.number !== null) {
      if (pull.state === 'merged') merged.push(pull.number);
      else if (pull.state === 'open') open.push(pull.number);
      else if (pull.state === 'closed') closed.push(pull.number);
    }
    if (pull.baseRef === null) continue;
    let branch = branches.find((entry) => entry.branch === pull.baseRef);
    if (branch === undefined) {
      branch = { branch: pull.baseRef, pullRequests: [], open: false };
      branches.push(branch);
    }
    if (pull.number !== null) branch.pullRequests.push(pull.number);
    if (pull.state === 'open') branch.open = true;
  }

  return { hasFork: advisory.fork !== null, pullRequests, branches, merged, open, closed };
}

/**
 * @typedef {object} DerivedState
 * @property {string[]} members The logins the page shows to be org members.
 * @property {boolean} neverReviewed No member has commented on or acted on the
 *   advisory.
 * @property {boolean} newActivity The newest comment from a non-member is newer
 *   than the newest member comment or member action.
 * @property {string | null} lastMemberActivityAt
 * @property {string | null} lastNonMemberCommentAt
 * @property {CveState} cve
 * @property {PatchState} patch
 */

/**
 * Derived state for one parsed advisory. None of it is stored.
 *
 * @param {import('./parse-detail.js').ParsedDetail} advisory
 * @returns {DerivedState}
 */
function derive(advisory) {
  const members = memberLogins(advisory);

  /** @type {(string | null)[]} */
  const memberActivity = [];
  /** @type {(string | null)[]} */
  const nonMemberComments = [];
  for (const comment of advisory.comments) {
    if (comment.trusted) memberActivity.push(comment.at);
    else nonMemberComments.push(comment.at);
  }
  for (const event of advisory.timeline) {
    if (event.actor === null || !members.includes(event.actor)) continue;
    memberActivity.push(event.at);
  }

  const lastMemberActivityAt = latest(memberActivity);
  const lastNonMemberCommentAt = latest(nonMemberComments);

  return {
    members,
    neverReviewed: memberActivity.length === 0,
    newActivity:
      lastNonMemberCommentAt !== null &&
      (lastMemberActivityAt === null || lastNonMemberCommentAt > lastMemberActivityAt),
    lastMemberActivityAt,
    lastNonMemberCommentAt,
    cve: cveState(advisory),
    patch: patchState(advisory),
  };
}

globalThis.bghsa.derive = { derive, memberLogins, cveState, patchState };

if (typeof module !== 'undefined') {
  module.exports = globalThis.bghsa.derive;
}
