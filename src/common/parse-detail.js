'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./text.js');
  require('./trust.js');
  require('./schema.js');
}

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

/** How every reader here squares up the text a page carries. */
const collapse = globalThis.bghsa.text.collapse;

/** How every reader here reads an empty value as nothing. */
const orNull = globalThis.bghsa.text.orNull;

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
 * @returns {string | null} the login a `/{login}` href names. A percent escape
 *   that does not decode names no login.
 */
function loginFromHref(href) {
  const match = /^\/([^/?#]+)\/?$/.exec(String(href ?? ''));
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1] ?? '');
  } catch {
    return null;
  }
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
 * Whether `form` is the one that posts a new comment on the advisory.
 *
 * @param {Element} form
 * @returns {boolean}
 */
function isCommentForm(form) {
  const action = form.getAttribute('action') ?? '';
  const path = action.split('#')[0]?.split('?')[0] ?? '';
  return path.endsWith('/comments');
}

/**
 * The login of the account this page was rendered for.
 *
 * An advisory page names the signed-in account in one place: the avatar on the
 * box that composes a new comment, `div.timeline-new-comment`. Every other
 * login on the page belongs to a comment author, a timeline actor, or a
 * collaborator, and none of those says who is reading. The write path needs
 * this login to find that maintainer's own state comment and to stamp `by`.
 *
 * The box has to hold the form that posts a comment on this advisory, so the
 * login read here is the one that would author a comment written from this
 * page. A page carrying no such box reads as null.
 *
 * The anchor's href and the avatar's `alt` name the login twice, and both have
 * to name it and agree. A box naming it once is a box this does not read. A
 * login this cannot read is null, and a write with no login in hand is
 * refused: writing under the wrong identity edits another maintainer's
 * comment.
 *
 * @param {Document} root
 * @returns {string | null}
 */
function parseViewer(root) {
  const boxes = root.querySelectorAll('div.timeline-new-comment');
  // Two boxes name no one box, and the page carries one.
  if (boxes.length !== 1) return null;
  const box = boxes[0];
  if (box === undefined) return null;
  if (!Array.from(box.querySelectorAll('form[action]')).some(isCommentForm)) return null;

  const links = box.querySelectorAll('span.timeline-comment-avatar a[href]');
  if (links.length !== 1) return null;
  const link = links[0];
  if (link === undefined) return null;
  const login = loginFromHref(link.getAttribute('href'));
  if (login === null) return null;

  const image = link.querySelector('img[alt]');
  if (image === null) return null;
  if (collapse(image.getAttribute('alt')) !== `@${login}`) return null;
  return login;
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
 * The state comment a rendered comment body holds, if it holds one.
 *
 * The marker in a code span says so, whatever the summary reads and whatever
 * state the fence is in, so a fence that does not parse is read and carried to
 * the merge, which warns on it by name. A marker inside the fence is text in a
 * code block and says nothing.
 *
 * A body carrying no marker qualifies where its fence parses to an object
 * naming `betterGhsa`. State comments written before the marker existed are
 * recognized on that path alone, and one of those whose fence does not parse
 * is not recognized at all.
 *
 * @param {Element | null} body The rendered comment body.
 * @returns {import('./schema.js').SnapshotReport | null}
 */
function parseStateComment(body) {
  const schema = globalThis.bghsa.schema;
  if (body === null) return null;

  const marked = Array.from(body.querySelectorAll('code')).some(
    (span) =>
      span.closest('pre') === null &&
      collapse(span.textContent).includes(schema.STATE_COMMENT_MARKER)
  );

  const highlight = body.querySelector('.highlight-source-json');
  const fence =
    highlight === null ? null : highlight.matches('pre') ? highlight : highlight.querySelector('pre');
  const raw = fence === null ? '' : (fence.textContent ?? '');

  const report = schema.readSnapshot(raw);
  const claimed = schema.isPlainObject(report.parsed) && 'betterGhsa' in report.parsed;
  if (!marked && !claimed) return null;
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
 * @property {import('./schema.js').SnapshotReport | null} stateComment
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
 * @property {string | null} viewer The login this page was rendered for.
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
    viewer: parseViewer(root),
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
  parseDetail,
  parseComments,
  parseTimeline,
  parseFork,
  parseViewer,
  parseStateComment,
};

if (typeof module !== 'undefined') {
  module.exports = globalThis.bghsa.parseDetail;
}
