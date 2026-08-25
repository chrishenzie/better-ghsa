(() => {
  const chain = el => { const a = []; let n = el;
    for (let i = 0; i < 6 && n && n.tagName; i++) {
      const c = (typeof n.className === 'string' && n.className.trim())
        ? '.' + n.className.trim().split(/\s+/).slice(0, 4).join('.') : '';
      a.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + c);
      n = n.parentElement;
    } return a; };
  const all = [...document.querySelectorAll('*')];
  const txt = re => all.filter(e => e.children.length === 0 && re.test((e.textContent || '').trim()))
                       .slice(0, 8).map(e => ({ t: e.textContent.trim(), chain: chain(e) }));

  const out = {
    path: location.pathname,
    me: document.querySelector('meta[name="user-login"]')?.content ?? null,
    customElements: [...new Set(all.map(e => e.tagName.toLowerCase()).filter(t => t.includes('-')))].sort(),
    forms: [...document.querySelectorAll('form')].map(f => ({
      action: f.getAttribute('action'), method: f.getAttribute('method'),
      enctype: f.getAttribute('enctype'), id: f.id || null,
      fields: [...f.elements].map(e => e.name).filter(Boolean),
      hasAuthToken: !!f.querySelector('input[name="authenticity_token"]'),
      chain: chain(f),
    })),
    textareas: [...document.querySelectorAll('textarea')].map(t => ({
      name: t.name || null, id: t.id || null, formAction: t.form?.getAttribute('action') ?? null, chain: chain(t),
    })),
    buttons: [...document.querySelectorAll('button,summary,[role="menuitem"]')]
      .filter(b => /comment|submit|edit|reply|delete|quote|start a draft|publish|close/i.test((b.textContent || '').trim()))
      .slice(0, 25).map(b => ({ text: (b.textContent || '').trim().slice(0, 40), tag: b.tagName.toLowerCase(),
        type: b.getAttribute('type'), name: b.getAttribute('name'), formaction: b.getAttribute('formaction'),
        href: b.getAttribute('href'), chain: chain(b) })),
    badges: txt(/^(Member|Owner|Author|Collaborator|Contributor|Maintainer)$/),
    stateChips: txt(/^(Draft|Triage|Published|Closed|Withdrawn|Reviewing)$/i),
    times: [...document.querySelectorAll('relative-time,time-ago,time')].slice(0, 12)
      .map(t => ({ dt: t.getAttribute('datetime'), chain: chain(t) })),
    commentAnchors: [...document.querySelectorAll('[id]')].map(e => e.id)
      .filter(i => /comment|discussion|timeline/i.test(i)).slice(0, 20),
    prLinks: [...document.querySelectorAll('a[href*="/pull/"]')].slice(0, 8)
      .map(a => ({ href: a.getAttribute('href'), chain: chain(a) })),
    jsonScripts: [...document.querySelectorAll('script[type="application/json"]')].map(s => ({
      target: s.getAttribute('data-target') || s.id || null,
      topKeys: (() => { try { const d = JSON.parse(s.textContent); return Object.keys(d.props ?? d).slice(0, 30); }
                        catch { return '(unparsed)'; } })(),
    })),
    metaCsrf: [...document.querySelectorAll('meta[name*="csrf"],meta[name*="token"]')].map(m => m.getAttribute('name')),
  };
  const s = JSON.stringify(out, null, 1);
  console.log(s); try { copy(s); console.log('\n[copied to clipboard, ' + s.length + ' bytes]'); } catch {}
  return '(done)';
})()
