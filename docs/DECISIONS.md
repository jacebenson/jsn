# Architectural decisions

## Windows credential helper is trusted static command text

Use the bundled PowerShell helper as UTF-16LE EncodedCommand text, not a script
file invocation. Stock Windows clients with all execution-policy scopes Undefined
have effective Restricted policy, which permits individual commands but blocks
.ps1 files. Do not change any execution-policy scope or request Bypass.

Treat every explicit MachinePolicy/UserPolicy value as a refusal, even
RemoteSigned or Unrestricted. Embedded code cannot establish script signing or
origin-zone approval. Also refuse explicit local/session Restricted, AllSigned,
Default and unknown values. Missing/unreadable policy, ConstrainedLanguage and
Add-Type denial fail closed without alternate-host retries.

The structural tests in windows-credential-store.test.js enforce this security
boundary: argv decodes to the exact bundled source, never request data, and the
policy gate precedes Add-Type and stdin consumption. This is a deliberate
architecture invariant, not an incidental restriction on private method layout.
Offline source and response-fixture tests do not prove native policy evaluation;
real Windows production-discovery tests remain required.

Reference: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies?view=powershell-5.1
