'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

/**
 * @typedef {object} ListRow
 * @property {string | null} ghsaId
 * @property {string | null} owner
 * @property {string | null} repo
 * @property {string | null} href The advisory's path on github.com.
 * @property {string | null} title
 * @property {string | null} state `Triage`, `Draft`, `Published`, or `Closed`.
 * @property {string | null} severity The severity, lowercased, and null where
 *   the advisory sets none.
 * @property {string | null} severityLabel The severity as displayed.
 * @property {string | null} openedAt The time the report was opened.
 * @property {string | null} reporter The login the row names as opening it.
 */

/**
 * @typedef {object} StateTab
 * @property {string} state The `?state=` value the tab links to.
 * @property {string | null} label The state as displayed.
 * @property {number | null} count The advisories in that state, and null where
 *   the tab's text does not open with a number.
 * @property {string} href
 * @property {boolean} selected Whether the page is showing this tab.
 */

/**
 * @typedef {object} NextPage
 * @property {string} href
 * @property {number | null} page The `?page=` the link walks to.
 */

/**
 * @typedef {object} ParsedList
 * @property {string | null} owner
 * @property {string | null} repo
 * @property {ListRow[]} rows
 * @property {StateTab[]} tabs
 * @property {string | null} selectedState The `?state=` the page is showing.
 * @property {NextPage | null} next
 * @property {number | null} openCount The advisories in the open states, and
 *   null where either tab's count went unread.
 */

