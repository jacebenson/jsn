# Windows credential storage (#530)

Candidate notes and verification evidence. No dependency additions.

Windows uses a bundled static PowerShell helper (Windows PowerShell 5.1 or
PowerShell 7+), FullLanguage/Add-Type and advapi32 CredReadW/CredWriteW/CredDeleteW.
No ExecutionPolicy flag or policy mutation is requested. Explicit policy denial,
missing host and native API failure fail closed. JSON requests use stdin; neither secrets nor identities become
script source/argv. Child diagnostic output is never surfaced.

One generic entry contains the JSON as UTF-8 (maximum 2560 bytes); oversized
entries fail before replacing existing credentials. No chunking, master key or
encrypted-file scheme is added. Plaintext still requires the existing explicit
process-local opt-in. Only exact secure JSON readback retires the selected
plaintext file. Linux secret-tool behavior is retained.

Historical compatibility inspected: a5afa2e internal/auth/store.go uses
`servicenow-cli` plus normalizeURL(instance), and go.mod pins go-keyring v0.2.8.
That version's keyring_windows.go constructs `service + ":" + username`;
wincred v1.2.3 writes raw bytes with PersistLocalMachine. Therefore new entries
use `servicenow-cli:<existing JS credential key>`; only username-less profiles
also read the exact normalized-URL Go target. Named users never borrow that
instance-wide entry. No enumeration or broad vault cleanup is performed.
Sources: https://github.com/zalando/go-keyring/blob/v0.2.8/keyring_windows.go
and https://github.com/danieljoos/wincred/blob/v1.2.3/wincred.go.

Local validation on Linux / Node v26.12.1:
- Focused: 25 tests, 24 passed, native Windows case explicitly skipped.
- Full `npm test`: 2583 tests, 2579 passed, 4 skipped, zero failures.
- `npm run lint`: exit 0.
- `npm pack --dry-run --json` from cli/: exit 0; both helper files included.
- Synthetic unavailable-PowerShell error through the existing exitWithError
  path: exit 1, static redacted error, no assertion on Linux.

Linux mocks are not Windows native proof. The Windows CI lane now requires
production-default discovery plus pinned Windows PowerShell 5.1 and PowerShell 7 roundtrips;
it cannot skip when those hosts are absent. Only uniquely named test-created
targets are removed, with absence readback. Those CI runs are still required.
The reported Windows libuv exit assertion cannot be reproduced natively on this
Linux host; no speculative exit/handle changes are included.

## Review correction

Read/delete now snapshot Marshal.GetLastWin32Error immediately after the
native P/Invoke inside the same C# wrapper. PowerShell receives a read result
(error code/value) or a delete error code; it never retrieves thread-local last
error across a separate dispatch. Read blob decoding and CredFree stay in C#.

Host selection tries PowerShell 7 only when the first executable is absent or
the helper explicitly reports an unsupported host/version. Capability, policy,
native-operation and malformed-response failures stop without trying another
host. Offline regression tests assert both successful version fallback and
no retry after denial.

## Embedded invocation and execution policy

Node reads only the trusted bundled helper and passes its static source using
UTF-16LE `-EncodedCommand`. Request identities and secrets remain stdin JSON.
No payload, target, username or caller-supplied script path enters command text.
No execution-policy flag, Set-ExecutionPolicy call, registry write or policy
environment-variable assignment is made.

Microsoft documents that Restricted permits individual commands but blocks
script files, and all-Undefined scopes resolve to Restricted on Windows clients.
The embedded invocation uses that command-text behavior, not script-file
authorization. It deliberately does not promise to satisfy script signing or
Internet-zone checks. Before Add-Type or reading stdin, the helper queries
MachinePolicy and UserPolicy with the module-qualified Get-ExecutionPolicy.
Any explicit value at either enterprise scope is refused, even RemoteSigned or
Unrestricted. This conservative rule avoids trying to interpret enterprise
signing/origin approval from embedded code. It can reject a permissive managed
machine; an administrator-approved alternative remains necessary there.

For Process, CurrentUser and LocalMachine, explicit Restricted, AllSigned,
Default or unknown values are also refused. Undefined, RemoteSigned,
Unrestricted and a pre-existing Bypass setting are accepted without changing
them. These local settings do not authenticate the installed npm package;
the trust assumption is that the package/helper on disk is trusted installed
code. Policy query failure, CLM, Add-Type denial and application-control denial
still fail closed without retrying another host or selecting plaintext.

Structural test rationale is in [DECISIONS.md](DECISIONS.md). Offline tests
check exact source/argv independence, gate placement and refusal-response
handling. They do not execute PowerShell or prove actual enterprise enforcement.
Reference: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies?view=powershell-5.1

## Operator native handoff (not executed by this worker)

The operator reports that `family-pc` SSH lands in WSL and that
`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` runs Windows
PowerShell 5.1.26100.9818 on Windows NT 10.0.26200.0 with Windows Node 24.14.1.
On edc8ab1, the operator's pinned PowerShell 7.6.10 roundtrip passed, but
Windows PowerShell 5.1 failed because -File was blocked by the stock default
Restricted policy. That evidence does not validate this new embedded-command
candidate. Do not stage files or operate on that host until the
operator collects the final candidate. Run the test from the operator-staged
candidate's `cli/` directory using **Windows Node >=24**, not WSL Node:

```powershell
node.exe --version
node.exe -p "process.platform" # must print win32
$env:JSN_REQUIRE_WINDOWS_CREDENTIAL_TEST = '1'
$env:JSN_TEST_WINDOWS_POWERSHELL = 'default'
node.exe --test test/windows-credential-native.test.js
if ($LASTEXITCODE -ne 0) { throw 'Production-default discovery regression failed' }
$env:JSN_TEST_WINDOWS_POWERSHELL = 'powershell.exe'
node.exe --test test/windows-credential-native.test.js
if ($LASTEXITCODE -ne 0) { throw 'Native Windows PowerShell regression failed' }
$env:JSN_TEST_WINDOWS_POWERSHELL = 'pwsh.exe'
node.exe --test test/windows-credential-native.test.js
if ($LASTEXITCODE -ne 0) { throw 'Native PowerShell 7 regression failed' }
```

Use a fresh operator shell for those test-only environment variables, record the
staged candidate SHA and separate exit-status/log evidence for each host. Missing
PowerShell 7 must remain an explicit failed/unverified lane, not be relabeled a
pass. The fixture creates only UUID-namespaced synthetic entries and deletes
those exact entries with absence readback. No real credentials or ServiceNow
authentication are needed. The native test has a 180-second test timeout and
each child operation has a 20-second timeout; retain an operator outer bound as
well. The first native invocation exercises production discovery with no
injected process executor. The other two pin each executable for ABI coverage.
Record read-only Get-ExecutionPolicy -List output for each host before and after;
the test must not change policy. No remote staging or testing was performed by
this worker for this revision.
