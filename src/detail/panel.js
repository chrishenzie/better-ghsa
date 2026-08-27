'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/dom.js');
  require('../common/text.js');
  require('../common/trust.js');
  require('../common/merge.js');
  require('../common/parse-detail.js');
  require('../common/derive.js');
  require('../common/members.js');
  require('../common/branches.js');
  require('./tracking.js');
  require('./comments.js');
  require('./preserve.js');
  require('./edit.js');
}

(() => {
  /** The id of the sentinel element the extension owns. */
  const PANEL_ID = 'bghsa-detail-panel';

  /** The id of the extension's global stylesheet. */
  const STYLE_ID = 'bghsa-style';

  /** Every rule the extension adds to the page. */
  const STYLE_TEXT = [
    '.bghsa-chips { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }',
    '.bghsa-label { flex: 0 0 9rem; }',
    '.bghsa-field-label { flex: 0 0 9rem; }',
    '.bghsa-editor-summary { cursor: pointer; }',
    '.bghsa-missing { font-style: italic; }',
    '.bghsa-confirmed { display: flex; flex-direction: column; gap: 6px; }',
    '.bghsa-confirmation-name { flex: 0 0 13rem; }',
    '.bghsa-confirmation-note { color: var(--fgColor-muted); }',
    '.bghsa-since { color: var(--fgColor-muted); }',
    '.bghsa-tone-attention { color: var(--fgColor-default);' +
      ' background-color: var(--bgColor-attention);' +
      ' border-color: var(--bgColor-attention); }',
    '.bghsa-tone-danger { color: var(--fgColor-default);' +
      ' background-color: var(--bgColor-danger);' +
      ' border-color: var(--bgColor-danger); }',
  ].join('\n');

  /** The text shown in place of a value that could not be read. */
  const MISSING = 'missing';

  /** How every surface builds an element. */
  const element = globalThis.bghsa.dom.element;

  /**
   * The names of the values the extension could not read from the page. An empty
   * list means every value it set out to read is in hand.
   *
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @param {import('../common/derive.js').DerivedState} derived
   * @returns {string[]}
   */
  function missingValues(advisory, derived) {
    /** @type {string[]} */
    const missing = [];
    if (advisory.ghsaId === null) missing.push('advisory id');
    if (advisory.state === null) missing.push('state');
    if (advisory.severity === null) missing.push('severity');
    // The confirmations bind to these, so a track cannot be judged without them.
    // The scoring sources are named by whether the form carries them: a severity
    // nobody has set and a vector nobody has filled in are a scoring state, and
    // a field this extension cannot find is a value it did not read.
    if (advisory.title === null) missing.push('advisory title');
    if (advisory.description === null) missing.push('advisory description');
    if (!advisory.severityFieldPresent) missing.push('severity selection');
    if (!advisory.cvssV3Present) missing.push('CVSS vector');
    if (advisory.reporter === null) missing.push('reporter');
    if (advisory.reportedAt === null) missing.push('report time');
    if (advisory.descriptionOriginal === null) missing.push('description provenance');
    if (derived.patch.incomplete) missing.push('pull request state');
    return missing;
  }

  /**
   * A chip. A tone names a Primer state token, and a chip with no tone is
   * neutral.
   *
   * @param {Document} doc
   * @param {string} text
   * @param {'attention' | 'danger'} [tone]
   * @returns {Element}
   */
  function chip(doc, text, tone) {
    const classes = ['Label', 'Label--secondary'];
    if (tone !== undefined) classes.push(`bghsa-tone-${tone}`);
    return element(doc, 'span', classes.join(' '), text);
  }

  /**
   * A stored value as a chip reads it. GitHub sentence-cases its own chips, and
   * a track is stored in the vocabulary REQUIREMENTS.md section 6 sets, which is
   * lower case. Only the first letter is touched, so a value this extension does
   * not interpret still reaches the reader as it stands.
   *
   * @param {string} value
   * @returns {string}
   */
  function sentenceCase(value) {
    return value === '' ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
  }

  /**
   * @param {Document} doc
   * @param {string} label
   * @returns {{ row: Element, body: Element }} a Box row and the element its
   *   value goes in.
   */
  function row(doc, label) {
    const container = element(doc, 'div', 'Box-row d-flex flex-items-baseline');
    container.append(element(doc, 'div', 'text-bold bghsa-label', label));
    const body = element(doc, 'div', 'flex-auto');
    container.append(body);
    return { row: container, body };
  }

  /**
   * @param {Document} doc
   * @param {string} text
   * @returns {Element}
   */
  function warning(doc, text) {
    return element(doc, 'div', 'flash flash-warn mt-2 bghsa-warning', text);
  }

  /**
   * The chip row, which is visible whatever else the panel shows. A derived
   * signal is a chip only while it is firing, because it is there to say that
   * something needs attention.
   *
   * The advisory page carries the state, the severity, and the CVE above the
   * panel, so the row does not repeat them. A value of theirs the extension
   * could not read is named in the incomplete banner.
   *
   * @param {Document} doc
   * @param {import('../common/derive.js').DerivedState} derived
   * @param {boolean} embargoOverdue Whether the embargo's lift date has gone by
   *   on an advisory that is not published.
   * @returns {Element}
   */
  function buildChips(doc, derived, embargoOverdue) {
    const header = element(doc, 'div', 'Box-header bghsa-chips');
    header.append(element(doc, 'strong', 'mr-2', 'Better GHSA'));
    if (derived.neverReviewed) header.append(chip(doc, 'Never reviewed', 'danger'));
    if (derived.newActivity) header.append(chip(doc, 'New activity', 'attention'));
    if (embargoOverdue) header.append(chip(doc, 'Embargo overdue', 'danger'));
    return header;
  }

  /**
   * What the confirmation chip reads. A drifted track reverted to unconfirmed
   * and reads as unconfirmed, and looks like every other unconfirmed track:
   * one state, one appearance. Every confirmation chip is dimmed, as the chips
   * GitHub's own sidebar carries are.
   *
   * @param {import('./tracking.js').Confirmation} state
   * @returns {string}
   */
  function confirmationText(state) {
    if (state.status === 'confirmed') return 'Confirmed';
    if (state.status === 'unreadable') return 'Not checked';
    return 'Not confirmed';
  }

  /**
   * Who acted and when, as a sentence. A record naming no login reads as a
   * maintainer, because the confirmation stands whether or not the login
   * survived.
   *
   * @param {import('./tracking.js').Confirmation} state
   * @param {string} action
   * @returns {string}
   */
  function attribution(state, action) {
    const who = state.by === null ? 'A maintainer' : state.by;
    const at = globalThis.bghsa.text.formatTime(state.at);
    return at === null ? `${who} ${action}.` : `${who} ${action} on ${at}.`;
  }

  /**
   * @param {import('./tracking.js').Confirmation} state
   * @returns {string | null} what the panel says beside the chip. A drifted
   *   track says nothing: it is unconfirmed, and who confirmed some earlier
   *   value does not change that.
   */
  function confirmationNote(state) {
    if (state.status === 'confirmed') return attribution(state, 'confirmed this value');
    if (state.status === 'unreadable') {
      return `${attribution(state, 'confirmed a value')} The value on the page could not be read.`;
    }
    return null;
  }

  /**
   * The confirmations, which are what the panel is for: whether the advisory
   * text was rewritten for publication and whether the score was approved.
   *
   * @param {Document} doc
   * @param {import('./tracking.js').TrackingView} tracking
   * @returns {Element}
   */
  function buildConfirmations(doc, tracking) {
    const container = element(doc, 'div', 'Box-row bghsa-confirmed');
    container.append(element(doc, 'div', 'text-bold', 'Confirmed by a maintainer'));
    // The tracks in the order tracking names them, which is the order the
    // panel shows them in.
    for (const track of globalThis.bghsa.tracking.CONFIRMATION_TRACKS) {
      const state = tracking[track.key];
      const line = element(doc, 'div', 'bghsa-chips bghsa-confirmation');
      line.append(element(doc, 'span', 'bghsa-confirmation-name', track.name));
      line.append(chip(doc, confirmationText(state)));
      const note = confirmationNote(state);
      if (note !== null) line.append(element(doc, 'span', 'bghsa-confirmation-note', note));
      container.append(line);
    }
    return container;
  }

  /**
   * A row carrying one chip per value.
   *
   * @param {Document} doc
   * @param {string} label
   * @param {string[]} values
   * @returns {Element}
   */
  function chipRow(doc, label, values) {
    const built = row(doc, label);
    built.body.className = 'flex-auto bghsa-chips';
    for (const value of values) built.body.append(chip(doc, value));
    return built.row;
  }

  /**
   * The stored tracks. A track appears only where the snapshot says something
   * about it, so an advisory nobody has set a value on carries no rows here.
   *
   * @param {Document} doc
   * @param {import('./tracking.js').TrackingView} tracking
   * @param {boolean} embargoOverdue Whether the embargo's lift date has gone by
   *   on an advisory that is not published.
   * @returns {Element[]}
   */
  function buildTracks(doc, tracking, embargoOverdue) {
    /** @type {Element[]} */
    const rows = [];

    if (tracking.triage !== null) {
      const built = row(doc, 'Triage');
      built.body.className = 'flex-auto bghsa-chips';
      built.body.append(chip(doc, sentenceCase(tracking.triage)));
      const since = globalThis.bghsa.text.formatTime(tracking.triageSince);
      if (since !== null) built.body.append(element(doc, 'span', 'bghsa-since', `since ${since}`));
      rows.push(built.row);
    }
    if (tracking.owners.length > 0) rows.push(chipRow(doc, 'Owners', tracking.owners));
    if (tracking.backports.length > 0) {
      rows.push(chipRow(doc, 'Backport targets', tracking.backports));
    }
    if (tracking.embargo) {
      const built = row(doc, 'Embargo');
      built.body.className = 'flex-auto bghsa-chips';
      // An embargo in force and an embargo whose date has gone by are two
      // states, and the chip does not paint them alike. The chip row carries the
      // overdue one as well; this one carries the date.
      built.body.append(
        chip(
          doc,
          tracking.embargoLift === null ? 'In force, no lift date' : `Lifts ${tracking.embargoLift}`,
          embargoOverdue ? 'danger' : 'attention'
        )
      );
      rows.push(built.row);
    }
    if (tracking.closureReason !== null) {
      const built = row(doc, 'Closed as');
      built.body.className = 'flex-auto bghsa-chips';
      built.body.append(chip(doc, sentenceCase(tracking.closureReason)));
      if (tracking.closureDuplicateOf !== null) {
        built.body.append(
          element(doc, 'span', 'bghsa-since', `of ${tracking.closureDuplicateOf}`)
        );
      }
      rows.push(built.row);
    }
    return rows;
  }

  /**
   * The reasons a press left the advisory as it was, and so can be pressed again
   * safely. Every other outcome may have created the comment, and pressing again
   * would create a second one.
   *
   * @type {readonly string[]}
   */
  const RETRYABLE = [
    'allowlist',
    'provenance',
    'unreadable',
    'unverifiable',
    'no-form',
    'mismatch',
    'fetch',
  ];

  /**
   * Runs the write the button asks for and reports what happened. The button
   * stays disabled once a press has reached GitHub, because a press whose result
   * the extension could not confirm may still have created the comment. One
   * press leaves one result: the previous one is taken away first.
   *
   * @param {Document} doc
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @param {Element} button
   * @param {import('./preserve.js').PreserveOptions} [options]
   * @returns {Promise<import('../common/write.js').WriteResult>}
   */
  async function press(doc, advisory, button, options) {
    const host = button.parentElement;
    const note = host?.querySelector('.bghsa-preserve-note') ?? null;
    for (const stale of host?.querySelectorAll('.bghsa-preserve-result') ?? []) stale.remove();
    button.setAttribute('disabled', '');
    button.setAttribute('aria-disabled', 'true');
    if (note !== null) note.textContent = 'Writing the comment.';

    const outcome = await globalThis.bghsa.preserve.preserve(advisory, options);

    if (outcome.ok) {
      button.remove();
      if (note !== null) note.textContent = 'The original report is preserved.';
      return outcome;
    }
    // The comment is on the advisory, written from somewhere else. There is
    // nothing left to press.
    if (outcome.reason === 'preserved') {
      button.remove();
      if (note !== null) note.textContent = outcome.message;
      return outcome;
    }
    if (note !== null) note.textContent = '';
    const retryable = outcome.reason !== null && RETRYABLE.includes(outcome.reason);
    const banner = warning(
      doc,
      retryable
        ? outcome.message
        : `${outcome.message} Reload the page to see whether the comment was created.`
    );
    banner.classList.add('bghsa-preserve-result');
    host?.append(banner);
    if (retryable) {
      button.removeAttribute('disabled');
      button.removeAttribute('aria-disabled');
    }
    return outcome;
  }

  /**
   * The row the preservation button lives in. An advisory that already carries
   * the comment gets no button, because the extension writes one per advisory.
   *
   * @param {Document} doc
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @returns {Element}
   */
  function buildPreserve(doc, advisory) {
    const state = globalThis.bghsa.preserve.offered(advisory);
    const built = row(doc, 'Original report');
    if (!state.available) {
      built.body.textContent = state.message;
      return built.row;
    }
    const button = element(doc, 'button', 'btn btn-sm bghsa-preserve', 'Preserve original report');
    button.setAttribute('type', 'button');
    built.body.append(button);
    built.body.append(element(doc, 'span', 'ml-2 bghsa-preserve-note', state.message));
    button.addEventListener('click', () => {
      void press(doc, advisory, button);
    });
    return built.row;
  }

  /**
   * The panel, built from a parsed advisory, its derived state, and the tracking
   * state the advisory's snapshots hold. It reads nothing from the document
   * beyond the document itself, which creates the nodes.
   *
   * @param {Document} doc
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @param {import('../common/derive.js').DerivedState} derived
   * @param {import('./tracking.js').TrackingView} tracking
   * @param {import('./edit.js').EditorContext} [context] What the editing
   *   controls read. A panel built without one displays the stored state and
   *   does not edit it, because a write is refused against the ordering claim
   *   the panel was read at and nothing else names it.
   * @returns {Element}
   */
  function buildPanel(doc, advisory, derived, tracking, context) {
    const panel = element(doc, 'div', 'Box mb-3 bghsa-panel');
    panel.id = PANEL_ID;
    panel.setAttribute('data-bghsa-panel', '1');
    const embargoOverdue = globalThis.bghsa.derive.embargoOverdue(
      advisory,
      tracking.embargo ? tracking.embargoLift : null
    );
    panel.append(buildChips(doc, derived, embargoOverdue));

    const missing = missingValues(advisory, derived);
    if (missing.length > 0) {
      const banner = warning(
        doc,
        `Incomplete: this extension could not read ${missing.join(', ')}.`
      );
      banner.classList.add('bghsa-banner');
      banner.classList.remove('mt-2');
      panel.append(banner);
    }

    if (derived.patch.incomplete) {
      panel.append(warning(doc, 'A pull request named a state this extension does not read.'));
    }

    panel.append(buildConfirmations(doc, tracking));
    for (const track of buildTracks(doc, tracking, embargoOverdue)) panel.append(track);
    if (context !== undefined) panel.append(globalThis.bghsa.edit.buildEditor(doc, context));

    const descriptionRow = row(doc, 'Description');
    if (advisory.descriptionOriginal === null) {
      descriptionRow.body.append(doc.createTextNode('Provenance '));
      descriptionRow.body.append(element(doc, 'span', 'bghsa-missing', MISSING));
      descriptionRow.body.append(doc.createTextNode('.'));
    } else {
      descriptionRow.body.textContent = advisory.descriptionOriginal ? 'Not updated' : 'Updated';
    }
    panel.append(descriptionRow.row);
    panel.append(buildPreserve(doc, advisory));

    return panel;
  }

  /**
   * Where the panel goes: in the main column, above the description Box, and
   * outside both live regions, because GitHub replaces each region's subtree on
   * its own.
   *
   * @param {Document} doc
   * @returns {{ parent: Element, before: Element } | null}
   */
  function anchor(doc) {
    const header = doc.querySelector(globalThis.bghsa.parseDetail.DESCRIPTION_HEADER);
    const box = header === null ? null : header.closest('div.Box');
    const region = box === null ? null : box.closest('div.js-socket-channel');
    const before = region ?? box;
    if (before === null || before.parentElement === null) return null;
    return { parent: before.parentElement, before };
  }

  /**
   * @param {Document} doc
   * @returns {void} adds the extension's stylesheet once.
   */
  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID) !== null) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    (doc.head ?? doc.documentElement ?? doc.body)?.append(style);
  }

  /**
   * Places the panel. Placement is keyed on the sentinel element, so injecting
   * twice leaves one panel and re-injecting after GitHub replaced the subtree
   * puts one back.
   *
   * @param {Document} doc
   * @param {import('../common/parse-detail.js').ParsedDetail} advisory
   * @param {import('../common/derive.js').DerivedState} derived
   * @param {import('./tracking.js').TrackingView} tracking
   * @param {import('./edit.js').EditorContext} [context]
   * @returns {Element | null} the panel, or null when the page offers no anchor.
   */
  function injectPanel(doc, advisory, derived, tracking, context) {
    const panel = buildPanel(doc, advisory, derived, tracking, context);
    const existing = doc.getElementById(PANEL_ID);
    const place = anchor(doc);
    if (place !== null) {
      if (existing !== null) existing.remove();
      place.parent.insertBefore(panel, place.before);
    } else if (existing !== null) {
      existing.replaceWith(panel);
    } else {
      return null;
    }
    ensureStyle(doc);
    return panel;
  }

  /**
   * Whether the document needs the panel placed: it carries no sentinel, or it
   * carries one that no longer sits at the anchor because GitHub replaced the
   * subtree under it.
   *
   * @param {Document} doc
   * @returns {boolean}
   */
  function outOfPlace(doc) {
    const panel = doc.getElementById(PANEL_ID);
    if (panel === null) return true;
    const place = anchor(doc);
    return place !== null && panel.nextElementSibling !== place.before;
  }

  /**
   * The render loop each document runs its passes through. One loop per document
   * is what keeps a pass the observer asked for and a pass a save asked for from
   * reading and writing the document together.
   *
   * @type {WeakMap<Document, () => Promise<void>>}
   */
  const loops = new WeakMap();

  /**
   * @param {Document} doc
   * @returns {() => Promise<void>} that document's loop, made on first use.
   */
  function passFor(doc) {
    const held = loops.get(doc);
    if (held !== undefined) return held;
    const loop = renderLoop(doc);
    loops.set(doc, loop);
    return loop;
  }

  /**
   * Reads the document and places the panel. Returns null when the document is
   * not an advisory detail page, or when it offers no anchor.
   *
   * Reading is asynchronous because a confirmation is judged against a
   * fingerprint, and a digest is computed asynchronously.
   *
   * @param {Document} doc
   * @returns {Promise<Element | null>}
   */
  async function render(doc) {
    const edit = globalThis.bghsa.edit;
    const advisory = globalThis.bghsa.parseDetail.parseDetail(doc);
    if (advisory === null) return null;
    // A comment this page wrote is on GitHub and not in this document, so the
    // state a write left behind outranks what the document's comments merge to
    // until the page is read again.
    const context = await edit.contextFor(advisory, { rerender: () => passFor(doc)() });
    const placed = injectPanel(doc, advisory, context.derived, context.tracking, context);
    // The chips carry the extension's tone classes, and a page offering the
    // panel no anchor still gets them.
    ensureStyle(doc);
    globalThis.bghsa.comments.markComments(doc, context.merged);
    // What storage holds reaches the panel through a pass of its own, because a
    // member and a branch seen on another advisory are worth drawing again and
    // are not worth holding this pass up for.
    void Promise.all([
      globalThis.bghsa.members.sync(),
      globalThis.bghsa.branches.sync(),
    ]).then((grew) => {
      if (grew.includes(true)) void passFor(doc)();
    });
    return placed;
  }

  /**
   * @returns {string} what the nodes the extension owns match: the panel, the
   *   stylesheet, and the chips it puts on comments.
   */
  function ownedSelector() {
    const attribute = globalThis.bghsa.parseDetail.EXTENSION_CHIP_ATTRIBUTE;
    return `#${PANEL_ID}, #${STYLE_ID}, [${attribute}]`;
  }

  /**
   * A render loop for one document, running one pass at a time. A pass is
   * asynchronous because a confirmation is judged against a digest, and two
   * running together would each read the document and then write the panel, so
   * the one that finished last would put back what it read first. A request
   * arriving while a pass runs takes a pass of its own after it, because the
   * document may have changed while that pass was reading, and further requests
   * during the same pass fold into that one.
   *
   * @param {Document} doc
   * @returns {() => Promise<void>}
   */
  function renderLoop(doc) {
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
    };
  }

  /**
   * Watches the document and runs a pass when what the panel describes changes,
   * or when the panel is gone or has been left behind.
   *
   * The panel reads the live regions and describes what they hold, so a region
   * whose contents are replaced leaves the panel describing a document that is
   * no longer there: a comment chip is gone with its snapshot unmarked, and a
   * title or a severity that moved leaves a confirmation claiming a value the
   * page no longer carries.
   *
   * @param {Document} doc
   * @param {() => Promise<void>} [pass] The loop the observer runs its passes
   *   through, which is what keeps them from overlapping a pass started
   *   elsewhere.
   * @returns {MutationObserver | null} null where the document offers nothing to
   *   watch or no observer to watch it with.
   */
  function observe(doc, pass = renderLoop(doc)) {
    return globalThis.bghsa.dom.watch(doc, { ownedSelector, outOfPlace, pass });
  }

  /**
   * @returns {void} renders the panel into this page and keeps it there. The
   *   first pass and every pass the observer asks for run through one loop, so
   *   no two of them read and write the document together.
   */
  function start() {
    const doc = globalThis.document;
    const pass = passFor(doc);
    void pass();
    observe(doc, pass);
    globalThis.bghsa.edit.armNavigationWarning(doc);
  }

  const exported = {
    PANEL_ID,
    STYLE_ID,
    MISSING,
    missingValues,
    when,
    sentenceCase,
    buildConfirmations,
    buildTracks,
    buildPreserve,
    press,
    buildPanel,
    anchor,
    ensureStyle,
    outOfPlace,
    injectPanel,
    render,
    ownWrite,
    needsRender,
    renderLoop,
    passFor,
    observe,
    start,
  };

  globalThis.bghsa.panel = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  } else {
    start();
  }
})();
