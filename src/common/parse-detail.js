'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependency is named here.
if (typeof require === 'function') require('./trust.js');

/** The schema major version this reader interprets. */
const SCHEMA_MAJOR = 1;

/** The fixed summary text of a state comment's `details` block. */
const STATE_COMMENT_SUMMARY = 'Better GHSA tracking state';

/** Triage values this reader interprets. @type {readonly string[]} */
const TRIAGE_VALUES = ['evaluating', 'awaiting reporter', 'awaiting maintainer input'];

/** Closure reasons this reader interprets. @type {readonly string[]} */
const CLOSURE_REASONS = [
  'duplicate',
  'not a vulnerability',
  'not reproducible',
  'working as intended',
  'out of scope',
  'no reporter response',
  'withdrawn by reporter',
];

/**
 * The `color-fg-*` modifier a fork row's icon carries for an open pull
 * request, which is the only modifier such a row is drawn with. The fork's
 * list shows open pull requests only: merging deletes the fork and the Box
 * with it, and a closed pull request is not rendered there either.
 */
const OPEN_PULL_COLOR = 'color-fg-open';

/**
 * The `aria-label` an open row's icon carries, read where the modifier is
 * absent or renamed. A row neither reading places leaves the state null,
 * which marks the patch state incomplete and paints the chip `Unknown`.
 */
const OPEN_PULL_LABEL = /^open\b/;

/**
 * @param {string | null | undefined} value
 * @returns {string} `value` with runs of whitespace collapsed to one space and
 *   the ends trimmed.
 */
function collapse(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} value
 * @returns {string | null} `value`, or null when it is empty after trimming.
 */
