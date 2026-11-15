# Browser-auth extension (protocol sketch only)

This directory holds the protocol-1 contract for the proposed browser-extension
session handoff described in
[`docs/browser-extension-auth-design.md`](../../docs/browser-extension-auth-design.md)
(issue #302).

What is here:

- `lib/handoff.js` — pure helpers for the extension's half of the wire
  contract: origin eligibility, pairing-code normalisation, and payload
  construction/validation. Exercised by `cli/test/extension-handoff.test.js`.

What is **not** here, deliberately:

- No `manifest.json`, no service worker, no content script, no popup. No code in
  this directory reads cookies, executes page scripts, or opens a network
  connection. Shipping capture code that has never run against Chrome and a live
  ServiceNow instance would misrepresent it as working.

The CLI half (`jsn auth login --handoff`: loopback receiver, pairing code,
`ssh -L` instruction, verify, store) does not exist yet either. It is the
recommended first step because it is testable without a browser.

Nothing here is included in the npm package: `cli/package.json` `files` lists
only `bin/jsn.js`, `src/`, `skills/`, `README.md`, and `LICENSE`.
