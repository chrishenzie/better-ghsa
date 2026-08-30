# Privacy policy for Better GHSA

Last updated: 2026-08-29.

Better GHSA is a browser extension that adds triage tracking to GitHub Security
Advisories. This policy describes what it stores, what it transmits, and what it
writes into GitHub. It covers the extension itself and nothing else: GitHub's own
handling of your data is governed by GitHub's privacy statement.

The extension does not have a server, backend, or operator-run infrastructure.
No data reaches the extension's author.

## Summary

- Everything the extension stores is stored on your own device, in the browser's
  extension storage.
- The extension requests one host, `github.com`. An owner icon in its advisory
  list is a `github.com` image address that GitHub redirects to
  `avatars.githubusercontent.com`. The browser loads the image from there.
- The extension writes comments into GitHub advisories under your GitHub
  account. Those comments are visible to everyone who can read the advisory,
  including the person who reported the vulnerability.
- There is no telemetry, no analytics, no advertising, no tracking, and no
  transfer of data to any third party.

## What is stored on your device

The extension uses `browser.storage.local` (`chrome.storage.local` in Chrome).
That storage lives in the browser profile on your device, is not encrypted by
the extension, is not synchronized between devices or browsers, and is not
readable by any web page.

Nothing is stored anywhere else. The extension does not use cookies of its own,
`localStorage`, or IndexedDB.

It holds six kinds of entry.

**The list of repositories the extension acts on**, under the key `allowlist`.
The `owner/repo` names entered in the extension's settings, lowercased. It is
empty until repositories are added, and nothing else here exists until it
carries one.

**Advisory reads**, one per advisory, under keys beginning `adv:`. Each is a
parsed copy of an advisory page as it was read, together with the time it was
read. It contains:

- The repository, the GHSA identifier, the advisory's state, its severity and
  CVSS vector, and its CVE identifier and CVE request state.
- The advisory's title and description, as source text.
- The login of the person who reported the advisory and the time they reported
  it.
- Every comment in the advisory's conversation: its identifier, its author's
  login, the role badges GitHub showed on it, its timestamp, and its text.
- Every event in the advisory's timeline: the actor, the time, and the text.
- The advisory's private fork, if one exists: its repository name, its clone
  URL, and each pull request in it with number, title, state, branches, author,
  and assignees.
- The logins of the advisory's collaborators.
- The login of the GitHub account the page was rendered for, which is yours.

Advisories in the triage and draft states are not public. Their contents,
including details of unfixed vulnerabilities, are among what is stored.

**Advisory list reads**, one per repository, under keys beginning `list:`. Each
holds the rows of that repository's advisory list as read: identifier, title,
state, severity, the date opened, and the reporter's login, along with the
counts on GitHub's state tabs and how far the read got.

**Refresh progress**, one per repository, under keys beginning `queue:`. It
holds which advisory identifiers are queued, in flight, read, or failed, and
when the last request was sent. A refresh interrupted by navigation resumes
from it.

**Observed organization members**, under the key `members`. GitHub logins seen
carrying an Owner or Member badge on an advisory, keyed by organization. These
are used to suggest owners and to decide whose tracking state counts.

**Observed release branches**, under the key `branches`. Branch names beginning
`release/` seen on a repository, used to suggest backport targets.

### Which repositories this covers

The extension runs on the advisory pages of the repositories listed in its
settings, and on no other page. On a repository that is not listed it reads
nothing, stores nothing, and sends nothing.

On every advisory page, listed repository or not, the extension draws a
`Better GHSA settings` button that opens its settings page. Drawing it and
pressing it do not read an advisory, store anything, or send a request.

### Retention

Entries persist until they are removed. Advisory and list reads are refreshed in
place as pages are re-read. An advisory GitHub has stopped serving has its entry
removed after three consecutive failures. The `members` and `branches` entries
accumulate, and nothing ages them out.

The extension's settings page carries a `Clear cache` button. It empties the
advisory reads, the advisory list reads, the refresh progress, and the `members`
and `branches` entries. It leaves the `allowlist` entry, because clearing that
would turn the extension off. Nothing is asked first, and nothing is lost: the
extension reads what it needs again from the advisories.

Removing a repository from the settings page empties what was stored for it: its
advisory reads, its advisory list read, its refresh progress, and its branches
in the `branches` entry. Its organization's logins in the `members` entry are
kept while another repository from that organization is still listed, because
that entry is keyed by organization.

## What is transmitted, and to whom

The extension sends every request it makes to `https://github.com`. It sends
nothing to the extension's author or to any third party. The browser also
loads the owner icons from GitHub's avatar host, where GitHub's redirect
sends it.

The requests it sends are:

- `GET` on a repository's advisory list pages,
  `https://github.com/{owner}/{repo}/security/advisories`.
- `GET` on an advisory page,
  `https://github.com/{owner}/{repo}/security/advisories/{GHSA-id}`.
- `GET` on an owner's profile image, `https://github.com/{login}.png?size=40`,
  the source of the icon each owner gets in the extension's advisory list.
- `POST` to that advisory's comment endpoint, to create or edit a comment, and
  only when you press a button that saves.

