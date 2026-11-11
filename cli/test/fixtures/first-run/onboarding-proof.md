# Onboarding terminal proof

The final requested flow is **three connection questions plus one defaults confirmation**, not the original two-prompt proposal. Authentication credentials are conditional.

## Execution

From `/home/jace/workspace/jsn-onboarding` (Node v26.12.1):

- `JSN_ONBOARDING_PROOF=$PWD/cli/scratch/onboarding npm --prefix cli test`: exit 0; 2141 tests, 2139 passed, 2 opt-in tests skipped, 0 failed.
- `npm --prefix cli run lint`: exit 0.
- `git diff --check`: exit 0.

`test/setup-terminal.test.js` launches the actual `node cli/bin/jsn.js setup` entrypoint through the reusable Python PTY driver with disposable XDG_CONFIG_HOME and JSN_DATA_HOME. Authentication is exercised against a loopback HTTP fixture, not a live ServiceNow instance. The fixture has no domain-separation table. The test reads back the saved config and verifies preferences, first-profile default selection and absence of docs configuration.

Completed terminal prompt lines from a passing run (ANSI cursor redraws removed, wording retained):

```text
✔ ServiceNow instance name or URL: (Esc to cancel) http://127.0.0.1:39937
✔ Profile name: (Esc to cancel) fixture
✔ Authentication method: (Esc to cancel) Basic — username and password
✔ Accept defaults? writes allowed · delete confirmations on · result totals on (Esc to cancel) Yes
✔ Username: (Esc to cancel) fixture
✔ Password: (Esc to cancel)
```

**Four onboarding questions, six prompts including Basic credentials.** No global-preferences questions, documentation questions or first-profile default confirmation. Browser and OAuth wizard unit coverage asserts the same four onboarding questions before handing off to their authentication flows. OAuth still requires its external authorization code; browser sign-in still requires human authentication.

After successful login:

```text
Connection preset: writes allowed · deletes ask first · totals on
Change with: jsn auth modify fixture --read-only
1 profile

PROFILE              AUTH   CREDENTIALS  CONNECTION  ACCESS      DELETES  COUNTS
fixture * (default)  Basic  Available    Verified    Read/write  Confirm  On
```

## Bare interactive jsn

Before: a real first-run PTY capture contained 185 lines / 12901 UTF-8 bytes, including the welcome and full grouped command catalog.

After: a real first-run PTY capture contained 7 lines / 223 UTF-8 bytes:

```text
Welcome to jsn 5.5.1 (ServiceNow from your terminal)
Config: ~/.hermes/cache/scratch/jsn-front-door-ifpzz9/servicenow/config.json

  Get started
    jsn setup   connect to ServiceNow
    jsn --help  every command and flag
```

The PTY welcome test preloads a guard that fails on any network/auth operation, with daily-check suppression variables removed. Explicit `jsn --help` remains comprehensive. Existing fixture/hash tests continue to prove byte-identical piped/scripted help, JSON discovery, configured-user behavior, welcome suppression, narrow-terminal wrapping and marker handling.

No Basecamp/HEY CLI was executed and no account/service was accessed. Local command discovery found installed shims, not readily available presentation source/help snapshots; the welcome uses restrained ASCII spacing without claiming visual parity with those products.

## Boundaries

Live ServiceNow browser/OAuth authentication, Windows PTY rendering and domain-enabled onboarding were not exercised. Existing domain-configuration behavior remains conditional on provider capability. Hub/direct defaults and documentation settings are covered with real config persistence and a stubbed prompt layer; No on the preset opens the existing three preference questions and explicit flags remain authoritative.
