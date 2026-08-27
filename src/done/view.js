'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/dom.js');
  require('../common/text.js');
  require('../common/schema.js');
  require('../common/merge.js');
  require('../common/parse-list.js');
  require('../common/cache.js');
  require('../common/record.js');
  require('../common/derive.js');
  require('../detail/tracking.js');
  require('../detail/edit.js');
  require('../list/table.js');
  require('./corpus.js');
  require('./stats.js');
  require('./csv.js');
}

/**
 * One published or closed advisory, as the view draws it.
 *
 * @typedef {object} DoneRow
 * @property {string} ghsaId
 * @property {string | null} href
 * @property {string | null} title
 * @property {string | null} state As GitHub names it.
 * @property {string | null} severityLabel
 * @property {string | null} openedAt
 * @property {string | null} reporter
 * @property {string | null} closureReason The stored reason, and null where the
 *   advisory carries none or nothing has read it.
 * @property {boolean} read Whether an advisory read backs this row.
 * @property {number | null} observedAt When that read was taken.
 * @property {boolean} writable Whether a reason can be set from here, which
 *   needs a read that says which advisory this is.
 */

/**
 * What the view holds for one document.
 *
 * @typedef {object} Held
 * @property {import('./corpus.js').Corpus | null} corpus What the crawl and the
 *   reads hold, and null before the first page lands.
 * @property {boolean} reading Whether a collection is running.
 * @property {{ owner: string, repo: string } | null} ref
 */

/**
 * What a write from this view goes out with. The page's own fetch is what a
 * maintainer's press uses; a caller hands its own in.
 *
 * @typedef {object} WriteOptions
 * @property {import('../common/write.js').WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 */

/**
 * @typedef {object} CollectOptions
 * @property {import('../common/cache.js').CacheStorage | null} [storage]
 * @property {() => number} [now]
 * @property {(ms: number) => Promise<void>} [wait]
 * @property {import('../common/write.js').WriteFetch} [fetch]
 * @property {import('../common/parse-list.js').ParsedList} [parsed]
 * @property {string} [href]
 */