All of these are same-origin requests carrying the `github.com` session your
browser already has. The extension does not ask for a personal access token,
does not create one, does not read one, and does not store a credential of any
kind.

Some of these requests are sent without a direct click. While a `github.com`
advisory page is open, the extension refreshes advisories in the background, at
most one request per second per repository. To GitHub, that traffic is
indistinguishable from your own browsing, and GitHub records it as it records
any other request from your session.

GitHub answers a profile image request with a redirect to the host it serves
avatars from, `https://avatars.githubusercontent.com`. The browser follows the
redirect and loads the image from there. That request to the avatar host is one
GitHub directs the browser to make. The extension's code names the `github.com`
address and no other host.

An icon is requested while the extension draws its advisory list, one per login
recorded as an owner on a row it shows. Each request names that owner's login
and carries your `github.com` session. What GitHub can read from those requests
is that you are looking at the advisories those owners are on. The page reads
above tell GitHub that already, as does reading an advisory while signed in to
GitHub.

The extension does not load remote code, remote fonts, or an analytics or
crash-reporting service. The owner icons are the only images it loads.

## What is written into GitHub, and who can see it

When you press a save, the extension writes a comment into the advisory's
conversation, under your GitHub account. It writes two kinds of comment and
nothing else.

**The tracking state comment**, at most one per advisory per maintainer. Its
summary line reads "Better GHSA tracking state". It contains a JSON snapshot of:
the triage value; the logins recorded as owners; the release branches recorded
as backport targets; whether an embargo applies and its lift date; the closure
reason and, for a duplicate, the advisory it duplicates; for each confirmation,
the login of the person who made it, the time, and a fingerprint of the value
confirmed; a sequence number; and the schema version. A fingerprint is the first
twelve hexadecimal characters of the SHA-256 of the confirmed value. It detects
change. It does not carry the value. It is not a security control.

**The preserved original report comment**, at most one per advisory. It contains
the advisory's title and description as they stood when the button was pressed,
copied verbatim.

Both are ordinary advisory comments. Everyone who can read the advisory's
conversation can read them: the repository's advisory collaborators and the
person who reported the vulnerability. Posting a comment causes GitHub to
notify the advisory's participants, the reporter among them. Publishing an
advisory makes the advisory's own data public and keeps the conversation
restricted to collaborators.

The extension does not change any other part of an advisory. It does not modify
the title, description, severity, CVSS vector, CWEs, CVE, state, or
collaborators.

The extension cannot delete a comment it wrote. To remove one, delete it through
GitHub's own interface.

## What is never collected

- No browsing history, and no data at all from pages outside
  `github.com/{owner}/{repo}/security/advisories` on a repository you listed. On
  every other page the extension reads nothing, stores nothing, and sends
  nothing.
- No passwords, tokens, keys, or other credentials.
- No form contents outside its own controls.
- No analytics, usage metrics, session recording, crash reports, or device,
  advertising, or user identifiers.
- No location data.
- No contact information. The extension records GitHub logins that appear on the
  advisory pages you open; it does not collect names, email addresses, or
  profile data beyond those logins.

Nothing is sold, shared, or disclosed to anyone because nothing leaves your
device except the GitHub requests described above.

## Permissions the extension requests

- **`storage`**: for the local storage described above.
- **Access to `https://github.com/*`**: the extension's script is loaded on every
  `github.com` page, and stops immediately on any page that is not an advisory
  page on a repository you listed, without reading it, storing anything, or
  sending a request. The broad match exists because GitHub replaces page content
  without a page load. The script has to already be present to notice arriving
  at an advisory page.

The extension does not request any other permission. It does not declare a
background script or a background page. Its code runs only on the `github.com`
pages you have open and on its own settings page. It does not have access to
tabs, history, bookmarks, downloads, cookies, or any other host.

The manifest lists the settings page under `web_accessible_resources`, matched
to `https://github.com/*`. A browser blocks a `github.com` page from opening an
extension page unless the page is listed there, and that listing is what lets
the button open the settings. It makes the settings page loadable by pages on
`github.com` and by no other site. The extension asks the browser for the
settings page's address when it draws the button and holds it in the button's
click handler. The document never carries the address. A script on `github.com`
does not read it out of the page.

That listing also lets a page on `github.com` load the settings page into a
frame, where it could sit invisibly under a click. The manifest's content
security policy forbids every site from framing the extension's pages. Such a
frame stays empty.

## Clearing everything

The `Clear cache` button on the extension's settings page empties everything it
read, and leaves the list of repositories it acts on. See "Retention" above for
what each control clears.

Removing the extension deletes everything it stored, the list included. In
Firefox, open `about:addons`, find Better GHSA, and remove it. In Chrome, open
`chrome://extensions`, find Better GHSA, and press Remove. The browser deletes
the extension's storage with it.

Clearing site data for `github.com` in the browser's own settings does not
remove the extension's storage. The controls above are what reach it.

Comments the extension wrote into GitHub advisories are not local data and are
not affected. Delete those through GitHub.

## Changes to this policy

Changes are made in this file, in the extension's source repository, and the
date at the top is updated.

## Contact

Better GHSA is published at https://github.com/samuelkarp/better-ghsa. Questions
about this policy go there.
