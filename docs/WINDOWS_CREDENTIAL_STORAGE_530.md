# Windows credential storage (#530)

Candidate checkpoint before full validation. No dependency additions.

Windows uses a bundled static PowerShell helper (Windows PowerShell 5.1 or
PowerShell 7+), FullLanguage/Add-Type and advapi32 CredReadW/CredWriteW/CredDeleteW.
No ExecutionPolicy bypass is requested. Policy denial/missing host/native API
fail closed. JSON requests use stdin; neither secrets nor identities become
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
- Focused: 24 tests, 23 passed, native Windows case explicitly skipped.
- Full `npm test`: 2582 tests, 2578 passed, 4 skipped, zero failures.
- `npm run lint`: exit 0.
- `npm pack --dry-run --json` from cli/: exit 0; both helper files included.
- Synthetic unavailable-PowerShell error through the existing exitWithError
  path: exit 1, static redacted error, no assertion on Linux.

Linux mocks are not Windows native proof. The Windows CI lane now requires
real synthetic roundtrips under both Windows PowerShell 5.1 and PowerShell 7;
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

## Operator native handoff (not executed by this worker)

The operator reports that `family-pc` SSH lands in WSL and that
`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` runs Windows
PowerShell 5.1.26100.9818 on Windows NT 10.0.26200.0. This is host discovery,
not native test proof. Do not stage files or operate on that host until the
operator collects the final candidate. Run the test from the operator-staged
candidate's `cli/` directory using **Windows Node >=24**, not WSL Node:

```powershell
node.exe --version
node.exe -p "process.platform" # must print win32
$env:JSN_REQUIRE_WINDOWS_CREDENTIAL_TEST = '1'
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
well. The Linux host-selection regressions exercise production discovery;
these two native invocations intentionally pin each executable for ABI coverage.