(() => {
  /** The id of the element the done view owns. */
  const ROOT_ID = 'bghsa-done';

  /** The id of the done view's stylesheet. */
  const STYLE_ID = 'bghsa-done-style';

  /** The view this surface is, as the list page holds the choice. */
  const MODE = 'done';

  /** What the toggle reads while another view is showing. */
  const SHOW_DONE = 'Show done advisories';

  /** What it reads while this one is. */
  const SHOW_OPEN = 'Show open advisories';

  /** What the control that writes the file reads. */
  const EXPORT_LABEL = 'Export CSV';

  /** What the control that writes one closure reason reads. */
  const SAVE_LABEL = 'Save';

  /** What the closure control reads while the advisory carries no reason. */
  const NO_REASON = 'No reason';

  /** What stands where the crawl has found no done advisory. */
  const EMPTY_TEXT = 'No published or closed advisory';

  /** What stands where nothing has read an advisory the list named. */
  const UNREAD_TEXT = 'Unread';

  /** What says the crawl has not reached the last page of both states. */
  const PARTIAL_TEXT = 'Partial crawl';

  /** What says a collection is running. */
  const READING_TEXT = 'Reading';

  /** What the view says where a reason cannot be written from here. */
  const UNREADABLE_MESSAGE =
    'Nothing was written: this extension has not read this advisory, so it cannot tell' +
    ' which advisory to write on.';

  /** Every rule the done view adds to the page. */
  const STYLE_TEXT = [
    '.bghsa-done-chips { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }',
    '.bghsa-done-meta { color: var(--fgColor-muted); }',
    '.bghsa-done-observed { color: var(--fgColor-muted); white-space: nowrap; }',
    '.bghsa-done-empty { color: var(--fgColor-muted); }',
    '.bghsa-done-over { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }',
    '.bghsa-done-groups { display: flex; flex-wrap: wrap; gap: 16px; }',
    '.bghsa-done-group { min-width: 180px; }',
    '.bghsa-done-tally { display: grid; grid-template-columns: auto auto auto; gap: 0 12px; }',
    '.bghsa-done-tally > span { white-space: nowrap; }',
    '.bghsa-done-count, .bghsa-done-ratio { color: var(--fgColor-muted); text-align: right; }',
    '.bghsa-done-spread { display: flex; flex-wrap: wrap; gap: 4px 12px; }',
    '.bghsa-done-uncomputed { color: var(--fgColor-muted); }',
  ].join('\n');

  /**
   * The counts the view draws, in the order it draws them, and how each is
   * ordered inside itself. A month reads in time order; everything else reads
   * commonest first, which is what a ratio is looked at for.
   *
   * @type {readonly { key: string, name: string, by: 'count' | 'value' }[]}
   */
  const COUNT_GROUPS = [
    { key: 'reason', name: 'Closure reason', by: 'count' },
    { key: 'state', name: 'State', by: 'count' },
    { key: 'severity', name: 'Severity', by: 'count' },
    { key: 'month', name: 'Month', by: 'value' },
  ];

  /**
   * What one timing's spread is drawn as, in the order it is drawn.
   *
   * @type {readonly { key: 'min' | 'median' | 'mean' | 'max', name: string }[]}
   */
  const SPREAD = [
    { key: 'min', name: 'Min' },
    { key: 'median', name: 'Median' },
    { key: 'mean', name: 'Mean' },
    { key: 'max', name: 'Max' },
  ];

  /** What the view holds for each document. @type {WeakMap<Document, Held>} */
  const held = new WeakMap();

  /**
   * The collection each document has running, and the repository it is for.
   *
   * @type {WeakMap<Document, { key: string, started: Promise<unknown> }>}
   */
  const running = new WeakMap();

  /**
   * @param {Document} doc
   * @returns {Held}
   */
  function stateOf(doc) {
    const found = held.get(doc);
    if (found !== undefined) return found;
    /** @type {Held} */
    const fresh = { corpus: null, reading: false, ref: null };
    held.set(doc, fresh);
    return fresh;
  }

  /**
   * @param {Document} doc
   * @param {Partial<Held>} patch
   * @returns {Held}
   */
  function setState(doc, patch) {
    const next = { ...stateOf(doc), ...patch };
    held.set(doc, next);
    return next;
  }

  /** How every surface builds an element. */
  const element = globalThis.bghsa.dom.element;

  /**
   * A dimmed chip. Colour is kept for a condition a maintainer has to act on
   * now, and nothing this view shows is one: a crawl still running finishes on
   * its own, and an advisory nobody has read is read next.
   *
   * @param {Document} doc
   * @param {string} text
   * @returns {Element}
   */
  function chip(doc, text) {
    return element(doc, 'span', 'Label Label--secondary', text);
  }

  /**
   * @param {string} key
   * @returns {string} a camel-cased key as a label. A timing this reader does
   *   not compute is named from its key, so one arriving later is drawn without
   *   anything here being told about it.
   */
  function nameOf(key) {
    const words = key.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
    return globalThis.bghsa.table.sentenceCase(words);
  }

  /** How many milliseconds are in each unit a duration is read in. */
  const DAY_MS = 24 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;
  const MINUTE_MS = 60 * 1000;

  /**
   * @param {number | null} ms
   * @returns {string} a duration in the two largest units it reaches, and a dash
   *   where there is none. A timing with nothing behind it is not a zero.
   */
  function formatDuration(ms) {
    if (ms === null || !Number.isFinite(ms)) return '—';
    if (ms >= DAY_MS) {
      return `${Math.floor(ms / DAY_MS)}d ${Math.floor((ms % DAY_MS) / HOUR_MS)}h`;
    }
    if (ms >= HOUR_MS) {
      return `${Math.floor(ms / HOUR_MS)}h ${Math.floor((ms % HOUR_MS) / MINUTE_MS)}m`;
    }
    if (ms >= MINUTE_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
    return `${Math.round(ms / 1000)}s`;
  }

  /**
   * @param {number} ratio
   * @returns {string}
   */
  function formatRatio(ratio) {
    return `${Math.round(ratio * 100)}%`;
  }

  /**
   * The stored closure reason on one advisory.
   *
   * @param {import('../common/parse-detail.js').ParsedDetail | null} advisory
   * @returns {string | null}
   */
  function reasonOf(advisory) {
    return advisory === null ? null : globalThis.bghsa.stats.closureReasonOf(advisory);
  }

  /**
   * One row per corpus member, in the order the corpus holds them.
   *
   * @param {import('./corpus.js').Corpus | null} corpus
   * @returns {DoneRow[]}
   */
  function rowsOf(corpus) {
    if (corpus === null) return [];
    return corpus.members.map((member) => {
      const advisory = member.advisory;
      const state = advisory?.state ?? member.row.state ?? member.state;
      return {
        ghsaId: member.ghsaId,
        href: member.row.href,
        title: advisory?.title ?? member.row.title,
        state,
        severityLabel:
          advisory?.severityLabel ??
          advisory?.severity ??
          member.row.severityLabel ??
          member.row.severity,
        openedAt: advisory?.reportedAt ?? member.row.openedAt,
        reporter: advisory?.reporter ?? member.row.reporter,
        closureReason: reasonOf(advisory),
        read: advisory !== null,
        observedAt: member.observedAt,
        writable: advisory !== null && advisory.ref !== null,
      };
    });
  }

  /**
   * @param {import('./corpus.js').Corpus} corpus
   * @param {string} ghsaId
   * @returns {import('./corpus.js').CorpusMember | null}
   */
  function memberOf(corpus, ghsaId) {
    return corpus.members.find((member) => member.ghsaId === ghsaId) ?? null;
  }

  /**
   * The line GitHub's own row carries under the title.
   *
   * @param {DoneRow} row
   * @returns {string}
   */
  function metaTextOf(row) {
    const parts = [row.ghsaId];
    const opened = globalThis.bghsa.text.formatDate(row.openedAt);
    if (opened !== null) parts.push(`opened ${opened}`);
    if (row.reporter !== null) parts.push(`by ${row.reporter}`);
    return parts.join(' ');
  }

  /**
   * The stored state of one advisory, and everything a save from here needs. It
   * is `edit.contextFor`, which is what the panel builds from on the advisory's
   * own page, with the render pass this surface runs. The advisory it reads is
   * the one the crawl read and the cache holds, so the members and the branches
   * this page has seen reach the pickers the same way the panel's do.
   *
   * @param {Document} doc
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @param {WriteOptions} [options]
   * @returns {Promise<import('../detail/edit.js').EditorContext>}
   */
  function contextFor(doc, advisory, options = {}) {
    return globalThis.bghsa.edit.contextFor(advisory, {
      rerender: () => {
        draw(doc);
      },
      ...options,
    });
  }

  /**
   * Writes a closure reason onto one advisory from here.
   *
   * REQUIREMENTS.md section 10 has the reason settable retroactively, and it
   * goes out through the same store and the same writer every other stored track
   * uses: the value is staged against the advisory, and the save fetches the
   * advisory page, merges onto the state that page carries, and refuses on a
   * rival claim. Nothing here writes a comment of its own.
   *
   * @param {Document} doc
   * @param {string} ghsaId
   * @param {string | null} reason
   * @param {WriteOptions} [options]
   * @returns {Promise<import('../detail/state.js').StateWriteResult | null>} null
   *   where the view holds no read of that advisory.
   */
  async function setReason(doc, ghsaId, reason, options) {
    const corpus = stateOf(doc).corpus;
    const advisory = corpus === null ? null : (memberOf(corpus, ghsaId)?.advisory ?? null);
    if (advisory === null || advisory.ref === null) {
      notes.set(ghsaId, { ok: false, message: UNREADABLE_MESSAGE });
      draw(doc);
      return null;
    }
    notes.delete(ghsaId);
    const edit = globalThis.bghsa.edit;
    const context = await contextFor(doc, advisory, options);
    edit.stage(keyOf(advisory), { closureReason: reason });
    return edit.save(context);
  }

  /**
   * What the view says about the last press on one advisory, where the editing
   * store holds nothing to say. It holds what a save reports; this holds the
   * refusals that never reach one.
   *
   * @type {Map<string, { ok: boolean, message: string }>}
   */
  const notes = new Map();

  /**
   * @param {DoneRow} row
   * @param {import('./corpus.js').Corpus | null} corpus
   * @returns {{ ok: boolean, message: string } | null} what the row says about
   *   the last press on it.
   */
  function noteFor(row, corpus) {
    const own = notes.get(row.ghsaId);
    if (own !== undefined) return own;
    const advisory = corpus === null ? null : (memberOf(corpus, row.ghsaId)?.advisory ?? null);
    if (advisory === null) return null;
    return globalThis.bghsa.edit.results.get(keyOf(advisory)) ?? null;
  }

  /**
   * The closure control on one row: what the advisory carries, or what a press
   * on this page has staged and not yet written.
   *
   * @param {Document} doc
   * @param {DoneRow} row
   * @param {import('./corpus.js').Corpus | null} corpus
   * @returns {Element}
   */
  function buildClosure(doc, row, corpus) {
    const box = element(doc, 'div', 'd-flex flex-items-center bghsa-done-closure');
    const edit = globalThis.bghsa.edit;
    const advisory = corpus === null ? null : (memberOf(corpus, row.ghsaId)?.advisory ?? null);
    const staged =
      advisory === null ? undefined : edit.editsFor(edit.keyOf(advisory)).closureReason;
    const current = staged === undefined ? row.closureReason : staged;

    const control = element(doc, 'select', 'form-select select-sm mr-1 bghsa-done-reason');
    control.setAttribute('aria-label', 'Closure reason');
    const blank = element(doc, 'option', '', NO_REASON);
    blank.setAttribute('value', '');
    if (current === null) blank.setAttribute('selected', '');
    control.append(blank);
    const known = globalThis.bghsa.schema.CLOSURE_REASONS;
    const offered = current !== null && !known.includes(current) ? [...known, current] : known;
    for (const value of offered) {
      const option = element(doc, 'option', '', globalThis.bghsa.table.sentenceCase(value));
      option.setAttribute('value', value);
      if (value === current) option.setAttribute('selected', '');
      control.append(option);
    }

    const save = element(doc, 'button', 'btn btn-sm bghsa-done-save', SAVE_LABEL);
    save.setAttribute('type', 'button');
    if (!row.writable) save.setAttribute('disabled', '');

    control.addEventListener('change', () => {
      if (advisory === null) return;
      const picked = /** @type {{ value?: unknown }} */ (/** @type {unknown} */ (control)).value;
      const value = typeof picked === 'string' ? picked : '';
      edit.stage(keyOf(advisory), { closureReason: value === '' ? null : value });
    });
    save.addEventListener('click', () => {
      const picked = /** @type {{ value?: unknown }} */ (/** @type {unknown} */ (control)).value;
      const value = typeof picked === 'string' ? picked : '';
      void setReason(doc, row.ghsaId, value === '' ? null : value);
    });

    box.append(control);
    box.append(save);
    return box;
  }

  /**
   * One row. It carries none of the classes `parse-list` keys on, so a re-read of
   * the page cannot take it for one of GitHub's.
   *
   * @param {Document} doc
   * @param {DoneRow} row
   * @param {import('./corpus.js').Corpus | null} corpus
   * @returns {Element}
   */
  function buildRow(doc, row, corpus) {
    const item = element(doc, 'li', 'Box-row d-flex flex-items-start bghsa-done-row');
    item.setAttribute('data-bghsa-ghsa', row.ghsaId);

    const main = element(doc, 'div', 'flex-auto lh-condensed');
    const link = element(
      doc,
      'a',
      'Link--primary v-align-middle no-underline h4',
      row.title ?? row.ghsaId
    );
    if (row.href !== null) link.setAttribute('href', row.href);
    main.append(link);
    main.append(element(doc, 'div', 'mt-1 text-small bghsa-done-meta', metaTextOf(row)));

    const chips = element(doc, 'div', 'mt-1 bghsa-done-chips');
    if (row.state !== null) chips.append(chip(doc, globalThis.bghsa.table.sentenceCase(row.state)));
    if (row.severityLabel !== null) {
      chips.append(chip(doc, globalThis.bghsa.table.sentenceCase(row.severityLabel)));
    }
    if (!row.read) chips.append(chip(doc, UNREAD_TEXT));
    main.append(chips);

    const note = noteFor(row, corpus);
    if (note !== null) {
      main.append(element(doc, 'div', 'mt-1 text-small bghsa-done-note', note.message));
    }
    item.append(main);

    const closure = element(doc, 'div', 'pl-2 flex-shrink-0');
    closure.append(buildClosure(doc, row, corpus));
    item.append(closure);

    item.append(
      element(
        doc,
        'div',
        'pl-2 flex-shrink-0 text-small bghsa-done-observed',
        `Observed ${globalThis.bghsa.table.formatTime(row.observedAt) ?? 'never'}`
      )
    );
    return item;
  }

  /**
   * How many advisories GitHub's own state tabs counted, and null where either
   * tab went unread. It is the corpus size before any crawl, so it is what says
   * whether the members drawn here are all of them.
   *
   * @param {Record<string, number | null>} expected
   * @returns {number | null}
   */
  function expectedTotal(expected) {
    let total = 0;
    for (const state of globalThis.bghsa.corpus.DONE_STATES) {
      const count = expected[state];
      if (count === null || count === undefined) return null;
      total += count;
    }
    return total;
  }

  /**
   * What every statistic below is over. A partial count read as a whole one is
   * the thing this stops, so the corpus size, how much of it no read backs, and
   * whether the crawl finished are all beside the numbers.
   *
   * @param {Document} doc
   * @param {import('./stats.js').Summary} summary
   * @param {boolean} reading
   * @returns {Element}
   */
  function buildOver(doc, summary, reading) {
    const box = element(doc, 'div', 'mt-1 bghsa-done-over');
    box.append(chip(doc, `Over ${countTextOf(summary.corpus)}`));
    if (summary.unread > 0) box.append(chip(doc, `${summary.unread} unread`));
    const total = expectedTotal(summary.expected);
    if (total !== null && total !== summary.corpus) box.append(chip(doc, `${total} on GitHub`));
    if (!summary.complete) box.append(chip(doc, PARTIAL_TEXT));
    if (reading) box.append(chip(doc, READING_TEXT));
    return box;
  }

  /**
   * One count, with what it is over beside it.
   *
   * @param {Document} doc
   * @param {{ key: string, name: string, by: 'count' | 'value' }} group
   * @param {import('./stats.js').Tally} tally
   * @returns {Element}
   */
  function buildTally(doc, group, tally) {
    const box = element(doc, 'div', 'bghsa-done-group');
    box.setAttribute('data-bghsa-count', group.key);
    box.append(element(doc, 'div', 'text-bold', group.name));
    box.append(
      element(doc, 'div', 'text-small bghsa-done-meta', `${tally.counted} of ${tally.corpus}`)
    );
    const grid = element(doc, 'div', 'mt-1 text-small bghsa-done-tally');
    const entries = Object.entries(tally.counts).sort((left, right) =>
      group.by === 'value'
        ? left[0].localeCompare(right[0])
        : right[1] - left[1] || left[0].localeCompare(right[0])
    );
    for (const [value, count] of entries) {
      grid.append(element(doc, 'span', '', globalThis.bghsa.table.sentenceCase(value)));
      grid.append(element(doc, 'span', 'bghsa-done-count', String(count)));
      grid.append(
        element(doc, 'span', 'bghsa-done-ratio', formatRatio(tally.ratios[value] ?? 0))
      );
    }
    if (tally.missing > 0) {
      // The members carrying no value are counted where the reader can see
      // them, so a ratio over the rest is not read as a ratio over the corpus.
      grid.append(element(doc, 'span', 'bghsa-done-meta bghsa-done-missing', 'None'));
      grid.append(element(doc, 'span', 'bghsa-done-count', String(tally.missing)));
      grid.append(element(doc, 'span', 'bghsa-done-ratio', '—'));
    }
    box.append(grid);
    return box;
  }

  /**
   * One timing, with what it is over and what it left out beside it.
   *
   * @param {Document} doc
   * @param {{ key: string, name: string }} timing
   * @param {import('./stats.js').Timing} held
   * @returns {Element}
   */
  function buildTiming(doc, timing, held) {
    const box = element(doc, 'div', 'bghsa-done-group');
    box.setAttribute('data-bghsa-timing', timing.key);
    box.append(element(doc, 'div', 'text-bold', timing.name));
    box.append(
      element(
        doc,
        'div',
        'text-small bghsa-done-meta',
        `${held.counted} of ${held.corpus}, ${held.omitted} omitted`
      )
    );
    const spread = element(doc, 'div', 'mt-1 text-small bghsa-done-spread');
    for (const each of SPREAD) {
      const cell = element(doc, 'span', '');
      cell.append(element(doc, 'span', 'bghsa-done-meta', `${each.name} `));
      cell.append(element(doc, 'span', 'bghsa-done-value', formatDuration(held[each.key])));
      spread.append(cell);
    }
    box.append(spread);
    return box;
  }

  /**
   * The statistics of REQUIREMENTS.md section 10, over the corpus the view
   * holds. A timing whose event this extension cannot observe is named and left
   * uncomputed, because a reader owed a metric is owed the reason it is absent.
   *
   * @param {Document} doc
   * @param {import('./stats.js').Summary} summary
   * @param {boolean} reading
   * @returns {Element}
   */
  function buildStats(doc, summary, reading) {
    const box = element(doc, 'div', 'Box-body bghsa-done-stats');
    box.append(element(doc, 'div', 'text-bold', 'Statistics'));
    box.append(buildOver(doc, summary, reading));

    const counts = element(doc, 'div', 'mt-2 bghsa-done-groups bghsa-done-counts');
    for (const group of COUNT_GROUPS) {
      const tally = summary.counts[group.key];
      if (tally === undefined) continue;
      counts.append(buildTally(doc, group, tally));
    }
    box.append(counts);

    const timings = element(doc, 'div', 'mt-2 bghsa-done-groups bghsa-done-timings');
    for (const timing of globalThis.bghsa.stats.TIMINGS) {
      const found = summary.timings[timing.key];
      if (found === undefined) continue;
      timings.append(buildTiming(doc, timing, found));
    }
    box.append(timings);

    for (const [key, why] of Object.entries(summary.uncomputed)) {
      const line = element(doc, 'div', 'mt-2 text-small bghsa-done-uncomputed');
      line.setAttribute('data-bghsa-uncomputed', key);
      line.append(element(doc, 'span', 'text-bold', `${nameOf(key)}: `));
      line.append(element(doc, 'span', '', why));
      box.append(line);
    }
    return box;
  }

  /**
   * The rows, and what stands where there are none.
   *
   * @param {Document} doc
   * @param {readonly DoneRow[]} rows
   * @param {import('./corpus.js').Corpus | null} corpus
   * @param {boolean} reading
   * @returns {Element}
   */
  function buildBody(doc, rows, corpus, reading) {
    const list = element(doc, 'ul', 'bghsa-done-rows');
    if (rows.length === 0) {
      list.append(
        element(doc, 'li', 'Box-row bghsa-done-empty', reading ? READING_TEXT : EMPTY_TEXT)
      );
      return list;
    }
    for (const row of rows) list.append(buildRow(doc, row, corpus));
    return list;
  }

  /**
   * The done view: a Box carrying the count, the export, the statistics, and the
   * advisories.
   *
   * @param {Document} doc
   * @param {Held} state
   * @returns {Element}
   */
  function buildView(doc, state) {
    const root = element(doc, 'div', 'Box mb-3 bghsa-done-box');
    root.id = ROOT_ID;
    root.setAttribute('data-bghsa-done', '1');

    const header = element(
      doc,
      'div',
      'Box-header d-flex flex-items-center flex-justify-between bghsa-done-header'
    );
    const named = element(doc, 'div', 'd-flex flex-items-center');
    named.append(element(doc, 'strong', '', 'Done'));
    const rows = rowsOf(state.corpus);
    named.append(element(doc, 'span', 'ml-2 text-normal bghsa-done-count', countTextOf(rows.length)));
    header.append(named);

    const exportControl = element(doc, 'button', 'btn btn-sm bghsa-done-export', EXPORT_LABEL);
    exportControl.setAttribute('type', 'button');
    if (state.corpus === null || rows.length === 0) exportControl.setAttribute('disabled', '');
    exportControl.addEventListener('click', () => {
      exportCsv(doc);
    });
    header.append(exportControl);
    root.append(header);

    if (state.corpus !== null) {
      root.append(buildStats(doc, globalThis.bghsa.stats.summarize(state.corpus), state.reading));
    }
    root.append(buildBody(doc, rows, state.corpus, state.reading));
    return root;
  }

  /**
   * Writes the corpus out as a file the browser takes. It is built here in the
   * page from what the view already holds: nothing is fetched and nothing is
   * sent anywhere.
   *
   * @param {Document} doc
   * @param {import('./csv.js').DownloadOptions} [options]
   * @returns {string | null} the blob URL the press went to, and null where
   *   there is nothing to write or no way to hand it over.
   */
  function exportCsv(doc, options) {
    const state = stateOf(doc);
    if (state.corpus === null || state.ref === null) return null;
    const csv = globalThis.bghsa.csv;
    const at = globalThis.bghsa.cache.now();
    return csv.download(
      doc,
      csv.filenameFor(state.ref, at),
      csv.toCsv(state.corpus),
      options
    );
  }

  /** How the list surface holds a node out of view. */
  const setHidden = globalThis.bghsa.table.setHidden;

  /**
   * @param {Document} doc
   * @returns {void} adds the done view's stylesheet once.
   */
  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID) !== null) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    (doc.head ?? doc.documentElement ?? doc.body)?.append(style);
  }

  /**
   * Draws the view into the list surface, under the bar both toggles sit on.
   *
   * The view is rebuilt whole. What a maintainer picked and has not written is
   * in the editing store and not in the control, so a rebuilt control comes back
   * holding it.
   *
   * @param {Document} doc
   * @returns {Element | null} the view, and null where the list surface is not
   *   on the page.
   */
  function draw(doc) {
    const table = globalThis.bghsa.table;
    const surface = doc.getElementById(table.ROOT_ID);
    if (surface === null) return null;
    const root = buildView(doc, stateOf(doc));
    const existing = doc.getElementById(ROOT_ID);
    if (existing !== null) existing.replaceWith(root);
    else surface.append(root);
    ensureStyle(doc);
    setHidden(root, table.viewMode(doc) !== MODE);
    return root;
  }

  /**
   * The toggle this surface puts on the bar, beside the one that restores
   * GitHub's view.
   *
   * @param {Document} doc
   * @returns {Element}
   */
  function buildToggle(doc) {
    const node = element(doc, 'button', 'btn btn-sm ml-2 bghsa-done-toggle', SHOW_DONE);
    node.setAttribute('type', 'button');
    node.addEventListener('click', () => {
      toggle(doc);
    });
    return node;
  }

  /**
   * Switches between this view and the table. The list surface holds which of
   * the three views the page is on, so a press here cannot leave two showing.
   *
   * @param {Document} doc
   * @returns {void}
   */
  function toggle(doc) {
    const table = globalThis.bghsa.table;
    const wanted = table.viewMode(doc) === MODE ? table.VIEW_TABLE : MODE;
    table.setViewMode(doc, wanted);
    table.applyVisibility(doc);
    if (wanted === MODE) void collect(doc);
  }

  /**
   * Draws the view under whichever of the three views the page is on.
   *
   * @param {Document} doc
   * @param {string} mode
   * @returns {void}
   */
  function show(doc, mode) {
    const root = draw(doc);
    const toggleNode = doc.querySelector(`#${globalThis.bghsa.table.ROOT_ID} .bghsa-done-toggle`);
    if (toggleNode !== null) toggleNode.textContent = mode === MODE ? SHOW_OPEN : SHOW_DONE;
    if (root !== null) setHidden(root, mode !== MODE);
  }

  /**
   * Walks the done states and reads the advisories they name.
   *
   * The crawl is a hundred-odd reads on a repository like `containerd/containerd`
   * and it goes through the queue the list surface already holds for this
   * repository, taken from `table.queueFor`. One throttled serial queue serves a
   * repository: a second instance would hold the rate privately, so both
   * surfaces spend the same one request a second and the same persisted claim.
   *
   * It starts when the view is first asked for, not when the page loads, because
   * it is a hundred requests and nobody has asked for them yet.
   *
   * @param {Document} doc
   * @param {CollectOptions} [options]
   * @returns {Promise<import('./corpus.js').Corpus | null>} null where the page
   *   is not an advisory list, or does not say which repository it belongs to.
   */
  function collect(doc, options = {}) {
    const table = globalThis.bghsa.table;
    const parsed = options.parsed ?? globalThis.bghsa.parseList.parseList(doc);
    if (parsed === null || parsed.owner === null || parsed.repo === null) {
      return Promise.resolve(null);
    }
    const ref = { owner: parsed.owner, repo: parsed.repo };
    const key = table.refKey(ref);
    const already = running.get(doc);
    if (already !== undefined && already.key === key) {
      return /** @type {Promise<import('./corpus.js').Corpus | null>} */ (already.started);
    }
    const { queue, listening } = table.queueFor(ref, options);

    /** @type {(ghsaId: string, entry: import('../common/cache.js').CacheEntry) => void} */
    const listener = (ghsaId, entry) => {
      // A read landing fills one member in where it stands, so the corpus grows
      // current under the reader rather than in one jump at the end.
      const corpus = stateOf(doc).corpus;
      if (corpus === null) return;
      const member = memberOf(corpus, ghsaId);
      if (member === null) return;
      const advisory = globalThis.bghsa.record.advisoryFrom(entry.record);
      if (advisory === null) return;
      member.advisory = advisory;
      member.observedAt = entry.observedAt;
      corpus.unread = corpus.members
        .filter((each) => each.advisory === null)
        .map((each) => each.ghsaId);
      draw(doc);
    };
    listening.add(listener);

    setState(doc, { reading: true, ref });
    draw(doc);
    const started = globalThis.bghsa.corpus
      .collect({
        ref,
        queue,
        parsed,
        href: options.href ?? globalThis.location?.href,
        storage: options.storage,
        now: options.now,
        onPage: (corpus) => {
          setState(doc, { corpus });
          draw(doc);
        },
      })
      .then((collected) => {
        setState(doc, { corpus: collected.corpus });
        return collected.corpus;
      })
      .finally(() => {
        listening.delete(listener);
        setState(doc, { reading: false });
        if (running.get(doc)?.started === started) running.delete(doc);
        draw(doc);
      });
    running.set(doc, { key, started });
    return started;
  }

  const exported = {
    ROOT_ID,
    STYLE_ID,
    MODE,
    SHOW_DONE,
    SHOW_OPEN,
    EXPORT_LABEL,
    SAVE_LABEL,
    NO_REASON,
    EMPTY_TEXT,
    UNREAD_TEXT,
    PARTIAL_TEXT,
    READING_TEXT,
    UNREADABLE_MESSAGE,
    STYLE_TEXT,
    COUNT_GROUPS,
    SPREAD,
    notes,
    stateOf,
    setState,
    nameOf,
    formatDuration,
    formatRatio,
    rowsOf,
    memberOf,
    metaTextOf,
    expectedTotal,
    contextFor,
    buildClosure,
    buildRow,
    buildTally,
    buildTiming,
    buildStats,
    buildBody,
    buildView,
    exportCsv,
    ensureStyle,
    draw,
    buildToggle,
    toggle,
    show,
    setReason,
    collect,
  };

  globalThis.bghsa.view = exported;

  // The list surface holds the choice of view and the bar both toggles sit on,
  // so this one takes its place there as soon as it loads.
  globalThis.bghsa.table.addSurface({ control: buildToggle, show });

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
