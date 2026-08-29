'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependency is named here.
if (typeof require === 'function') require('./trust.js');

/**
 * @typedef {object} CveState
 * @property {string | null} id The assigned CVE.
 * @property {boolean} assigned
 * @property {boolean} requested Whether the timeline records a CVE request.
 * @property {string | null} selection The advisory's stored CVE selection.
 * @property {'assigned' | 'requested' | 'not applicable' | 'none'} state
 */

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
 * @property {number[]} open
 * @property {number[]} unknown The numbers of the pull requests whose row named
 *   no state this reader knows.
 * @property {boolean} incomplete Whether any row's state went unread, which
 *   makes the counts and the branch flags a lower bound.
 */

/**
 * @typedef {object} DerivedState
 * @property {string[]} members The logins the page shows to be org members.
 * @property {boolean} neverReviewed No member has commented on or acted on the
 *   advisory, and its state does not carry a review. An action is a comment
 *   from a badged author, a timeline event a visible member caused, or a
 *   timeline event only a maintainer can cause.
 * @property {boolean} newActivity The newest comment from a non-member is newer
 *   than the newest member comment or member action.
 * @property {string | null} lastMemberActivityAt
 * @property {string | null} lastNonMemberCommentAt
 * @property {CveState} cve
 * @property {PatchState} patch
 */