function orNull(value) {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * @param {Element | null} element
 * @returns {string | null} the `datetime` of the first descendant
 *   `relative-time`, or of `element` itself.
 */
function datetimeOf(element) {
  if (element === null) return null;
  const time = element.matches('relative-time')
    ? element
    : element.querySelector('relative-time[datetime]');
  return time === null ? null : orNull(time.getAttribute('datetime') ?? '');
}

/**
 * @param {string | null | undefined} href
 * @returns {string | null} the login a `/{login}` href names.
 */
function loginFromHref(href) {
  const match = /^\/([^/?#]+)\/?$/.exec(String(href ?? ''));
  return match === null ? null : decodeURIComponent(match[1] ?? '');
}

/**
 * @param {Element} scope
 * @returns {string | null} the login of the first `a.author` in `scope`.
 */
function authorIn(scope) {
  const link = scope.querySelector('a.author');
  if (link === null) return null;
  return loginFromHref(link.getAttribute('href')) ?? orNull(collapse(link.textContent));
}

/**
 * The source value of one advisory metadata form field. A `select` reads from
 * the option the server marked selected, which is the stored value whether or
 * not the maintainer has since touched the control.
 *
 * @param {Document} root
 * @param {string} name The field name inside `repository_advisory[...]`.
 * @returns {string | null}
 */
function metadataField(root, name) {
  const field = root.querySelector(`[name="repository_advisory[${name}]"]`);
  if (field === null) return null;
  if (field.tagName === 'SELECT') {
    const selected = field.querySelector('option[selected]');
    return selected === null ? null : orNull(selected.getAttribute('value') ?? '');
  }
  if (field.tagName === 'TEXTAREA') return orNull(field.textContent ?? '');
  return orNull(field.getAttribute('value') ?? '');
}

/**
 * @typedef {object} AdvisoryRef
 * @property {string} owner
 * @property {string} repo
 * @property {string} ghsaId
 */

/**
 * The advisory this document belongs to, read from the live region partials
 * every detail page carries.
 *
 * @param {Document} root
 * @returns {AdvisoryRef | null}
 */
function parseRef(root) {
  for (const region of root.querySelectorAll('div.js-socket-channel[data-url]')) {
    const url = region.getAttribute('data-url') ?? '';
    const match = /\/([^/]+)\/([^/]+)\/security\/advisories\/([^/?#]+)\//.exec(url);
    if (match !== null) {
      return {
        owner: /** @type {string} */ (match[1]),
        repo: /** @type {string} */ (match[2]),
        ghsaId: /** @type {string} */ (match[3]),
      };
    }
  }
  return null;
}

/**
 * @typedef {object} SnapshotReport
 * @property {string} raw The JSON source recovered from the fenced block.
 * @property {unknown} parsed The parsed payload, or null when it did not parse.
 * @property {string | null} version The `betterGhsa` schema version.
 * @property {number | null} major The schema major, when `version` is a version.
 * @property {boolean} schemaSupported Whether this reader interprets that major.
 * @property {number | null} seq The ordering claim.
 * @property {string | null} by The login the snapshot names as its writer.
 * @property {boolean} ordered Whether the envelope carries an ordering claim.
 * @property {boolean} valid Whether the payload passed validation.
 * @property {string[]} problems Why the snapshot is not usable, in display order.
 * @property {string[]} unrecognized Known enum fields holding a value this
 *   reader does not interpret. Their values are displayed raw and carried
 *   forward.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} key
 * @param {string[]} problems
 * @returns {void}
 */
function requireStringArray(payload, key, problems) {
  const value = payload[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    problems.push(`${key} is not an array of strings`);
  }
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} key
 * @param {string[]} problems
 * @param {string} [prefix] The path to `payload` within the snapshot.
 * @returns {void}
 */
function requireString(payload, key, problems, prefix) {
  const value = payload[key];
  if (value === undefined) return;
  if (typeof value !== 'string') {
    problems.push(`${prefix === undefined ? '' : `${prefix}.`}${key} is not a string`);
  }
}

/**
 * Checks the type of every field this reader knows. Unknown fields pass, and so
 * does an unrecognized value in a known enum field.
 *
 * @param {Record<string, unknown>} payload
 * @returns {{ problems: string[], unrecognized: string[] }}
 */
function validateSnapshot(payload) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const unrecognized = [];

  if (typeof payload['betterGhsa'] !== 'string') problems.push('betterGhsa is not a string');
  for (const key of ['by', 'at', 'triage', 'triageSince']) requireString(payload, key, problems);
  for (const key of ['owners', 'backports']) requireStringArray(payload, key, problems);

  const triage = payload['triage'];
  if (typeof triage === 'string' && !TRIAGE_VALUES.includes(triage)) unrecognized.push('triage');

  const confirmed = payload['confirmed'];
  if (confirmed !== undefined) {
    if (!isPlainObject(confirmed)) {
      problems.push('confirmed is not an object');
    } else {
      for (const [track, record] of Object.entries(confirmed)) {
        if (!isPlainObject(record)) {
          problems.push(`confirmed.${track} is not an object`);
          continue;
        }
        for (const key of ['by', 'at', 'fp']) {
          requireString(record, key, problems, `confirmed.${track}`);
        }
      }
    }
  }

  const embargo = payload['embargo'];
  if (embargo !== undefined) {
    if (!isPlainObject(embargo)) problems.push('embargo is not an object');
    else requireString(embargo, 'lift', problems, 'embargo');
  }

  const closure = payload['closure'];
  if (closure !== undefined) {
    if (!isPlainObject(closure)) {
      problems.push('closure is not an object');
    } else {
      for (const key of ['reason', 'duplicateOf']) {
        requireString(closure, key, problems, 'closure');
      }
      const reason = closure['reason'];
      if (typeof reason === 'string' && !CLOSURE_REASONS.includes(reason)) {
        unrecognized.push('closure.reason');
      }
    }
  }

  return { problems, unrecognized };
}

/**
 * Reads the snapshot a state comment carries. The envelope, `seq` and `by`, is
 * read independently of the payload, so ordering holds for a snapshot whose
 * payload is invalid.
 *
 * @param {string} raw The JSON source from the fenced block.
 * @returns {SnapshotReport}
 */
function readSnapshot(raw) {
  /** @type {SnapshotReport} */
  const report = {
    raw,
    parsed: null,
    version: null,
    major: null,
    schemaSupported: false,
    seq: null,
    by: null,
    ordered: false,
    valid: false,
    problems: [],
    unrecognized: [],
  };

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    report.problems.push('the fenced block does not parse as JSON');
    return report;
  }
  if (!isPlainObject(parsed)) {
    report.problems.push('the fenced block is not a JSON object');
    return report;
  }
  report.parsed = parsed;

  const version = parsed['betterGhsa'];
  if (typeof version === 'string') {
    report.version = version;
    const major = /^(\d+)\./.exec(version);
    if (major !== null) report.major = Number(major[1]);
  }
  report.schemaSupported = report.major === SCHEMA_MAJOR;

  const seq = parsed['seq'];
  if (typeof seq === 'number' && Number.isFinite(seq)) {
    report.seq = seq;
    report.ordered = true;
  } else {
    report.problems.push('seq is absent or is not a number');
  }

  const by = parsed['by'];
  if (typeof by === 'string') report.by = by;

  const checked = validateSnapshot(parsed);
  report.unrecognized = checked.unrecognized;
  report.problems.push(...checked.problems);
  report.valid = report.ordered && checked.problems.length === 0;

  return report;
}

/**
 * The state comment a rendered comment body holds, if it holds one. A comment
 * qualifies when it carries a JSON fence and either the parsed JSON has the
 * `betterGhsa` key or the body carries the fixed summary text.
 *
 * @param {Element | null} body The rendered comment body.
 * @returns {SnapshotReport | null}
 */
function parseStateComment(body) {
  if (body === null) return null;
  const highlight = body.querySelector('.highlight-source-json');
  if (highlight === null) return null;
  const fence = highlight.matches('pre') ? highlight : highlight.querySelector('pre');
  const raw = fence === null ? '' : (fence.textContent ?? '');

  const labelled = Array.from(body.querySelectorAll('summary')).some(
    (summary) => collapse(summary.textContent) === STATE_COMMENT_SUMMARY
  );
  const report = readSnapshot(raw);
  const claimed = isPlainObject(report.parsed) && 'betterGhsa' in report.parsed;
  if (!claimed && !labelled) return null;
  return report;
}

/**
 * @typedef {object} ParsedComment
 * @property {string} id The numeric comment id.
 * @property {string} elementId The `advisory-comment-{id}` element id.
 * @property {string | null} author
 * @property {string | null} role The one role this comment's author carries,
 *   resolved once per comment identifier.
 * @property {string[]} roles Every distinct badge on the comment.
 * @property {boolean} trusted Whether this author's snapshots count.
 * @property {string | null} at
 * @property {string} text The rendered body, whitespace collapsed.
 * @property {SnapshotReport | null} stateComment
 */

/**
 * Every advisory comment in the thread. Role badges repeat across the
 * responsive duplicates and across the minimized and unminimized container
 * shapes, so roles are collected per comment identifier and deduplicated.
 *
 * @param {Document} root
 * @returns {ParsedComment[]}
 */
function parseComments(root) {
  const trust = globalThis.bghsa.trust;
  /** @type {ParsedComment[]} */
  const comments = [];

  for (const group of root.querySelectorAll('div.timeline-comment-group[id^="advisory-comment-"]')) {
    const elementId = group.id;
    const id = elementId.slice('advisory-comment-'.length);

    /** @type {string[]} */
    const roles = [];
    for (const badge of group.querySelectorAll('span.Label')) {
      if (badge.closest('.comment-body') !== null) continue;
      const text = collapse(badge.textContent);
      if (text !== '' && !roles.includes(text)) roles.push(text);
    }
    const role = trust.ROLES.find((known) => roles.includes(known)) ?? roles[0] ?? null;

    const author = authorIn(group);
    const body =
      group.querySelector('div.comment-body.markdown-body.js-comment-body') ??
      group.querySelector('div.comment-body.markdown-body:not(.js-preview-body)');

    comments.push({
      id,
      elementId,
      author,
      role,
      roles,
      trusted: trust.isTrustedAuthor(author, role),
      at: datetimeOf(group.querySelector(`a[id="${elementId}-permalink"]`)),
      text: collapse(body === null ? '' : body.textContent),
      stateComment: parseStateComment(body),
    });
  }

  return comments;
}

/**
 * @typedef {object} TimelineEvent
 * @property {string | null} id
 * @property {string | null} actor
 * @property {string | null} at
 * @property {string} text
 */

/**
 * The advisory's timeline. Comment groups carry `TimelineItem-body` themselves
 * and are excluded here; they are read as comments.
 *
 * @param {Document} root
 * @returns {TimelineEvent[]}
 */
function parseTimeline(root) {
  /** @type {TimelineEvent[]} */
  const events = [];
  for (const item of root.querySelectorAll('div.TimelineItem-body')) {
    if (item.classList.contains('timeline-comment-group')) continue;
    events.push({
      id: orNull(item.parentElement?.id ?? ''),
      actor: authorIn(item),
      at: datetimeOf(item),
      text: collapse(item.textContent),
    });
  }
  return events;
}

/**
 * @typedef {object} ForkPullRequest
 * @property {number | null} number
 * @property {string | null} url
 * @property {string} title
 * @property {string | null} state `open`, the one state a fork row is drawn in,
 *   or null where the row named no state this reader places.
 * @property {string | null} baseRef The branch in the advisory's repository.
 * @property {string | null} headRef The branch in the private fork.
 * @property {string | null} author
 * @property {string | null} openedAt
 * @property {string[]} assignees
 */

/**
 * @param {Element} ref A `span.commit-ref`.
 * @returns {string | null} the branch name, which is the last truncation target.
 */
function refBranch(ref) {
  const parts = ref.querySelectorAll('span.css-truncate-target');
  const last = parts[parts.length - 1];
  return last === undefined ? null : orNull(collapse(last.textContent));
}

/**
 * @param {Element} row An `li.Box-row` in the private fork's pull request list.
 * @returns {ForkPullRequest | null}
 */
function parseForkRow(row) {
  const link = row.querySelector('a.h4.Link--primary');
  if (link === null) return null;
  const url = orNull(link.getAttribute('href') ?? '');
  const number = /\/pull\/(\d+)\/?$/.exec(url ?? '');

  const icon = row.querySelector('span[aria-label][class*="color-fg-"]');
  const colors = icon === null ? [] : Array.from(icon.classList);
  const aria = collapse(icon?.getAttribute('aria-label') ?? '').toLowerCase();
  const state = colors.includes(OPEN_PULL_COLOR) || OPEN_PULL_LABEL.test(aria) ? 'open' : null;

  const base = row.querySelector('span.commit-ref.base-ref');
  const head = row.querySelector('span.commit-ref.head-ref');
  const author = row.querySelector('a.Link--muted');
  const stack = row.querySelector('div.AvatarStack [aria-label], div.AvatarStack[aria-label]');
  const assigned = collapse(stack?.getAttribute('aria-label') ?? '').replace(/^Assigned to\s*/i, '');

  return {
    number: number === null ? null : Number(number[1]),
    url,
    title: collapse(link.textContent),
    state,
    baseRef: base === null ? null : refBranch(base),
    headRef: head === null ? null : refBranch(head),
    author: author === null ? null : (loginFromHref(author.getAttribute('href')) ?? orNull(collapse(author.textContent))),
    openedAt: datetimeOf(row),
    assignees: assigned === '' ? [] : assigned.split(/\s*,\s*/).filter((name) => name !== ''),
  };
}

/**
 * @typedef {object} PrivateFork
 * @property {string | null} cloneUrl
 * @property {string | null} repository The fork as `owner/repo`.
 * @property {string | null} deleteUrl
 * @property {ForkPullRequest[]} pullRequests
 */

/**
 * @param {Document} root
 * @returns {PrivateFork | null} null when the advisory has no private fork.
 */
function parseFork(root) {
  const box = root.querySelector('private-forks-git-clone-help');
  if (box === null) return null;

  const clone = box.querySelector('input#empty-setup-clone-url');
  const repoLink = Array.from(box.querySelectorAll('a[href]')).find((link) =>
    /^\/[^/?#]+\/[^/?#]+$/.test(link.getAttribute('href') ?? '')
  );
  const deleteForm = Array.from(box.querySelectorAll('form[action]')).find((form) =>
    (form.getAttribute('action') ?? '').endsWith('/delete_workspace')
  );

  /** @type {ForkPullRequest[]} */
  const pullRequests = [];
  for (const row of box.querySelectorAll('li.Box-row')) {
    const parsed = parseForkRow(row);
    if (parsed !== null) pullRequests.push(parsed);
  }

  return {
    cloneUrl: clone === null ? null : orNull(clone.getAttribute('value') ?? ''),
    repository: repoLink === undefined ? null : (repoLink.getAttribute('href') ?? '').slice(1),
    deleteUrl: deleteForm === undefined ? null : deleteForm.getAttribute('action'),
    pullRequests,
  };
}

/**
 * @typedef {object} DescriptionRevision
 * @property {string} summary The revision control's summary text.
 * @property {string | null} historyUrl The edit history log partial.
 */

/**
 * @typedef {object} ParsedDetail
 * @property {AdvisoryRef | null} ref
 * @property {string | null} ghsaId
 * @property {string | null} state `Triage`, `Draft`, `Published`, or `Closed`.
 * @property {string | null} severity The severity, lowercased, or null when unset.
 * @property {string | null} severityLabel The severity as displayed.
 * @property {string | null} reportedAt The time the report was opened, from the
 *   description Box header.
 * @property {string | null} reporter The login the description Box header names.
 * @property {string | null} title Source markdown from the metadata form.
 * @property {string | null} description Source markdown from the metadata form.
 * @property {string | null} severityField The stored severity selection, which
 *   is `cvss_v3` or `cvss_v4` when the severity comes from a vector.
 * @property {string | null} cvssV3
 * @property {string | null} cveId
 * @property {string | null} cveSelection `requesting`, `existing`, or `not_applicable`.
 * @property {boolean | null} descriptionOriginal Whether the description on the
 *   page is the reporter's original text, and null when the revision control
 *   could not be located.
 * @property {DescriptionRevision | null} descriptionRevision
 * @property {ParsedComment[]} comments
 * @property {TimelineEvent[]} timeline
 * @property {PrivateFork | null} fork
 * @property {string[]} collaborators
 */

/**
 * Everything the panel reads from an advisory detail page.
 *
 * @param {Document} root
 * @returns {ParsedDetail | null} null when the document is not a detail page.
 */
function parseDetail(root) {
  const meta = root.querySelector('.gh-header-meta');
  if (meta === null) return null;

  const state = meta.querySelector('.State');
  const severity = meta.querySelector('.Label--large');
  const ghsa = meta.querySelector('span.user-select-contain');
  const severityTitle = /Severity:\s*(\S+)/.exec(severity?.getAttribute('title') ?? '');

  // Several regions carry `js-repository-advisory-details`. The description's
  // is the one whose own child is a comment-style Box header. That header names
  // the reporter and the report time in every advisory state; the page header
  // meta names the publisher and the publication time once published.
  const descriptionHeader = root.querySelector(
    'div.js-repository-advisory-details > div.Box-header.timeline-comment-header'
  );
  const descriptionBox = descriptionHeader?.closest('div.Box') ?? null;
  const history = descriptionBox?.querySelector('span.js-comment-edit-history') ?? null;
  const revision = history?.querySelector('details') ?? null;

  /** @type {string[]} */
  const collaborators = [];
  for (const form of root.querySelectorAll('form.js-remove-repository-advisory-collaborator')) {
    const member = form.querySelector('[name="member"]');
    const login = member === null ? null : orNull(member.getAttribute('value') ?? '');
    if (login !== null && !collaborators.includes(login)) collaborators.push(login);
  }

  return {
    ref: parseRef(root),
    ghsaId: ghsa === null ? null : orNull(collapse(ghsa.textContent)),
    state: state === null ? null : orNull(collapse(state.textContent)),
    severity:
      severityTitle !== null
        ? /** @type {string} */ (severityTitle[1]).toLowerCase()
        : severity === null
          ? null
          : orNull(collapse(severity.textContent).toLowerCase()),
    severityLabel: severity === null ? null : orNull(collapse(severity.textContent)),
    reportedAt: datetimeOf(descriptionHeader),
    reporter: descriptionHeader === null ? null : authorIn(descriptionHeader),
    title: metadataField(root, 'title'),
    description: metadataField(root, 'description'),
    severityField: metadataField(root, 'severity'),
    cvssV3: metadataField(root, 'cvss_v3'),
    cveId: metadataField(root, 'cve_id'),
    cveSelection: metadataField(root, 'cve_selection'),
    descriptionOriginal: history === null ? null : revision === null,
    descriptionRevision:
      revision === null
        ? null
        : {
            summary: collapse(revision.querySelector('summary')?.textContent),
            historyUrl: revision.querySelector('details-menu')?.getAttribute('src') ?? null,
          },
    comments: parseComments(root),
    timeline: parseTimeline(root),
    fork: parseFork(root),
    collaborators,
  };
}

globalThis.bghsa.parseDetail = {
  SCHEMA_MAJOR,
  STATE_COMMENT_SUMMARY,
  TRIAGE_VALUES,
  CLOSURE_REASONS,
  parseDetail,
  parseComments,
  parseTimeline,
  parseFork,
  parseStateComment,
  readSnapshot,
};

if (typeof module !== 'undefined') {
  module.exports = globalThis.bghsa.parseDetail;
}
