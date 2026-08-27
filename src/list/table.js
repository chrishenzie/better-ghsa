'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/dom.js');
  require('../common/trust.js');
  require('../common/schema.js');
  require('../common/merge.js');
  require('../common/parse-list.js');
  require('../common/derive.js');
  require('../common/order.js');
  require('../common/cache.js');
  require('../common/fetch.js');
  require('../common/crawl.js');
  require('../detail/tracking.js');
}

/**
 * One chip on a row. A tone names a Primer state token, and a chip with no tone
 * is dimmed.
 *
 * @typedef {object} ChipSpec
 * @property {string} text
 * @property {'attention' | 'danger'} [tone]
 */

/**
 * One row of the table: what the list markup said, and what the cached read of
 * the advisory adds to it. Every field the default order sorts on is here, so a
 * row is an `OrderEntry` as it stands.
 *
 * @typedef {object} TableRow
 * @property {string | null} ghsaId
 * @property {string | null} href The advisory's path on github.com.
 * @property {string | null} title
 * @property {string | null} state `Triage` or `Draft`, as GitHub names it.
 * @property {string | null} severity The severity, lowercased.
 * @property {string | null} severityLabel The severity as displayed.
 * @property {boolean} severityConfirmed Whether a maintainer confirmed the
 *   scoring the severity comes from.
 * @property {string | null} openedAt
 * @property {string | null} reporter
 * @property {string[]} owners The logins a maintainer put on the advisory.
 * @property {number} observedAt When this row's data was read, epoch
 *   milliseconds. A row no advisory read backs carries the moment the list
 *   markup was read.
 * @property {boolean} read Whether a cached advisory read backs this row. The
 *   chips that stand for read state are absent while this is false, because
 *   nothing has been read to say they hold.
 * @property {boolean} neverReviewed
 * @property {boolean} newActivity
 * @property {string | null} triage
 * @property {string | null} waitingSince
 * @property {boolean} embargo Whether an embargo applies.
 * @property {string | null} embargoLift
 * @property {boolean} embargoOverdue
 * @property {string | null} patch The furthest state the private fork's pull
 *   requests reached, and null where there is nothing to say.
 * @property {number} backportTargets How many branches a maintainer asked for.
 * @property {number} backportsDone How many of them carry a merged pull request.
 * @property {boolean} textConfirmed Whether a maintainer confirmed both the
 *   advisory title and the advisory description.
 * @property {string | null} cve What the CVE chip reads, and null where the
 *   advisory has no CVE state to show.
 * @property {import('../common/derive.js').CveState['state'] | null} cveState
 *   Which CVE state the advisory is in, and null while nothing has been read.
 *   The chip carries the identifier once one is assigned, so the state is held
 *   beside it for the control that filters on it.
 */

/**
 * One value the table holds about an advisory, as the controls read it.
 *
 * @typedef {object} Facet
 * @property {string} key What the control stores.
 * @property {string} label What the filter control reads while it is holding the
 *   table to nothing.
 * @property {string} [sortLabel] What the sort control reads for this facet,
 *   where the label on its own would not say which way the rows go.
 * @property {boolean} [filter] Whether the facet enumerates, so a filter can
 *   offer its values. A facet over a time or a title does not.
 * @property {readonly string[]} [values] The order its values belong in, for the
 *   ones this reader knows. Anything else follows them alphabetically.
 * @property {(row: TableRow) => string[]} valuesOf What this row holds for the
 *   facet. Empty where it holds nothing, which a read can still fill in.
 * @property {(a: TableRow, b: TableRow) => number} compare
 */

/**
 * The view a maintainer chose over the rows the table holds.
 *
 * @typedef {object} ViewState
 * @property {string} sort A facet key, or the key of the default order.
 * @property {Record<string, string>} filters What each filter is holding the
 *   table to, by facet key. A facet with no entry is holding it to nothing.
 */

/**
 * One advisory as a list page showed it, and when that page was read.
 *
 * @typedef {object} RowSource
 * @property {import('../common/parse-list.js').ListRow} row
 * @property {number} seenAt When the markup this row came from was read, epoch
 *   milliseconds. The page being looked at was read now; a row that is on the
 *   table from the crawl alone was read when the walk that found it ran, which
 *   can be days ago.
 */

/**
 * The table as one render assembled it.
 *
 * @typedef {object} TableView
 * @property {TableRow[]} rows In the default order.
 * @property {number} at The moment the render read the page, epoch milliseconds.
 * @property {Map<string, RowSource>} sources What the list markup said about each
 *   advisory and when it said it, by GHSA identifier. A read landing later
 *   rebuilds its row from this and the entry that arrived, so a row is replaced
 *   where it stands and the rest of the table is left alone.
 */

/**
 * @typedef {object} RefreshOptions
 * @property {import('../common/cache.js').CacheStorage | null} [storage]
 * @property {() => number} [now]
 * @property {(ms: number) => Promise<void>} [wait]
 * @property {import('../common/write.js').WriteFetch} [fetch]
 * @property {import('../common/parse-list.js').ParsedList} [parsed] The page as
 *   it was read, and absent to read it here.
 * @property {string} [href] The URL of the page being looked at, which is what
 *   says whether it is the first page of its state.
 */

/**
 * What one refresh of the table did.
 *
 * @typedef {object} RefreshSummary
 * @property {import('../common/crawl.js').CrawlResult} crawled
 * @property {import('../common/fetch.js').QueueSummary} read
 */

/**
 * @typedef {object} ViewOptions
 * @property {import('../common/cache.js').CacheStorage | null} [storage]
 * @property {number} [at] The moment the list markup was read, epoch
 *   milliseconds.
 */

