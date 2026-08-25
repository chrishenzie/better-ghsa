// Paste once per page, then capture with:
//
//   copy(cap('div.js-socket-channel.js-updatable-content'))
//
// `copy` is a console helper and only exists in the evaluation you type it in,
// so `cap` returns the markup and the caller copies it. `capSave` downloads
// instead, for markup too large for the clipboard.
//
// The optional second argument is a selector, or list of selectors, whose
// matches are removed from the copy before it leaves the page.
//
// The markup is otherwise verbatim, except that session token values are
// blanked: the field names and attributes are what tests read, and the values
// would otherwise be committed to the repository. A CSRF input is marked by
// data-csrf rather than by its name, and data-channel carries a signed
// websocket subscription token.
(() => {
  const BLANK = ['authenticity_token', 'timestamp_secret', 'timestamp'];

  const build = (sel, drop) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`no match for ${sel}`);
    const clone = el.cloneNode(true);
    let dropped = 0;
    for (const d of [].concat(drop || [])) {
      for (const node of clone.querySelectorAll(d)) { node.remove(); dropped++; }
    }
    let blanked = 0;
    for (const input of clone.querySelectorAll('input,textarea')) {
      const name = input.getAttribute('name') || '';
      if (BLANK.includes(name) || name.startsWith('required_field_')
          || input.getAttribute('data-csrf') === 'true') {
        input.setAttribute('value', '');
        blanked++;
      }
    }
    for (const el of clone.querySelectorAll('[data-channel]')) {
      el.setAttribute('data-channel', '');
      blanked++;
    }
    const html = clone.outerHTML;
    console.log(`${sel}: ${html.length} bytes, ${blanked} token values blanked, ${dropped} nodes dropped`);
    return html;
  };

  window.cap = build;

  window.capSave = (sel, filename, drop) => {
    const url = URL.createObjectURL(new Blob([build(sel, drop)], { type: 'text/html' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return `(downloading ${filename})`;
  };

  window.capCount = (sel) => document.querySelectorAll(sel).length;

  console.log("ready: copy(cap('<sel>', '<drop>')), capSave('<sel>', '<file>', '<drop>'), capCount('<sel>')");
  return '(ready)';
})()
