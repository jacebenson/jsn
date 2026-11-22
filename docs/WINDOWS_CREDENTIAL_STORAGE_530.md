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
- Focused: 22 tests, 21 passed, native Windows case explicitly skipped.
- Full `npm test`: 2580 tests, 2576 passed, 4 skipped, zero failures.
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
