# Setup / explicit-command parity

Tracking #323 / #328. Setup's help and noninteractive error now derive their
action list from the same menu choices the human sees. Setup still dispatches
to the existing auth operations; no second login/configuration implementation
was added.

| Wizard action | Explicit command | Verification |
| --- | --- | --- |
| Add a connection | `auth login <instance> --name <name>` with method options | Existing Basic/OAuth CLI workflow and guided/direct shared-operation tests; new captured-session file/stdin workflow. |
| Sign in again | `auth login --profile <name>` with method options | Existing profile settings are retained; the new file-input test reconnects after logout. |
| Check connections | `auth status --details --json` or `--local` | Existing auth workflow tests and new captured-session status check. |
| Choose default | `auth switch <name>` or new login's `--make-default` | Existing multi-profile CLI test, plus explicit browser-profile default selection. |
| Change settings | `auth modify --profile <name>` with flags | Existing settings/guided parity tests; new test toggles read-only, delete confirmations and result counts. Negative flags are documented. |
| Sign out | `auth logout --profile <name> --force` after approval | Existing logout approval tests; new lifecycle test proves unapproved logout fails and approved logout retains the profile. |
| Remove connection | `auth remove <name>` | Existing dispatch test and new real CLI test remove the temporary profile/credentials. |

Browser-session login and refresh now accept `--headers-file <path>` or `-` for
stdin. This fills the missing noninteractive input path without secrets in argv
or a paste prompt contaminating JSON. It reuses `loginWithGck` and the existing
verification/persistence. Invalid/empty files and conflicting selectors fail
without network or configuration changes. Basic uses environment credentials;
OAuth already supports `--print-url --wait-file <code-file>` for file-based code
input. Explicit `--browser` still requires a human to finish browser sign-in.

`test/setup-parity.test.js` uses a local HTTP fixture and isolated file credential
store; no live instance or real credentials are used. It checks every menu action
has a help/error mapping, JSON remains parseable, secrets stay out of output,
settings survive renewal, and failures leave configuration unchanged. Existing
wizard, Escape, profile, OAuth, Basic and shared-operation tests remain in scope.