(() => {
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
   * who acted without commenting is not visible here. What that member did is
   * read from the timeline instead, by {@link maintainerOnlyEvent}.
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
   * The wording of a timeline event with its actor taken off the front.
   *
   * An event reads `<actor> <phrase> <time>`, and the actor is one token that
   * holds no space. Only a person acts on an advisory, since no app and no bot
   * takes an act on one, so the actor is that person's login, and a login holds
   * no space. Everything a phrase is matched against therefore starts where the
   * phrase starts.
   *
   * That front anchor is what keeps a title from being read as a phrase. The
   * only text on an advisory its reporter writes and the timeline repeats is
   * the title, and it reaches the timeline through a `changed the title` event,
   * which puts `changed the title` in the anchored position and the title after
   * it. A title reading `closed this` lands in the middle of the phrase, where
   * nothing looks.
   *
   * @param {import('./parse-detail.js').TimelineEvent} event
   * @returns {string} the phrase, and the empty string for text holding no
   *   actor and phrase both.
   */
  function eventPhrase(event) {
    const space = event.text.indexOf(' ');
    return space === -1 ? '' : event.text.slice(space + 1);
  }

  /**
   * Timeline phrases the reporter or GitHub itself produces. REQUIREMENTS.md
   * section 6 lists them, and they are checked before the maintainer-only
   * phrases so that no reading of a reporter's act can reach one.
   *
   * `added themselves as a collaborator` is the pair that needs the order: it
   * holds `as a collaborator` and would otherwise answer to the phrase for a
   * maintainer adding somebody else.
   */
  const REPORTER_EVENTS = [
    /^was credited as a reporter\b/,
    /^accepted credit\b/,
    /^added themselves as a collaborator\b/,
    /^changed the title\b/,
    /^created the temporary private fork\b/,
    /^released this\b/,
    /^assigned\b/,
  ];

  /** The phrase a maintainer's CVE request writes, which nothing else writes. */
  const CVE_REQUEST_EVENT = /^requested a CVE\b/;

  /**
   * Timeline phrases only a maintainer can cause, from REQUIREMENTS.md
   * section 6. Each counts as a review whether or not the actor can be placed,
   * because the detail page badges comment authors and nothing else, so a
   * maintainer who acted without commenting is nowhere in the member list.
   */
  const MAINTAINER_EVENTS = [
    /^accepted this report\b/,
    /^added\b.+\bas a collaborator\b/,
    CVE_REQUEST_EVENT,
    /^published this\b/,
    /^closed this\b/,
    /^deleted the temporary private fork\b/,
  ];

  /**
   * Whether a timeline event carries the act a phrase pattern names.
   *
   * Every reading of a timeline event goes through here, and the pattern is
   * matched against {@link eventPhrase} anchored at its front, so it sees the
   * wording GitHub writes and never the title the reporter writes. A pattern
   * that matched anywhere in the text would read a title: `changed the title`
   * repeats the new title after it, so a title reading `requested a CVE` or
   * `closed this` would answer to a pattern for the CVE request or the close.
   *
   * The anchor is what covers an event neither list here names, because the
   * reporter's phrases are only refused where this reader knows them.
   *
   * @param {import('./parse-detail.js').TimelineEvent} event
   * @param {RegExp} pattern A phrase pattern, anchored with `^`.
   * @returns {boolean}
   */
  function eventIs(event, pattern) {
    const phrase = eventPhrase(event);
    if (REPORTER_EVENTS.some((reporter) => reporter.test(phrase))) return false;
    return pattern.test(phrase);
  }

  /**
   * Whether only a maintainer could have caused this timeline event.
   *
   * @param {import('./parse-detail.js').TimelineEvent} event
   * @returns {boolean}
   */
  function maintainerOnlyEvent(event) {
    return MAINTAINER_EVENTS.some((pattern) => eventIs(event, pattern));
  }

  /**
   * Whether the advisory's state carries a review. A `draft` or `published`
   * advisory is there because a maintainer moved it there. A `closed` advisory
   * can have been withdrawn by its reporter, so its state carries nothing.
   *
   * @param {import('./parse-detail.js').ParsedDetail} advisory
   * @returns {boolean}
   */
  function reviewedByState(advisory) {
    const state = advisory.state === null ? null : advisory.state.toLowerCase();
    return state === 'draft' || state === 'published';
  }

  /** A stored lift date carrying no time of day, which stands for the whole day. */
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

  /**
   * @param {string} lift A stored embargo lift date.
   * @returns {number | null} the instant the embargo has run past, and null for
   *   a value that does not read as a time. A date with no time of day stands
   *   for the whole of that day, so it runs out at the end of it in UTC.
   */
  function liftInstant(lift) {
    const stamp = DATE_ONLY.test(lift) ? `${lift}T23:59:59.999Z` : lift;
    const parsed = Date.parse(stamp);
    return Number.isNaN(parsed) ? null : parsed;
  }

  /**
   * Whether the embargo on this advisory has run out: its lift date has gone by
   * and the advisory is not published.
   *
   * An advisory whose state this extension could not read counts as unpublished,
   * because the page said nothing that says otherwise.
   *
   * @param {import('./parse-detail.js').ParsedDetail} advisory
   * @param {string | null} lift The stored lift date, and null where no embargo
   *   is in force or none names a date.
   * @param {number} [now] The instant to judge the date against.
   * @returns {boolean}
   */
  function embargoOverdue(advisory, lift, now = Date.now()) {
    if (lift === null) return false;
    if ((advisory.state === null ? null : advisory.state.toLowerCase()) === 'published') return false;
    const instant = liftInstant(lift);
    return instant !== null && now > instant;
  }

  /**
   * @param {import('./parse-detail.js').ParsedDetail} advisory
   * @returns {CveState}
   */
  function cveState(advisory) {
    const id = advisory.cveId;
    const assigned = id !== null;
    const requested = advisory.timeline.some((event) => eventIs(event, CVE_REQUEST_EVENT));
    /** @type {CveState['state']} */
    let state;
    if (assigned) state = 'assigned';
    else if (requested) state = 'requested';
    else if (advisory.cveSelection === 'not_applicable') state = 'not applicable';
    else state = 'none';
    return { id, assigned, requested, selection: advisory.cveSelection, state };
  }

  /**
   * Which pull requests the private fork holds and which branches they target.
   *
   * REQUIREMENTS.md section 6 has the fork's list show open pull requests only,
   * so `open` is the one state a row is read in and any other reading is a row
   * this code could not place: it counts as unknown and marks the patch state
   * incomplete.
   *
   * @param {import('./parse-detail.js').ParsedDetail} advisory
   * @returns {PatchState}
   */
  function patchState(advisory) {
    const pullRequests = advisory.fork === null ? [] : advisory.fork.pullRequests;
    /** @type {BranchPatch[]} */
    const branches = [];
    /** @type {number[]} */
    const open = [];
    /** @type {number[]} */
    const unknown = [];
    let incomplete = false;

    for (const pull of pullRequests) {
      const isOpen = pull.state === 'open';
      if (!isOpen) incomplete = true;
      if (pull.number !== null) {
        if (isOpen) open.push(pull.number);
        else unknown.push(pull.number);
      }
      if (pull.baseRef === null) continue;
      let branch = branches.find((entry) => entry.branch === pull.baseRef);
      if (branch === undefined) {
        branch = { branch: pull.baseRef, pullRequests: [], open: false };
        branches.push(branch);
      }
      if (pull.number !== null) branch.pullRequests.push(pull.number);
      if (isOpen) branch.open = true;
    }

    return {
      hasFork: advisory.fork !== null,
      pullRequests,
      branches,
      open,
      unknown,
      incomplete,
    };
  }

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
      const byMember = event.actor !== null && members.includes(event.actor);
      if (!byMember && !maintainerOnlyEvent(event)) continue;
      memberActivity.push(event.at);
    }

    const lastMemberActivityAt = latest(memberActivity);
    const lastNonMemberCommentAt = latest(nonMemberComments);

    return {
      members,
      neverReviewed: memberActivity.length === 0 && !reviewedByState(advisory),
      newActivity:
        lastNonMemberCommentAt !== null &&
        (lastMemberActivityAt === null || lastNonMemberCommentAt > lastMemberActivityAt),
      lastMemberActivityAt,
      lastNonMemberCommentAt,
      cve: cveState(advisory),
      patch: patchState(advisory),
    };
  }

  const exported = {
    CVE_REQUEST_EVENT,
    derive,
    maintainerOnlyEvent,
    eventIs,
    cveState,
    patchState,
    embargoOverdue,
  };

  globalThis.bghsa.derive = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