(() => {
  /** The id of the sentinel element the extension owns. */
  const ROOT_ID = 'bghsa-list';

  /**
   * The id of the list surface's stylesheet. The detail panel carries a
   * stylesheet of its own under another id, so neither surface can be left
   * holding the other's rules.
   */
  const STYLE_ID = 'bghsa-list-style';

  /** What marks an element the extension is holding out of view. */
  const HIDDEN_CLASS = 'bghsa-hidden';

  /** Every rule the list surface adds to the page. */
  const STYLE_TEXT = [
    // Primer's own display utilities carry `!important`, so holding one of its
    // elements out of view takes the same weight.
    `.${HIDDEN_CLASS} { display: none !important; }`,
    '.bghsa-list-chips { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }',
    '.bghsa-list-owners { display: flex; flex-wrap: wrap; gap: 2px; align-items: center; }',
    '.bghsa-list-observed { color: var(--fgColor-muted); white-space: nowrap; }',
    '.bghsa-list-meta { color: var(--fgColor-muted); }',
    '.bghsa-list-empty { color: var(--fgColor-muted); }',
    '.bghsa-tone-attention { color: var(--fgColor-default);' +
      ' background-color: var(--bgColor-attention);' +
      ' border-color: var(--bgColor-attention); }',
    '.bghsa-tone-danger { color: var(--fgColor-default);' +
      ' background-color: var(--bgColor-danger);' +
      ' border-color: var(--bgColor-danger); }',
  ].join('\n');

  /** What the sort control reads while the table is in its default order. */
  const DEFAULT_SORT_LABEL = 'Default order';

  /** What the control that goes back to the default order reads. */
  const RESET_LABEL = 'Reset';

  /** What stands in the table where a filter keeps no row. */
  const EMPTY_TEXT = 'No advisory matches the filter';

  /** What names the facet one filter control holds the table to. */
  const FACET_ATTRIBUTE = 'data-bghsa-facet';

  /** What the toggle reads while the extension's table is showing. */
  const SHOW_GITHUB = "Show GitHub's view";

  /** What the toggle reads while GitHub's own view is showing. */
  const SHOW_TABLE = 'Show the Better GHSA table';

  /**
   * The selectors `parse-list` keys on inside `div#advisories`. Nothing the
   * table inserts may match one of them: the table sits in the element the
   * parser reads, and a row of its own read back as a row of GitHub's would
   * double every advisory on the next pass.
   *
   * @type {readonly string[]}
   */
  const PARSED_SELECTORS = ['div.Box-row--drag-hide', 'segmented-control', 'a[rel="next"]'];

  /** How every surface builds an element. */
  const element = globalThis.bghsa.dom.element;

  /**
   * @param {Document} doc
   * @param {ChipSpec} spec
   * @returns {Element}
   */
  function chip(doc, spec) {
    const classes = ['Label', 'Label--secondary'];
    if (spec.tone !== undefined) classes.push(`bghsa-tone-${spec.tone}`);
    return element(doc, 'span', classes.join(' '), spec.text);
  }

  /**
   * A stored value as a chip reads it. Only the first letter is touched, so a
   * value this extension does not interpret reaches the reader as it stands.
   *
   * @param {string} value
   * @returns {string}
   */
  function sentenceCase(value) {
    return value === '' ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
  }

  /**
   * @param {string | number | null} at
   * @returns {number | null} the instant `at` names, and null for a value that
   *   does not read as one.
   */
  function instantOf(at) {
    if (at === null) return null;
    const parsed = typeof at === 'number' ? at : Date.parse(at);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * @param {string | number | null} at
   * @returns {string | null} that instant to the minute in UTC. A string that
   *   does not read as a time comes back as it stands, because a stored value
   *   is whatever a maintainer's browser wrote.
   */
  function formatTime(at) {
    const parsed = instantOf(at);
    if (parsed === null) return typeof at === 'string' ? at : null;
    return new Date(parsed).toISOString().replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC');
  }

  /**
   * @param {string | number | null} at
   * @returns {string | null} the day that instant falls on, in UTC.
   */
  function formatDate(at) {
    const parsed = instantOf(at);
    if (parsed === null) return typeof at === 'string' ? at : null;
    return new Date(parsed).toISOString().slice(0, 10);
  }

  /**
   * @param {unknown} value
   * @returns {string | null} the string it holds, and null for anything else.
   */
  function text(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  /**
   * @param {unknown} value
   * @returns {string[]} the strings with content the value holds.
   */
  function strings(value) {
    if (!Array.isArray(value)) return [];
    /** @type {string[]} */
    const found = [];
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim() !== '') found.push(entry);
    }
    return found;
  }

  /**
   * One comment out of a cached record. The author's standing and the snapshot
   * are recomputed here rather than read: the record is what an older version of
   * this extension wrote, and the trust rule and the schema rules are this
   * version's.
   *
   * @param {unknown} value
   * @returns {import('../common/parse-detail.js').ParsedComment | null}
   */
  function commentFrom(value) {
    const schema = globalThis.bghsa.schema;
    if (!schema.isPlainObject(value)) return null;
    const author = text(value.author);
    const role = text(value.role);
    const held = schema.isPlainObject(value.stateComment) ? text(value.stateComment.raw) : null;
    return {
      id: text(value.id) ?? '',
      elementId: text(value.elementId) ?? '',
      author,
      role,
      roles: strings(value.roles),
      trusted: globalThis.bghsa.trust.isTrustedAuthor(author, role),
      at: text(value.at),
      text: text(value.text) ?? '',
      stateComment: held === null ? null : schema.readSnapshot(held),
    };
  }

  /**
   * @param {unknown} value
   * @returns {import('../common/parse-detail.js').TimelineEvent | null}
   */
  function eventFrom(value) {
    if (!globalThis.bghsa.schema.isPlainObject(value)) return null;
    return {
      id: text(value.id),
      actor: text(value.actor),
      at: text(value.at),
      text: text(value.text) ?? '',
    };
  }

  /**
   * @param {unknown} value
   * @returns {import('../common/parse-detail.js').ForkPullRequest | null}
   */
  function pullFrom(value) {
    if (!globalThis.bghsa.schema.isPlainObject(value)) return null;
    const number = value.number;
    return {
      number: typeof number === 'number' && Number.isFinite(number) ? number : null,
      url: text(value.url),
      title: text(value.title) ?? '',
      state: text(value.state),
      baseRef: text(value.baseRef),
      headRef: text(value.headRef),
      author: text(value.author),
      openedAt: text(value.openedAt),
      assignees: strings(value.assignees),
    };
  }

  /**
   * @param {unknown} value
   * @returns {import('../common/parse-detail.js').PrivateFork | null}
   */
  function forkFrom(value) {
    if (!globalThis.bghsa.schema.isPlainObject(value)) return null;
    if (!Array.isArray(value.pullRequests)) return null;
    /** @type {import('../common/parse-detail.js').ForkPullRequest[]} */
    const pullRequests = [];
    for (const entry of value.pullRequests) {
      const pull = pullFrom(entry);
      if (pull !== null) pullRequests.push(pull);
    }
    return {
      cloneUrl: text(value.cloneUrl),
      repository: text(value.repository),
      deleteUrl: text(value.deleteUrl),
      pullRequests,
    };
  }

  /**
   * The advisory a cache entry holds. The entry is data an older version of this
   * extension wrote, so every field is checked and none is assumed: a record
   * carrying no comment list and no timeline is not one this reader can derive
   * anything from, and it answers as absent.
   *
   * @param {unknown} record
   * @returns {import('../common/parse-detail.js').ParsedDetail | null}
   */
  function advisoryFrom(record) {
    const schema = globalThis.bghsa.schema;
    if (!schema.isPlainObject(record)) return null;
    if (!Array.isArray(record.comments) || !Array.isArray(record.timeline)) return null;

    /** @type {import('../common/parse-detail.js').ParsedComment[]} */
    const comments = [];
    for (const entry of record.comments) {
      const comment = commentFrom(entry);
      if (comment !== null) comments.push(comment);
    }
    /** @type {import('../common/parse-detail.js').TimelineEvent[]} */
    const timeline = [];
    for (const entry of record.timeline) {
      const event = eventFrom(entry);
      if (event !== null) timeline.push(event);
    }

    return {
      ref: null,
      viewer: null,
      ghsaId: text(record.ghsaId),
      state: text(record.state),
      severity: text(record.severity),
      severityLabel: text(record.severityLabel),
      reportedAt: text(record.reportedAt),
      reporter: text(record.reporter),
      title: text(record.title),
      description: text(record.description),
      severityField: text(record.severityField),
      severityFieldPresent: record.severityFieldPresent === true,
      cvssV3: text(record.cvssV3),
      cvssV3Present: record.cvssV3Present === true,
      cveId: text(record.cveId),
      cveSelection: text(record.cveSelection),
      descriptionOriginal:
        typeof record.descriptionOriginal === 'boolean' ? record.descriptionOriginal : null,
      descriptionRevision: null,
      comments,
      timeline,
      fork: forkFrom(record.fork),
      collaborators: strings(record.collaborators),
    };
  }

  /**
   * The furthest state the advisory's private fork reached. A pull request whose
   * state went unread leaves this null where nothing else is open or merged,
   * because a closed patch and a patch this reader could not judge are not the
   * same thing.
   *
   * @param {import('../common/derive.js').PatchState} patch
   * @returns {string | null}
   */
  function patchStateOf(patch) {
    const states = patch.pullRequests.map((pull) => pull.state);
    if (states.includes('open')) return 'Patch in review';
    if (states.includes('merged')) return 'Patch merged';
    if (patch.incomplete || states.length === 0) return null;
    return 'Patch closed';
  }

  /**
   * @param {import('../common/derive.js').PatchState} patch
   * @param {readonly string[]} backports The branches a maintainer asked for.
   * @returns {number} how many of them carry a merged pull request.
   */
  function backportsDoneIn(patch, backports) {
    /** @type {Set<string>} */
    const merged = new Set();
    return backports.filter((branch) => merged.has(branch)).length;
  }

  /**
   * What the CVE chip reads. An assigned CVE reads as the identifier itself,
   * which is the value a maintainer is looking for. An advisory with no CVE
   * state has no chip.
   *
   * @param {import('../common/derive.js').CveState} cve
   * @returns {string | null}
   */
  function cveTextOf(cve) {
    if (cve.state === 'assigned') return cve.id;
    if (cve.state === 'requested') return 'CVE requested';
    if (cve.state === 'not applicable') return 'CVE not applicable';
    return null;
  }

  /**
   * A row carrying nothing but what the list markup said.
   *
   * @param {import('../common/parse-list.js').ListRow} listRow
   * @param {number} seenAt When the markup this row came from was read, which is
   *   the moment the row stands for.
   * @returns {TableRow}
   */
  function unreadRow(listRow, seenAt) {
    return {
      ghsaId: listRow.ghsaId,
      href: listRow.href,
      title: listRow.title,
      state: listRow.state,
      severity: listRow.severity,
      severityLabel: listRow.severityLabel,
      severityConfirmed: false,
      openedAt: listRow.openedAt,
      reporter: listRow.reporter,
      owners: [],
      observedAt: seenAt,
      read: false,
      neverReviewed: false,
      newActivity: false,
      triage: null,
      waitingSince: listRow.openedAt,
      embargo: false,
      embargoLift: null,
      embargoOverdue: false,
      patch: null,
      backportTargets: 0,
      backportsDone: 0,
      textConfirmed: false,
      cve: null,
      cveState: null,
    };
  }

  /**
   * One row, from what the cache holds of that advisory and from the list markup
   * that named it.
   *
   * A row carries one observation time, so what stands under that time is one
   * observation. Where an advisory read backs the row, the read supplies every
   * value it holds and the row is stamped with the moment it was taken, and the
   * list markup fills in only what the read does not hold. The identifier and
   * the path are the advisory's own, and are neither read nor observed.
   *
   * @param {RowSource} source The advisory as a list page showed it.
   * @param {import('../common/cache.js').CacheEntry | null} entry
   * @param {number} at The moment this render is happening, which is what says
   *   whether an embargo has run out.
   * @returns {Promise<TableRow>}
   */
  async function viewRow(source, entry, at) {
    const listRow = source.row;
    const advisory = entry === null ? null : advisoryFrom(entry.record);
    if (advisory === null || entry === null) return unreadRow(listRow, source.seenAt);

    const merged = globalThis.bghsa.merge.mergeSnapshots(advisory.comments);
    const tracking = await globalThis.bghsa.tracking.readAdvisory(advisory, merged);
    const derived = globalThis.bghsa.derive.derive(advisory);
    const embargoLift = tracking.embargo ? tracking.embargoLift : null;

    return {
      ghsaId: listRow.ghsaId ?? advisory.ghsaId,
      href: listRow.href,
      title: advisory.title ?? listRow.title,
      state: advisory.state ?? listRow.state,
      severity: advisory.severity ?? listRow.severity,
      severityLabel: advisory.severityLabel ?? listRow.severityLabel,
      severityConfirmed: tracking.scoring.status === 'confirmed',
      openedAt: advisory.reportedAt ?? listRow.openedAt,
      reporter: advisory.reporter ?? listRow.reporter,
      owners: tracking.owners,
      observedAt: entry.observedAt,
      read: true,
      neverReviewed: derived.neverReviewed,
      newActivity: derived.newActivity,
      triage: tracking.triage,
      waitingSince: tracking.triageSince ?? advisory.reportedAt ?? listRow.openedAt,
      embargo: tracking.embargo,
      embargoLift,
      embargoOverdue: globalThis.bghsa.derive.embargoOverdue(advisory, embargoLift, at),
      patch: patchStateOf(derived.patch),
      backportTargets: tracking.backports.length,
      backportsDone: backportsDoneIn(derived.patch, tracking.backports),
      textConfirmed:
        tracking.title.status === 'confirmed' && tracking.description.status === 'confirmed',
      cve: cveTextOf(derived.cve),
      cveState: derived.cve.state,
    };
  }

  /**
   * @param {import('../common/parse-list.js').ListRow} row
   * @param {string | null} selected The `?state=` the page is showing.
   * @returns {string | null} the `?state=` this row belongs to. A row's own chip
   *   names it where the row carries one, and the tab the page is showing names
   *   it where the row does not.
   */
  function stateOfRow(row, selected) {
    return globalThis.bghsa.crawl.stateKeyOf(row.state) ?? selected;
  }

  /**
   * Every open advisory the table shows: the union of `?state=triage` and
   * `?state=draft` as the crawl holds it, and the rows of the page being looked
   * at.
   *
   * The page wins where both name an advisory, because GitHub rendered it now
   * and the crawl's copy is as old as the walk that found it. Each source
   * carries when it was read, which is what its row stands for until an advisory
   * read backs it. A published or closed advisory is not on this table, so a
   * page showing one of those tabs contributes rows to nothing.
   *
   * @param {import('../common/parse-list.js').ParsedList} parsed
   * @param {ViewOptions} [options]
   * @returns {Promise<Map<string, RowSource>>} by GHSA identifier.
   */
  async function listRows(parsed, options = {}) {
    const cache = globalThis.bghsa.cache;
    const open = globalThis.bghsa.parseList.OPEN_STATES;
    const at = options.at ?? cache.now();
    const held = await cache.getList(parsed, { storage: options.storage, at });
    const crawled = globalThis.bghsa.crawl.listFrom(held === null ? null : held.record);

    /** @type {Map<string, RowSource>} */
    const rows = new Map();
    for (const found of Object.values(crawled.rows)) {
      if (!open.includes(found.state) || found.row.ghsaId === null) continue;
      rows.set(found.row.ghsaId, { row: found.row, seenAt: found.seenAt });
    }
    for (const row of parsed.rows) {
      if (row.ghsaId === null) continue;
      const state = stateOfRow(row, parsed.selectedState);
      if (state === null || !open.includes(state)) continue;
      rows.set(row.ghsaId, { row, seenAt: at });
    }
    return rows;
  }

  /**
   * The rows of the table, in the default order, from the crawl of both open
   * states, from the list markup on the page, and from what the cache holds of
   * the advisories they name.
   *
   * Nothing here waits on the network. The table paints from what is already
   * known, and the reads that fill it in arrive afterwards.
   *
   * @param {import('../common/parse-list.js').ParsedList} parsed
   * @param {ViewOptions} [options]
   * @returns {Promise<TableView>}
   */
  async function readView(parsed, options = {}) {
    const cache = globalThis.bghsa.cache;
    const at = options.at ?? cache.now();
    const sources = await listRows(parsed, { ...options, at });
    const ids = [...sources.keys()];
    const entries = await cache.getAdvisories(parsed, ids, { storage: options.storage, at });
    const rows = await Promise.all(
      [...sources.values()].map((source) =>
        viewRow(
          source,
          source.row.ghsaId === null ? null : entries.get(source.row.ghsaId) ?? null,
          at
        )
      )
    );
    return { rows: globalThis.bghsa.order.sort(rows), at, sources };
  }

  /**
   * The chips under one row's title, in the order REQUIREMENTS.md section 9
   * lists them.
   *
   * A chip standing for a boolean is there while the condition holds and absent
   * while it does not. Colour marks what a maintainer has to act on now: an
   * advisory nobody has reviewed, a reporter waiting on an answer, an embargo
   * running out. A chip naming a state the advisory is simply in stays dimmed.
   *
   * The scoring confirmation rides on the severity chip, because the scoring
   * track is the severity and its vector, and a second chip beside the severity
   * would say the same thing twice. Where the advisory sets no severity there is
   * no chip to ride, and the confirmation stands on its own.
   *
   * @param {TableRow} row
   * @returns {ChipSpec[]}
   */
  function chipsFor(row) {
    const order = globalThis.bghsa.order;
    /** @type {ChipSpec[]} */
    const chips = [];

    // The waiting state is what an advisory read says, so it is absent until one
    // has been read. Nothing on the list page names it.
    if (row.read) {
      const tier = order.tierOf(row);
      /** @type {ChipSpec} */
      const waiting = { text: sentenceCase(order.tierName(tier)) };
      if (tier === order.TIERS.NEVER_REVIEWED) waiting.tone = 'danger';
      else if (tier === order.TIERS.NEW_ACTIVITY) waiting.tone = 'attention';
      chips.push(waiting);
    }

    if (row.patch !== null) chips.push({ text: row.patch });
    if (row.backportTargets > 0) {
      chips.push({ text: `Backports ${row.backportsDone} of ${row.backportTargets}` });
    }
    if (row.textConfirmed) chips.push({ text: 'Text confirmed' });

    if (row.cve !== null) chips.push({ text: row.cve });

    if (row.severityLabel !== null) {
      const severity = sentenceCase(row.severityLabel);
      chips.push({
        text: row.read
          ? `${severity}, ${row.severityConfirmed ? 'confirmed' : 'unconfirmed'}`
          : severity,
      });
    } else if (row.severityConfirmed) {
      chips.push({ text: 'Scoring confirmed' });
    }

    if (row.embargoOverdue) chips.push({ text: 'Embargo overdue', tone: 'danger' });
    else if (row.embargo) {
      const lift = row.embargoLift;
      chips.push({
        text: lift === null ? 'Embargoed' : `Embargo lifts ${lift}`,
        tone: 'attention',
      });
    }

    return chips;
  }

  /**
   * What a filter offers for a row that holds no value for its facet.
   */
  const NO_VALUE = 'None';

  /**
   * The sort key of the default order. It is the tiering in REQUIREMENTS.md
   * section 9, which is what the table shows until a maintainer picks another
   * value to order by, and what the sort control comes back to.
   */
  const DEFAULT_SORT = 'default';

  /**
   * The last tie-break under every sort, so that no order depends on the order
   * the rows arrived in. It is `order.byId`, reached through the comparator
   * that file holds, so the two sorts settle a row whose identifier went unread
   * the same way: below every row whose identifier is known.
   *
   * @param {TableRow} a
   * @param {TableRow} b
   * @returns {number}
   */
  function byGhsaId(a, b) {
    return globalThis.bghsa.order.compareText(a.ghsaId, b.ghsaId);
  }

  /**
   * @param {TableRow} row
   * @param {boolean} confirmed
   * @returns {number} the severity's rank where its confirmation is the one
   *   asked for, and 0 where it is not. This is the two-key rule the default
   *   order uses: every severity a maintainer confirmed ranks above every
   *   severity nobody has confirmed.
   */
  function severityScore(row, confirmed) {
    if (row.severityConfirmed !== confirmed) return 0;
    return globalThis.bghsa.order.severityRank(row.severity);
  }

  /**
   * @param {TableRow} row
   * @returns {number} how far the advisory's CVE has come, highest first.
   */
  function cveRank(row) {
    if (row.cveState === 'assigned') return 3;
    if (row.cveState === 'requested') return 2;
    if (row.cveState === 'not applicable') return 1;
    return 0;
  }

  /**
   * @param {TableRow} row
   * @returns {number} how pressing the embargo is, highest first.
   */
  function embargoRank(row) {
    if (row.embargoOverdue) return 2;
    return row.embargo ? 1 : 0;
  }

  /**
   * @param {TableRow} row
   * @returns {string[]} which of the two tracks a maintainer confirmed.
   */
  function confirmedValuesOf(row) {
    /** @type {string[]} */
    const held = [];
    if (row.textConfirmed) held.push('Text');
    if (row.severityConfirmed) held.push('Scoring');
    return held;
  }

  /**
   * @param {TableRow} row
   * @returns {string[]} where the branches a maintainer asked for stand, and
   *   nothing for an advisory nobody asked for a backport on.
   */
  function backportValuesOf(row) {
    if (row.backportTargets === 0) return [];
    return [row.backportsDone >= row.backportTargets ? 'Complete' : 'Outstanding'];
  }

  /**
   * @param {TableRow} row
   * @returns {string[]} the patch state without the word the chip repeats.
   */
  function patchValuesOf(row) {
    if (row.patch === null) return [];
    return [sentenceCase(row.patch.replace(/^Patch /, ''))];
  }

  /**
   * @param {TableRow} row
   * @returns {string[]} which side the advisory is waiting on, and nothing while
   *   nothing has been read: the tier is what an advisory read says, and a row
   *   the extension has not reached yet holds no answer either way.
   */
  function waitingValuesOf(row) {
    if (!row.read) return [];
    const order = globalThis.bghsa.order;
    return [sentenceCase(order.tierName(order.tierOf(row)))];
  }

  /**
   * Every value a row holds, as the sort control and the filter controls read
   * it. A facet's sort puts what a maintainer is looking for at the top: the
   * longest waiting, the highest severity, the most pressing embargo, the
   * stalest read.
   *
   * @type {readonly Facet[]}
   */
  const FACETS = [
    {
      key: 'waiting',
      label: 'Waiting',
      sortLabel: 'Longest waiting',
      filter: true,
      values: globalThis.bghsa.order.TIER_NAMES.map(sentenceCase),
      valuesOf: waitingValuesOf,
      compare: (a, b) =>
        globalThis.bghsa.order.compareNumber(instantOf(a.waitingSince), instantOf(b.waitingSince)),
    },
    {
      key: 'severity',
      label: 'Severity',
      sortLabel: 'Highest severity',
      filter: true,
      values: ['Critical', 'High', 'Moderate', 'Low'],
      valuesOf: (row) => (row.severityLabel === null ? [] : [sentenceCase(row.severityLabel)]),
      compare: (a, b) =>
        severityScore(b, true) - severityScore(a, true) ||
        severityScore(b, false) - severityScore(a, false),
    },
    {
      key: 'owner',
      label: 'Owner',
      filter: true,
      valuesOf: (row) => row.owners.slice(),
      compare: (a, b) => compareText(a.owners[0] ?? null, b.owners[0] ?? null),
    },
    {
      key: 'reporter',
      label: 'Reporter',
      filter: true,
      valuesOf: (row) => (row.reporter === null ? [] : [row.reporter]),
      compare: (a, b) => compareText(a.reporter, b.reporter),
    },
    {
      key: 'state',
      label: 'State',
      filter: true,
      valuesOf: (row) => (row.state === null ? [] : [row.state]),
      compare: (a, b) => compareText(a.state, b.state),
    },
    {
      key: 'patch',
      label: 'Patch',
      filter: true,
      values: ['In review', 'Merged', 'Closed'],
      valuesOf: patchValuesOf,
      compare: (a, b) => compareText(a.patch, b.patch),
    },
    {
      key: 'backports',
      label: 'Backports',
      filter: true,
      values: ['Outstanding', 'Complete'],
      valuesOf: backportValuesOf,
      compare: (a, b) =>
        b.backportTargets - b.backportsDone - (a.backportTargets - a.backportsDone),
    },
    {
      key: 'cve',
      label: 'CVE',
      filter: true,
      values: ['Assigned', 'Requested', 'Not applicable'],
      valuesOf: (row) =>
        row.cveState === null || row.cveState === 'none' ? [] : [sentenceCase(row.cveState)],
      compare: (a, b) => cveRank(b) - cveRank(a),
    },
    {
      key: 'embargo',
      label: 'Embargo',
      filter: true,
      values: ['Overdue', 'Set'],
      valuesOf: (row) => (row.embargoOverdue ? ['Set', 'Overdue'] : row.embargo ? ['Set'] : []),
      compare: (a, b) => embargoRank(b) - embargoRank(a),
    },
    {
      key: 'confirmed',
      label: 'Confirmed',
      filter: true,
      values: ['Text', 'Scoring'],
      valuesOf: confirmedValuesOf,
      compare: (a, b) => confirmedValuesOf(b).length - confirmedValuesOf(a).length,
    },
    {
      key: 'opened',
      label: 'Opened',
      sortLabel: 'Oldest opened',
      valuesOf: () => [],
      compare: (a, b) => compareNumber(instantOf(a.openedAt), instantOf(b.openedAt)),
    },
    {
      key: 'observed',
      label: 'Observed',
      sortLabel: 'Stalest observed',
      valuesOf: () => [],
      compare: (a, b) => compareNumber(instantOf(a.observedAt), instantOf(b.observedAt)),
    },
    {
      key: 'title',
      label: 'Title',
      valuesOf: () => [],
      compare: (a, b) => compareText(a.title, b.title),
    },
  ];

  /**
   * @param {string} key
   * @returns {Facet | null} the facet that key names, and null for a key this
   *   reader does not know.
   */
  function facetFor(key) {
    return FACETS.find((facet) => facet.key === key) ?? null;
  }

  /**
   * @param {Facet} facet
   * @returns {string} what the sort control reads for it.
   */
  function sortLabelOf(facet) {
    return facet.sortLabel ?? facet.label;
  }

  /**
   * @returns {ViewState} the view the table comes up in and the view the reset
   *   goes back to: the default order, filtering nothing.
   */
  function defaultViewState() {
    return { sort: DEFAULT_SORT, filters: {} };
  }

  /**
   * Whether one row passes one filter.
   *
   * A row no advisory read backs holds less than one a read does, and a filter
   * does not hide a row over a value nobody has looked up yet: such a row passes
   * every filter over a facet a read supplies, and drops out of the ones it
   * turns out not to match once its read lands. A row a read does back and that
   * holds nothing for the facet passes only {@link NO_VALUE}.
   *
   * @param {Facet} facet
   * @param {TableRow} row
   * @param {string} wanted
   * @returns {boolean}
   */
  function matchesFilter(facet, row, wanted) {
    const held = facet.valuesOf(row);
    if (held.length === 0) return row.read ? wanted === NO_VALUE : true;
    return held.includes(wanted);
  }

  /**
   * @param {TableRow} row
   * @param {ViewState} state
   * @returns {boolean} whether every filter the view is holding keeps this row.
   */
  function matchesView(row, state) {
    for (const [key, wanted] of Object.entries(state.filters)) {
      if (wanted === '') continue;
      const facet = facetFor(key);
      if (facet === null) continue;
      if (!matchesFilter(facet, row, wanted)) return false;
    }
    return true;
  }

  /**
   * The comparator one sort runs: the facet's own, and then the identifier, so
   * that no sort depends on the order the rows arrived in.
   *
   * @param {string} key
   * @returns {((a: TableRow, b: TableRow) => number) | null} null for the
   *   default order, and for a key this reader does not know, both of which
   *   `order.compare` settles.
   */
  function sortFor(key) {
    const facet = key === DEFAULT_SORT ? null : facetFor(key);
    if (facet === null) return null;
    return (a, b) => facet.compare(a, b) || byGhsaId(a, b);
  }

  /**
   * The view each document is showing. It is held here rather than read off the
   * controls, because a pass takes the table out and puts a new one back, and a
   * maintainer's chosen view has to survive that.
   *
   * @type {WeakMap<Document, ViewState>}
   */
  const viewStates = new WeakMap();

  /**
   * @param {Document} doc
   * @returns {ViewState} the view that document is showing, which is the default
   *   until a control says otherwise.
   */
  function viewStateOf(doc) {
    return viewStates.get(doc) ?? defaultViewState();
  }

  /**
   * @param {Document} doc
   * @param {ViewState} state
   * @returns {void}
   */
  function setViewState(doc, state) {
    viewStates.set(doc, state);
  }

  /**
   * The rows a view shows, in the order it puts them in.
   *
   * This is a view over what the table already holds. Nothing is read again and
   * nothing is fetched: filtering and sorting move rows the extension has, and a
   * row it has not read yet is still a row.
   *
   * A sort key this reader does not know leaves the default order, so a view
   * carrying one shows the table as it stands rather than showing nothing.
   *
   * @param {readonly TableRow[]} rows
   * @param {ViewState} state
   * @returns {TableRow[]}
   */
  function applyView(rows, state) {
    const kept = rows.filter((row) => matchesView(row, state));
    const compare = sortFor(state.sort);
    return compare === null ? globalThis.bghsa.order.sort(kept) : kept.sort(compare);
  }

  /**
   * The values one filter offers: what the rows hold for that facet, followed by
   * {@link NO_VALUE} where a row a read backs holds none.
   *
   * A value the filter is already holding to stays on offer even after the last
   * row carrying it leaves, so a read landing cannot take the control out from
   * under the view a maintainer is looking at.
   *
   * @param {readonly TableRow[]} rows
   * @param {Facet} facet
   * @param {string} selected What the filter is holding to, and the empty string
   *   for one holding to nothing.
   * @returns {string[]}
   */
  function filterOptions(rows, facet, selected) {
    /** @type {Set<string>} */
    const held = new Set();
    let absent = false;
    for (const row of rows) {
      const values = facet.valuesOf(row);
      if (values.length === 0) absent = absent || row.read;
      for (const value of values) held.add(value);
    }
    const known = facet.values ?? [];
    const offered = [...held].sort((a, b) => {
      const left = known.indexOf(a);
      const right = known.indexOf(b);
      if (left !== right) return (left === -1 ? known.length : left) - (right === -1 ? known.length : right);
      return globalThis.bghsa.order.compareText(a, b);
    });
    if (absent) offered.push(NO_VALUE);
    if (selected !== '' && !offered.includes(selected)) offered.push(selected);
    return offered;
  }

  /**
   * The line GitHub's own row carries under the title. The table replaces those
   * rows, so it carries what they carried.
   *
   * @param {TableRow} row
   * @returns {string}
   */
  function metaTextOf(row) {
    const parts = [];
    if (row.ghsaId !== null) parts.push(row.ghsaId);
    const opened = formatDate(row.openedAt);
    if (opened !== null) parts.push(`opened ${opened}`);
    if (row.reporter !== null) parts.push(`by ${row.reporter}`);
    return parts.join(' ');
  }

  /**
   * The size an owner icon is drawn at.
   * `testdata/published-containerd.html` shows GitHub drawing a collaborator
   * avatar at 20 pixels from a source asked for at `s=40`, so the image is
   * requested at twice the size it is drawn at and reads sharp on a display
   * that doubles pixels.
   */
  const AVATAR_PIXELS = 20;

  /** The size the avatar image is asked for, in pixels. */
  const AVATAR_SOURCE_PIXELS = AVATAR_PIXELS * 2;

  /**
   * The avatar GitHub serves for one login.
   *
   * Every avatar in every capture under `testdata/` is keyed on the account's
   * numeric id, `https://avatars.githubusercontent.com/u/{id}?s=40&v=4`, and an
   * owner login arrives from a state comment with no id beside it. GitHub also
   * serves `https://github.com/{login}.png?size={n}`, which redirects to that
   * id-keyed form: `samuelkarp` answers with
   * `https://avatars.githubusercontent.com/u/737750?s=40&v=4`, verified in a
   * browser on 2026-08-27.
   *
   * A login that names no account and a request that fails both leave the image
   * blank, and the icon falls back to the login in its `alt`. Neither is known
   * here, so every login gets a source and the browser decides what arrives.
   *
   * @param {string} login
   * @returns {string}
   */
  function avatarUrlFor(login) {
    return `https://github.com/${encodeURIComponent(login)}.png?size=${AVATAR_SOURCE_PIXELS}`;
  }

  /**
   * The owners, as the profile icons an issue carries for its assignees: the
   * `img.avatar.avatar-user` inside a link to the profile that GitHub uses for a
   * collaborator.
   *
   * The login travels in `alt` and in `title`, so an owner whose image does not
   * load is still named and the row still renders.
   *
   * An owner login arrives from a state comment, which is text anyone who can
   * comment on the advisory can write, so it is encoded into the profile path
   * the same way it is encoded into the avatar source beside it.
   *
   * @param {Document} doc
   * @param {readonly string[]} owners
   * @returns {Element}
   */
  function buildOwners(doc, owners) {
    const box = element(doc, 'div', 'bghsa-list-owners');
    for (const login of owners) {
      const link = element(doc, 'a', 'no-underline bghsa-list-owner');
      link.setAttribute('href', `/${encodeURIComponent(login)}`);
      link.setAttribute('title', login);
      link.setAttribute('aria-label', `Owner ${login}`);
      const avatar = element(doc, 'img', 'avatar avatar-user');
      avatar.setAttribute('src', avatarUrlFor(login));
      avatar.setAttribute('alt', `@${login}`);
      avatar.setAttribute('title', login);
      avatar.setAttribute('width', String(AVATAR_PIXELS));
      avatar.setAttribute('height', String(AVATAR_PIXELS));
      link.append(avatar);
      box.append(link);
    }
    return box;
  }

  /**
   * One row: the title as a link, the line GitHub's row carried, the chips, the
   * state, the owners, and when this row's data was read.
   *
   * The row carries none of the classes `parse-list` keys on, so a re-read of
   * the page cannot take it for one of GitHub's.
   *
   * @param {Document} doc
   * @param {TableRow} row
   * @returns {Element}
   */
  function buildRow(doc, row) {
    const item = element(doc, 'li', 'Box-row d-flex flex-items-start bghsa-list-row');
    if (row.ghsaId !== null) item.setAttribute('data-bghsa-ghsa', row.ghsaId);

    const main = element(doc, 'div', 'flex-auto lh-condensed');
    const link = element(
      doc,
      'a',
      'Link--primary v-align-middle no-underline h4',
      row.title ?? row.ghsaId ?? 'Advisory'
    );
    if (row.href !== null) link.setAttribute('href', row.href);
    main.append(link);
    main.append(element(doc, 'div', 'mt-1 text-small bghsa-list-meta', metaTextOf(row)));
    const chips = element(doc, 'div', 'mt-1 bghsa-list-chips');
    for (const spec of chipsFor(row)) chips.append(chip(doc, spec));
    main.append(chips);
    item.append(main);

    const state = element(doc, 'div', 'pl-2 flex-shrink-0 bghsa-list-state');
    if (row.state !== null) state.append(chip(doc, { text: row.state }));
    item.append(state);

    if (row.owners.length > 0) {
      const owners = element(doc, 'div', 'pl-2 flex-shrink-0');
      owners.append(buildOwners(doc, row.owners));
      item.append(owners);
    }

    item.append(
      element(
        doc,
        'div',
        'pl-2 flex-shrink-0 text-small bghsa-list-observed',
        `Observed ${formatTime(row.observedAt) ?? 'never'}`
      )
    );
    return item;
  }

  /**
   * @param {number} count
   * @returns {string}
   */
  function countTextOf(count) {
    return count === 1 ? '1 advisory' : `${count} advisories`;
  }

  /**
   * @param {Element} field
   * @returns {string} what a control holds. The live property is read where the
   *   host offers one, because that is what the maintainer picked.
   */
  function controlValue(field) {
    const live = /** @type {{ value?: unknown }} */ (/** @type {unknown} */ (field)).value;
    return typeof live === 'string' ? live : (field.getAttribute('value') ?? '');
  }

  /**
   * @param {Document} doc
   * @param {string} value
   * @param {string} label
   * @param {string} selected
   * @returns {Element}
   */
  function option(doc, value, label, selected) {
    const node = element(doc, 'option', '', label);
    node.setAttribute('value', value);
    if (value === selected) node.setAttribute('selected', '');
    return node;
  }

  /**
   * @param {Document} doc
   * @param {Facet} facet
   * @param {readonly TableRow[]} rows
   * @param {string} selected
   * @returns {Element[]} what one filter offers: the facet's own label for a
   *   filter holding the table to nothing, then the values the rows hold.
   */
  function filterOptionNodes(doc, facet, rows, selected) {
    const nodes = [option(doc, '', facet.label, selected)];
    for (const value of filterOptions(rows, facet, selected)) {
      nodes.push(option(doc, value, value, selected));
    }
    return nodes;
  }

  /**
   * The controls the table carries: what the rows are ordered by, what each
   * value is holding the table to, and the way back to the default.
   *
   * They take the place GitHub's segmented control and query form are held out
   * of, and they carry none of the classes `parse-list` keys on.
   *
   * The default order is not one sort among others. It is the tiering in
   * REQUIREMENTS.md section 9, it is what the sort control comes up on, and the
   * reset is what gets back to it along with everything the filters are holding.
   *
   * @param {Document} doc
   * @param {readonly TableRow[]} rows What the table holds, which is what the
   *   filters offer the values of.
   * @param {ViewState} state
   * @returns {Element}
   */
  function buildControls(doc, rows, state) {
    const box = element(doc, 'div', 'd-flex flex-wrap flex-items-center bghsa-list-controls');

    const sort = element(doc, 'select', 'form-select select-sm mr-2 mb-1 bghsa-list-sort');
    sort.setAttribute('aria-label', 'Sort');
    sort.append(option(doc, DEFAULT_SORT, DEFAULT_SORT_LABEL, state.sort));
    for (const facet of FACETS) sort.append(option(doc, facet.key, sortLabelOf(facet), state.sort));
    sort.addEventListener('change', () => {
      setViewState(doc, { ...viewStateOf(doc), sort: controlValue(sort) });
      refreshBody(doc);
    });
    box.append(sort);

    for (const facet of FACETS) {
      if (facet.filter !== true) continue;
      const selected = state.filters[facet.key] ?? '';
      const control = element(doc, 'select', 'form-select select-sm mr-2 mb-1 bghsa-list-filter');
      control.setAttribute('aria-label', facet.label);
      control.setAttribute(FACET_ATTRIBUTE, facet.key);
      control.append(...filterOptionNodes(doc, facet, rows, selected));
      control.addEventListener('change', () => {
        const held = viewStateOf(doc);
        const filters = { ...held.filters, [facet.key]: controlValue(control) };
        setViewState(doc, { ...held, filters });
        refreshBody(doc);
      });
      box.append(control);
    }

    const reset = element(doc, 'button', 'btn btn-sm mb-1 bghsa-list-reset', RESET_LABEL);
    reset.setAttribute('type', 'button');
    reset.addEventListener('click', () => {
      setViewState(doc, defaultViewState());
      resetControls(doc);
      refreshBody(doc);
    });
    box.append(reset);
    return box;
  }

  /**
   * @param {Document} doc
   * @returns {void} draws the controls again from the view the document is now
   *   showing, which is what puts every one of them back on its blank option.
   */
  function resetControls(doc) {
    const root = doc.getElementById(ROOT_ID);
    const view = views.get(doc);
    if (root === null || view === undefined) return;
    const held = root.querySelector('.bghsa-list-controls');
    if (held === null) return;
    held.replaceWith(buildControls(doc, view.rows, viewStateOf(doc)));
  }

  /**
   * Puts the values the table now holds on offer, leaving what every filter is
   * holding to alone. A read landing can turn up an owner or a patch state no
   * row carried before, and the control offers it from then on.
   *
   * @param {Document} doc
   * @returns {void}
   */
  function syncFilterOptions(doc) {
    const root = doc.getElementById(ROOT_ID);
    const view = views.get(doc);
    if (root === null || view === undefined) return;
    for (const control of root.querySelectorAll(`[${FACET_ATTRIBUTE}]`)) {
      const facet = facetFor(control.getAttribute(FACET_ATTRIBUTE) ?? '');
      if (facet === null) continue;
      const selected = controlValue(control);
      const wanted = filterOptionNodes(doc, facet, view.rows, selected);
      const held = [...control.querySelectorAll('option')];
      const same =
        held.length === wanted.length &&
        held.every((each, at) => each.getAttribute('value') === wanted[at]?.getAttribute('value'));
      if (same) continue;
      while (control.firstChild !== null) control.removeChild(control.firstChild);
      control.append(...wanted);
    }
  }

  /**
   * @param {number} shown
   * @param {number} held
   * @returns {string} what the header says is showing, which names both counts
   *   while a filter is keeping rows out.
   */
  function viewCountText(shown, held) {
    return shown === held ? countTextOf(held) : `${shown} of ${countTextOf(held)}`;
  }

  /**
   * The rows the table shows. A filter that keeps nothing says so, so that a
   * table holding rows a filter is hiding does not read as a broken one.
   *
   * @param {Document} doc
   * @param {readonly TableRow[]} shown
   * @param {number} held How many rows the table holds.
   * @returns {Element}
   */
  function buildBody(doc, shown, held) {
    const list = element(doc, 'ul', 'bghsa-list-rows');
    if (shown.length === 0 && held > 0) {
      list.append(element(doc, 'li', 'Box-row bghsa-list-empty', EMPTY_TEXT));
      return list;
    }
    for (const row of shown) list.append(buildRow(doc, row));
    return list;
  }

  /**
   * Draws the rows again under the view the document is showing. The controls
   * are left as they are, so changing one does not take the focus off it.
   *
   * @param {Document} doc
   * @returns {void}
   */
  function refreshBody(doc) {
    const root = doc.getElementById(ROOT_ID);
    const view = views.get(doc);
    if (root === null || view === undefined) return;
    const box = root.querySelector('.bghsa-list-box');
    if (box === null) return;
    const shown = applyView(view.rows, viewStateOf(doc));
    const count = root.querySelector('.bghsa-list-count');
    if (count !== null) count.textContent = viewCountText(shown.length, view.rows.length);
    const body = buildBody(doc, shown, view.rows.length);
    const held = root.querySelector('.bghsa-list-rows');
    if (held === null) box.append(body);
    else held.replaceWith(body);
  }

  /**
   * The extension's surface: a bar carrying the controls and the toggle, which
   * is visible in either view, and the table, which the toggle holds out of
   * view along with the controls that act on it.
   *
   * @param {Document} doc
   * @param {TableView} view
   * @returns {Element}
   */
  function buildTable(doc, view) {
    const state = viewStateOf(doc);
    const root = element(doc, 'div', 'bghsa-list-root');
    root.id = ROOT_ID;
    root.setAttribute('data-bghsa-list', '1');

    const bar = element(
      doc,
      'div',
      'd-flex flex-wrap flex-items-center flex-justify-between mb-2 bghsa-list-bar'
    );
    bar.append(buildControls(doc, view.rows, state));
    const toggle = element(doc, 'button', 'btn btn-sm bghsa-list-toggle', SHOW_GITHUB);
    toggle.setAttribute('type', 'button');
    toggle.addEventListener('click', () => {
      setShowingNative(doc, !showingNative(doc));
      applyVisibility(doc);
    });
    bar.append(toggle);
    root.append(bar);

    const box = element(doc, 'div', 'Box mb-3 bghsa-list-box');
    const header = element(
      doc,
      'div',
      'Box-header d-flex flex-items-center flex-justify-between bghsa-list-header'
    );
    header.append(element(doc, 'strong', '', 'Better GHSA'));
    const shown = applyView(view.rows, state);
    header.append(
      element(
        doc,
        'span',
        'text-normal bghsa-list-count',
        viewCountText(shown.length, view.rows.length)
      )
    );
    box.append(header);
    box.append(buildBody(doc, shown, view.rows.length));
    root.append(box);
    return root;
  }

  /**
   * GitHub's own controls, which the table holds out of view while it is
   * showing: the Box carrying the segmented control and the native rows, and the
   * query form. The segmented control and the rows are one element, so restoring
   * them is one act and cannot restore half.
   *
   * @param {Element} container The `div#advisories`.
   * @returns {Element[]}
   */
  function nativeControls(container) {
    /** @type {Element[]} */
    const found = [];
    const control = container.querySelector('segmented-control');
    const box =
      control?.closest('div.Box') ??
      container.querySelector('div.Box-row--drag-hide')?.closest('div.Box') ??
      null;
    if (box !== null) found.push(box);
    for (const filter of container.querySelectorAll('repository-advisories-filter')) {
      if (!found.includes(filter)) found.push(filter);
    }
    return found;
  }

  /**
   * Which view each document is showing. GitHub's view is showing only where a
   * press asked for it, so a fresh page and a re-render after a subtree
   * replacement both come up on the table.
   *
   * @type {WeakMap<Document, boolean>}
   */
  const nativeView = new WeakMap();

  /**
   * @param {Document} doc
   * @returns {boolean} whether GitHub's own view is showing.
   */
  function showingNative(doc) {
    return nativeView.get(doc) === true;
  }

  /**
   * @param {Document} doc
   * @param {boolean} value
   * @returns {void}
   */
  function setShowingNative(doc, value) {
    nativeView.set(doc, value);
  }

  /**
   * @param {Element} node
   * @param {boolean} hidden
   * @returns {void} holds `node` out of view, or puts it back. Nothing is taken
   *   out of the document: the maintainer gets GitHub's own view back whole.
   */
  function setHidden(node, hidden) {
    if (hidden) node.classList.add(HIDDEN_CLASS);
    else node.classList.remove(HIDDEN_CLASS);
  }

  /**
   * Puts the view the document is on into effect: one of the two tables is
   * showing, the toggle is showing in either, and it reads what pressing it
   * does.
   *
   * @param {Document} doc
   * @returns {void}
   */
  function applyVisibility(doc) {
    const container = doc.querySelector('#advisories');
    if (container === null) return;
    const native = showingNative(doc);
    for (const node of nativeControls(container)) setHidden(node, !native);
    const root = doc.getElementById(ROOT_ID);
    if (root === null) return;
    const box = root.querySelector('.bghsa-list-box');
    if (box !== null) setHidden(box, native);
    // The controls act on the extension's table, so they go out of view with it.
    const controls = root.querySelector('.bghsa-list-controls');
    if (controls !== null) setHidden(controls, native);
    const toggle = root.querySelector('.bghsa-list-toggle');
    if (toggle !== null) toggle.textContent = native ? SHOW_TABLE : SHOW_GITHUB;
  }

  /**
   * Where the table goes: in `div#advisories`, above GitHub's query form and the
   * Box holding its segmented control and its rows, so the toggle sits at the
   * top of the list in either view.
   *
   * @param {Document} doc
   * @returns {{ parent: Element, before: Element } | null}
   */
  function anchor(doc) {
    const container = doc.querySelector('#advisories');
    if (container === null) return null;
    const filter = container.querySelector('repository-advisories-filter');
    const before = filter ?? nativeControls(container)[0] ?? null;
    if (before === null || before.parentElement === null) return null;
    return { parent: before.parentElement, before };
  }

  /**
   * @param {Document} doc
   * @returns {void} adds the list surface's stylesheet once.
   */
  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID) !== null) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    (doc.head ?? doc.documentElement ?? doc.body)?.append(style);
  }

  /**
   * Places the table, and holds the view it drew, which is what a read landing
   * and a control changing draw from afterwards. Placement is keyed on the
   * sentinel element, so injecting twice leaves one table and re-injecting after
   * GitHub replaced the subtree puts one back.
   *
   * @param {Document} doc
   * @param {TableView} view
   * @returns {Element | null} the table, or null when the page offers no anchor.
   */
  function injectTable(doc, view) {
    views.set(doc, view);
    const root = buildTable(doc, view);
    const existing = doc.getElementById(ROOT_ID);
    const place = anchor(doc);
    if (place !== null) {
      if (existing !== null) existing.remove();
      place.parent.insertBefore(root, place.before);
    } else if (existing !== null) {
      existing.replaceWith(root);
    } else {
      return null;
    }
    ensureStyle(doc);
    applyVisibility(doc);
    return root;
  }

  /**
   * Whether the document needs the table placed: it carries no sentinel, or it
   * carries one that no longer sits at the anchor because GitHub replaced the
   * subtree under it.
   *
   * @param {Document} doc
   * @returns {boolean}
   */
  function outOfPlace(doc) {
    const root = doc.getElementById(ROOT_ID);
    if (root === null) return true;
    const place = anchor(doc);
    return place !== null && root.nextElementSibling !== place.before;
  }

  /**
   * What the last render of each document assembled. A read landing afterwards
   * rebuilds one row from it, and a control changing draws the rows again from
   * it, so neither goes back to storage or to the page.
   *
   * @type {WeakMap<Document, TableView>}
   */
  const views = new WeakMap();

  /**
   * The page as the last render of each document read it, and null where that
   * render found no advisory list on it.
   *
   * A render reads the page to draw the table, and the refresh that follows
   * needs the same reading to learn which repository the page names. Renders
   * run on every mutation burst GitHub produces and a list page is not small,
   * so the reading is held here and taken back.
   *
   * @type {WeakMap<Document, import('../common/parse-list.js').ParsedList | null>}
   */
  const parses = new WeakMap();

  /**
   * @param {Document} doc
   * @returns {import('../common/parse-list.js').ParsedList | null} the page as
   *   the last render of this document read it, and the page read here where no
   *   render has run on it.
   */
  function pageOf(doc) {
    if (parses.has(doc)) return parses.get(doc) ?? null;
    return globalThis.bghsa.parseList.parseList(doc);
  }

  /**
   * @param {Document} doc
   * @returns {{ owner: string, repo: string } | null} the repository the page
   *   names, and null where it names none. It is the reading the last render
   *   took, so asking costs no second parse of the page.
   */
  function refOf(doc) {
    const parsed = pageOf(doc);
    if (parsed === null || parsed.owner === null || parsed.repo === null) return null;
    return { owner: parsed.owner, repo: parsed.repo };
  }

  /**
   * Reads the page and places the table. Returns null when the document is not
   * an advisory list page, or when it offers no anchor.
   *
   * @param {Document} doc
   * @param {ViewOptions} [options]
   * @returns {Promise<Element | null>}
   */
  async function render(doc, options = {}) {
    const parsed = globalThis.bghsa.parseList.parseList(doc);
    parses.set(doc, parsed);
    if (parsed === null) return null;
    const view = await readView(parsed, options);
    return injectTable(doc, view);
  }

  /**
   * @param {Document} doc
   * @param {string} ghsaId
   * @returns {Element | null} the row standing for that advisory. The identifier
   *   is compared rather than put into a selector, because it is read off a page
   *   GitHub rendered and a selector would have to be escaped to hold it.
   */
  function rowNode(doc, ghsaId) {
    const root = doc.getElementById(ROOT_ID);
    if (root === null) return null;
    for (const item of root.querySelectorAll('[data-bghsa-ghsa]')) {
      if (item.getAttribute('data-bghsa-ghsa') === ghsaId) return item;
    }
    return null;
  }

  /**
   * Puts one advisory's read into the table, where its row stands. The rest of
   * the table is left alone: a pass reads one advisory a second, and rebuilding
   * every row for each of them would throw away what the reader was looking at.
   *
   * The row keeps its place and it keeps showing. A read can change the tier the
   * row sorts in and it can turn up a value the filter that is holding the table
   * does not match, and neither moves the row nor takes it away: the sort and the
   * filter a maintainer picked are settled by the render that follows the pass,
   * so a view is not rearranged under whoever is reading it. The values the
   * filters offer take the read in at once, because a control is not a place to
   * be reading a value the table no longer holds.
   *
   * @param {Document} doc
   * @param {string} ghsaId
   * @param {import('../common/cache.js').CacheEntry} entry
   * @param {ViewOptions} [options]
   * @returns {Promise<boolean>} whether a row was replaced. An advisory the
   *   table is not showing has none, and neither has one a filter is holding out
   *   of view, whose row the table still takes in.
   */
  async function applyEntry(doc, ghsaId, entry, options = {}) {
    const view = views.get(doc);
    const source = view?.sources.get(ghsaId);
    if (view === undefined || source === undefined) return false;
    const row = await viewRow(source, entry, options.at ?? globalThis.bghsa.cache.now());
    // The render built a row for every source, and the source was just found,
    // so the view is holding this advisory's row.
    const at = view.rows.findIndex((held) => held.ghsaId === ghsaId);
    if (at === -1) return false;
    view.rows[at] = row;
    syncFilterOptions(doc);
    const item = rowNode(doc, ghsaId);
    if (item === null) return false;
    item.replaceWith(buildRow(doc, row));
    return true;
  }

  /**
   * @returns {string} what the nodes the extension owns match: the table and its
   *   stylesheet.
   */
  function ownedSelector() {
    return `#${ROOT_ID}, #${STYLE_ID}`;
  }

  /**
   * A render loop for one document, running one pass at a time. A pass is
   * asynchronous because it reads storage, and two running together would each
   * read the page and then write the table, so the one that finished last would
   * put back what it read first. A request arriving while a pass runs takes a
   * pass of its own after it, and further requests during the same pass fold
   * into that one.
   *
   * @param {Document} doc
   * @param {RefreshOptions} [options] What the refresh a pass starts reads and
   *   waits with.
   * @returns {() => Promise<void>}
   */
  function renderLoop(doc, options = {}) {
    let running = false;
    let again = false;
    return async function pass() {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          await render(doc);
        } while (again);
      } finally {
        running = false;
      }
      ensureRefresh(doc, options);
    };
  }

  /**
   * The render loop each document runs its passes through.
   *
   * @type {WeakMap<Document, () => Promise<void>>}
   */
  const loops = new WeakMap();

  /**
   * @param {Document} doc
   * @param {RefreshOptions} [options] What the refresh a pass starts reads and
   *   waits with, used when this document has no loop yet.
   * @returns {() => Promise<void>} that document's loop, made on first use.
   */
  function passFor(doc, options = {}) {
    const held = loops.get(doc);
    if (held !== undefined) return held;
    const loop = renderLoop(doc, options);
    loops.set(doc, loop);
    return loop;
  }

  /**
   * One repository's refresh queue, and whoever is listening to what it reads.
   *
   * @typedef {object} QueueHandle
   * @property {ReturnType<typeof globalThis.bghsa.fetch.createQueue>} queue
   * @property {Set<(ghsaId: string, entry: import('../common/cache.js').CacheEntry) => void>} listening
   */

  /**
   * The one queue each repository's requests go through, by `owner/repo`.
   *
   * One throttled serial queue serves a repository. A second instance would
   * hold the rate privately, and the only thing bounding the two would be each
   * of them re-reading the claim the other persisted, so neither the crawl nor a
   * second surface makes one of its own.
   *
   * @type {Map<string, QueueHandle>}
   */
  const queues = new Map();

  /**
   * @param {{ owner: string, repo: string }} ref
   * @returns {string} what names one repository here. GitHub treats an owner and
   *   a repository name case-insensitively, so two spellings of one repository
   *   are one repository.
   */
  function refKey(ref) {
    return `${ref.owner}/${ref.repo}`.toLowerCase();
  }

  /**
   * @param {{ owner: string, repo: string }} ref
   * @param {RefreshOptions} [options] What the queue reads and waits with, used
   *   when this repository has no queue yet.
   * @returns {QueueHandle} this repository's queue, made on first use.
   */
  function queueFor(ref, options = {}) {
    const key = refKey(ref);
    const held = queues.get(key);
    if (held !== undefined) return held;
    /** @type {QueueHandle['listening']} */
    const listening = new Set();
    const queue = globalThis.bghsa.fetch.createQueue({
      ref,
      storage: options.storage,
      now: options.now,
      wait: options.wait,
      fetch: options.fetch,
      onEntry: (ghsaId, entry) => {
        for (const listener of [...listening]) {
          try {
            listener(ghsaId, entry);
          } catch {
            // One surface failing to draw a row is not a reason to keep the
            // read from the next one.
          }
        }
      },
    });
    const handle = { queue, listening };
    queues.set(key, handle);
    return handle;
  }

  /**
   * The refresh each document has running, and the repository it is for, so that
   * a render the refresh itself asked for cannot start a second one beside it.
   *
   * The repository is held beside the promise because GitHub replaces the turbo
   * frame on a soft navigation and keeps the document. One document therefore
   * covers a list of one repository and then a list of another, and a refresh
   * of the first is not a refresh of the second.
   *
   * @type {WeakMap<
   *   Document,
   *   {
   *     key: string,
   *     queue: ReturnType<typeof globalThis.bghsa.fetch.createQueue>,
   *     started: Promise<RefreshSummary | null>,
   *   }
   * >}
   */
  const running = new WeakMap();

  /**
   * Fills the table in: it walks both open states of the list, then reads the
   * advisories they name, stalest first, at one request per second, with each
   * row updating where it stands as its read lands.
   *
   * Calling it while one is running on the same repository joins that one. A
   * page that has come to name another repository is another refresh.
   *
   * @param {Document} doc
   * @param {RefreshOptions} [options]
   * @returns {Promise<RefreshSummary | null>} null where the page is not an
   *   advisory list, or does not say which repository it belongs to.
   */
  function refresh(doc, options = {}) {
    const parsed = options.parsed ?? globalThis.bghsa.parseList.parseList(doc);
    if (parsed === null || parsed.owner === null || parsed.repo === null) {
      return Promise.resolve(null);
    }
    const ref = { owner: parsed.owner, repo: parsed.repo };
    const key = refKey(ref);
    const held = running.get(doc);
    if (held !== undefined && held.key === key) return held.started;
    const { queue } = queueFor(ref, options);
    const started = fill(doc, parsed, options).finally(() => {
      // A refresh of another repository may have taken the entry over while
      // this one was finishing, and that one is the one still running.
      if (running.get(doc)?.started === started) running.delete(doc);
    });
    running.set(doc, { key, queue, started });
    return started;
  }

  /**
   * One refresh, from the crawl to the last row.
   *
   * A pass an earlier page load left unfinished is taken back before anything
   * is queued, so an advisory that pass had already read is not read again.
   *
   * @param {Document} doc
   * @param {import('../common/parse-list.js').ParsedList} parsed
   * @param {RefreshOptions} options
   * @returns {Promise<RefreshSummary>}
   */
  async function fill(doc, parsed, options) {
    const ref = {
      owner: /** @type {string} */ (parsed.owner),
      repo: /** @type {string} */ (parsed.repo),
    };
    const { queue, listening } = queueFor(ref, options);
    const pass = passFor(doc, options);

    /** @type {Promise<unknown>[]} */
    const updates = [];
    /** @type {(ghsaId: string, entry: import('../common/cache.js').CacheEntry) => void} */
    const listener = (ghsaId, entry) => {
      updates.push(applyEntry(doc, ghsaId, entry, { storage: options.storage }));
    };
    listening.add(listener);

    try {
      await queue.load();
      const crawled = await globalThis.bghsa.crawl.crawl({
        ref,
        queue,
        parsed,
        href: options.href ?? globalThis.location?.href,
        storage: options.storage,
        now: options.now,
        // A page of the list carries advisories the table was not showing, so
        // the whole table is drawn again rather than one row of it.
        onPage: () => {
          void pass();
        },
      });
      await queue.add(crawled.ids);
      const read = await queue.run();
      await Promise.all(updates);
      // The rows are current and each is where it was. This is what puts one
      // whose tier changed back in order.
      await pass();
      return { crawled, read };
    } finally {
      listening.delete(listener);
    }
  }

  /**
   * The repository each document last had a refresh started for, and when.
   *
   * @type {WeakMap<Document, { key: string, at: number }>}
   */
  const refreshed = new WeakMap();

  /**
   * Stops the refresh a document has running for a repository its page no longer
   * names.
   *
   * The rate this extension puts on github.com is one request a second, and the
   * claim the queues hold each other to is written per repository. A pass left
   * running on the repository the page came from holds a claim of its own, so
   * one tab showing one list page sends two requests a second, and half of them
   * read a repository nobody is looking at.
   *
   * The pass stops after the request in flight. What it had left, the advisory
   * that request was for included, stays in the progress entry, and the record
   * of when this document last had a refresh started goes with it: a maintainer
   * who leaves and comes straight back is taking back an unfinished pass, and
   * the threshold that holds off a burst of crawls is not what decides whether
   * they get it.
   *
   * @param {Document} doc
   * @param {NonNullable<ReturnType<typeof running.get>>} held
   * @returns {void}
   */
  function leave(doc, held) {
    void held.queue.stop();
    if (running.get(doc) === held) running.delete(doc);
    refreshed.delete(doc);
  }

  /**
   * Starts the refresh this page's repository is due, where the page is an
   * advisory list and the table is on it, and stops the one its page has left.
   *
   * It hangs off a render rather than off the content script starting, because a
   * list page reached from an advisory with no document load is a render and not
   * a load. That navigation replaces the turbo frame and keeps the document, and
   * the repository the page names changes with it, so what a refresh is
   * remembered against is the repository and not the document alone. A page that
   * came to name another repository, or none at all, is a page whose refresh has
   * nobody left to read for.
   *
   * A refresh running on that repository is left to finish and none is started
   * beside it. One that finished starts again once the staleness threshold has
   * passed: inside it a pass reads nothing, because no entry is stale and no
   * completed walk is due, so a burst of renders costs one refresh and the
   * burst of crawls it could otherwise start is what the threshold holds off.
   *
   * @param {Document} doc
   * @param {RefreshOptions} [options] What the refresh reads and waits with.
   * @returns {void}
   */
  function ensureRefresh(doc, options = {}) {
    const parsed = pageOf(doc);
    const key =
      parsed === null || parsed.owner === null || parsed.repo === null
        ? null
        : refKey({ owner: parsed.owner, repo: parsed.repo });
    const left = running.get(doc);
    if (left !== undefined && left.key !== key) leave(doc, left);
    if (parsed === null || key === null) return;
    if (doc.getElementById(ROOT_ID) === null) return;
    if (running.get(doc)?.key === key) return;
    const at = options.now?.() ?? globalThis.bghsa.cache.now();
    const held = refreshed.get(doc);
    if (held?.key === key && at - held.at < globalThis.bghsa.cache.STALE_MS) return;
    refreshed.set(doc, { key, at });
    void refresh(doc, { ...options, parsed });
  }

  /**
   * Watches the document and runs a pass when the list changes, or when the
   * table is gone or has been left behind.
   *
   * Holding GitHub's controls out of view writes a class and nothing else, and
   * the watcher reads children alone, so no pass sees it.
   *
   * @param {Document} doc
   * @param {() => Promise<void>} [pass]
   * @returns {MutationObserver | null} null where the document offers nothing to
   *   watch or no observer to watch it with.
   */
  function observe(doc, pass = renderLoop(doc)) {
    return globalThis.bghsa.dom.watch(doc, { ownedSelector, outOfPlace, pass });
  }

  /**
   * Renders the table into this page and keeps it there. The first pass and
   * every pass the observer asks for run through one loop, so no two of them
   * read and write the document together.
   *
   * @returns {MutationObserver | null} what is watching the page, and null where
   *   the document offers nothing to watch or no observer to watch it with.
   */
  function start() {
    const doc = globalThis.document;
    const pass = passFor(doc);
    void pass();
    return observe(doc, pass);
  }

  const exported = {
    ROOT_ID,
    STYLE_ID,
    HIDDEN_CLASS,
    setHidden,
    STYLE_TEXT,
    SHOW_GITHUB,
    SHOW_TABLE,
    PARSED_SELECTORS,
    sentenceCase,
    formatTime,
    formatDate,
    advisoryFrom,
    patchStateOf,
    backportsDoneIn,
    cveTextOf,
    AVATAR_PIXELS,
    avatarUrlFor,
    unreadRow,
    viewRow,
    readView,
    chipsFor,
    NO_VALUE,
    DEFAULT_SORT,
    FACETS,
    facetFor,
    sortLabelOf,
    defaultViewState,
    matchesFilter,
    matchesView,
    sortFor,
    applyView,
    filterOptions,
    DEFAULT_SORT_LABEL,
    RESET_LABEL,
    EMPTY_TEXT,
    FACET_ATTRIBUTE,
    viewStateOf,
    setViewState,
    viewCountText,
    buildControls,
    buildBody,
    refreshBody,
    syncFilterOptions,
    metaTextOf,
    countTextOf,
    buildOwners,
    buildRow,
    buildTable,
    nativeControls,
    showingNative,
    setShowingNative,
    applyVisibility,
    anchor,
    ensureStyle,
    outOfPlace,
    injectTable,
    stateOfRow,
    fill,
    listRows,
    refOf,
    render,
    rowNode,
    applyEntry,
    refKey,
    queueFor,
    refresh,
    ensureRefresh,
    ownWrite,
    needsRender,
    renderLoop,
    passFor,
    observe,
    start,
  };

  globalThis.bghsa.table = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  } else {
    start();
  }
})();