(() => {
  /**
   * The advisory states GitHub's list page offers, as the `?state=` value and as
   * the name it displays. The four tabs are mutually exclusive, so the open set
   * is the union of `triage` and `draft`.
   *
   * @type {Readonly<Record<string, string>>}
   */
  const STATES = {
    triage: 'Triage',
    draft: 'Draft',
    published: 'Published',
    closed: 'Closed',
  };

  /** The states whose advisories the list table holds. */
  const OPEN_STATES = ['triage', 'draft'];

  /** An advisory link on a list row, as `/{owner}/{repo}/security/advisories/{ghsa}`. */
  const ADVISORY_HREF = /^\/([^/?#]+)\/([^/?#]+)\/security\/advisories\/(GHSA-[^/?#]+)$/;

  /** A state tab link, as `/{owner}/{repo}/security/advisories?state={state}`. */
  const LIST_HREF = /^\/([^/?#]+)\/([^/?#]+)\/security\/advisories(?:[?#]|$)/;

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
   * @param {string} href
   * @param {string} name
   * @returns {string | null} the value of one query parameter of `href`.
   */
  function param(href, name) {
    const query = href.split('#')[0]?.split('?')[1] ?? '';
    for (const pair of query.split('&')) {
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      if (key !== name) continue;
      const value = eq === -1 ? '' : pair.slice(eq + 1);
      try {
        return orNull(decodeURIComponent(value.replace(/\+/g, ' ')));
      } catch {
        return orNull(value);
      }
    }
    return null;
  }

  /**
   * @param {string} name
   * @returns {string | null} the state `name` says, as the `?state=` value, and
   *   null for a name that is not one of GitHub's four.
   */
  function stateKey(name) {
    const wanted = name.trim().toLowerCase();
    return Object.hasOwn(STATES, wanted) ? wanted : null;
  }

  /**
   * The state a row's tooltip names. The tooltip reads `{State} advisory`, and it
   * is the one state signal every row carries: a row whose advisory holds no
   * severity and no state Label still carries it.
   *
   * @param {Element} row
   * @returns {string | null} the state as GitHub displays it.
   */
  function rowStateFromTooltip(row) {
    for (const tip of row.querySelectorAll('span.tooltipped[aria-label]')) {
      const match = /^(\S+)\s+advisory$/i.exec(collapse(tip.getAttribute('aria-label')));
      if (match === null) continue;
      const key = stateKey(/** @type {string} */ (match[1]));
      if (key !== null) return /** @type {string} */ (STATES[key]);
    }
    return null;
  }

  /**
   * The state Label a row carries beside its severity, where it carries one. A
   * `triage` row holds `Triage` in a `Label--secondary`; a `draft` row holds no
   * Label at all.
   *
   * @param {Element} row
   * @returns {Element | null}
   */
  function stateLabelOf(row) {
    for (const label of row.querySelectorAll('span.Label')) {
      if (stateKey(collapse(label.textContent)) !== null) return label;
    }
    return null;
  }

  /**
   * The severity a row shows, and null where the advisory sets none.
   *
   * The row's `title` is what names the level. The modifier class does not: the
   * state Label and the severity Label are both `span.Label`, the state Label
   * comes first, and it takes `Label--secondary`, which is also a severity color.
   * So the title is read first, and a Label that is not the state Label stands in
   * where no title names a severity.
   *
   * @param {Element} row
   * @returns {{ severity: string | null, severityLabel: string | null }}
   */
  function severityOf(row) {
    const labels = Array.from(row.querySelectorAll('span.Label'));
    for (const label of labels) {
      const match = /Severity:\s*(\S+)/.exec(collapse(label.getAttribute('title')));
      if (match === null) continue;
      return {
        severity: /** @type {string} */ (match[1]).toLowerCase(),
        severityLabel: orNull(collapse(label.textContent)),
      };
    }
    const state = stateLabelOf(row);
    for (const label of labels) {
      if (label === state) continue;
      const text = orNull(collapse(label.textContent));
      if (text === null) continue;
      return { severity: text.toLowerCase(), severityLabel: text };
    }
    return { severity: null, severityLabel: null };
  }

  /**
   * One advisory as the list page renders it. Everything here is read from the
   * row, so the table paints these values with no advisory fetched.
   *
   * @param {Element} row A `div.Box-row--drag-hide`.
   * @returns {ListRow | null} null for a row carrying no advisory link.
   */
  function parseRow(row) {
    const link = row.querySelector('a.Link--primary[href*="/security/advisories/GHSA-"]');
    if (link === null) return null;
    const href = orNull(link.getAttribute('href') ?? '');
    const match = href === null ? null : ADVISORY_HREF.exec(href.split('?')[0] ?? '');

    const opened = row.querySelector('span.opened-by');
    const time = opened?.querySelector('relative-time[datetime]') ?? null;
    const author = opened?.querySelector('a.author') ?? null;
    const authorHref = /^\/([^/?#]+)\/?$/.exec(author?.getAttribute('href') ?? '');

    const severity = severityOf(row);

    return {
      ghsaId: match === null ? null : /** @type {string} */ (match[3]),
      owner: match === null ? null : /** @type {string} */ (match[1]),
      repo: match === null ? null : /** @type {string} */ (match[2]),
      href,
      title: orNull(collapse(link.textContent)),
      state: rowStateFromTooltip(row),
      severity: severity.severity,
      severityLabel: severity.severityLabel,
      openedAt: time === null ? null : orNull(time.getAttribute('datetime') ?? ''),
      reporter:
        authorHref !== null
          ? /** @type {string} */ (authorHref[1])
          : author === null
            ? null
            : orNull(collapse(author.textContent)),
    };
  }

  /**
   * The four state tabs, with the count each carries. The counts give the corpus
   * size before anything is crawled.
   *
   * @param {ParentNode} scope
   * @returns {StateTab[]} in the order the page lists them.
   */
  function parseTabs(scope) {
    /** @type {StateTab[]} */
    const tabs = [];
    for (const link of scope.querySelectorAll('segmented-control a[href]')) {
      const href = link.getAttribute('href') ?? '';
      const state = param(href, 'state');
      if (state === null || stateKey(state) === null) continue;
      const text = collapse(link.textContent);
      const match = /^([\d,]+)\s+(\S+)$/.exec(text);
      const item = link.closest('li');
      tabs.push({
        state: state.toLowerCase(),
        label: match === null ? orNull(text) : /** @type {string} */ (match[2]),
        count: match === null ? null : Number(/** @type {string} */ (match[1]).replace(/,/g, '')),
        href,
        selected:
          link.getAttribute('aria-current') === 'true' ||
          (item !== null && item.classList.contains('SegmentedControl-item--selected')),
      });
    }
    return tabs;
  }

  /**
   * The link to the next page of the current state, and null on the last page.
   *
   * GitHub marks both the numbered link for the next page and the `Next` button
   * `rel="next"`, so more than one anchor matches and the first is taken.
   *
   * @param {ParentNode} scope
   * @returns {NextPage | null}
   */
  function parseNext(scope) {
    const link = scope.querySelector('a[rel="next"][href]');
    if (link === null) return null;
    const href = orNull(link.getAttribute('href') ?? '');
    if (href === null) return null;
    const page = param(href, 'page');
    return { href, page: page !== null && /^\d+$/.test(page) ? Number(page) : null };
  }

  /**
   * Everything the list table reads from one page of the advisory list.
   *
   * @param {Document | Element} root
   * @returns {ParsedList | null} null when the document carries no advisory list.
   */
  function parseList(root) {
    const self = 'matches' in root && root.matches('#advisories') ? root : null;
    const container = self ?? root.querySelector('#advisories');
    if (container === null) return null;

    /** @type {ListRow[]} */
    const rows = [];
    for (const element of container.querySelectorAll('div.Box-row--drag-hide')) {
      const row = parseRow(element);
      if (row !== null) rows.push(row);
    }

    const tabs = parseTabs(container);
    const selected = tabs.find((tab) => tab.selected);

    let owner = null;
    let repo = null;
    for (const tab of tabs) {
      const match = LIST_HREF.exec(tab.href);
      if (match === null) continue;
      owner = /** @type {string} */ (match[1]);
      repo = /** @type {string} */ (match[2]);
      break;
    }
    if (owner === null) {
      const row = rows.find((entry) => entry.owner !== null);
      if (row !== undefined) {
        owner = row.owner;
        repo = row.repo;
      }
    }

    /** @type {number | null} */
    let openCount = 0;
    for (const state of OPEN_STATES) {
      const count = tabs.find((tab) => tab.state === state)?.count ?? null;
      if (count === null || openCount === null) openCount = null;
      else openCount += count;
    }

    return {
      owner,
      repo,
      rows,
      tabs,
      selectedState: selected === undefined ? null : selected.state,
      next: parseNext(container),
      openCount,
    };
  }

  const exported = {
    STATES,
    OPEN_STATES,
    parseList,
    parseRow,
  };

  globalThis.bghsa.parseList = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
