# Remote MID management over SSH

JSN runs on a POSIX controller and connects through a preconfigured, noninteractive
SSH alias. Docker targets need a running Linux amd64 engine and Docker Compose.
Native Windows targets need x64 Windows, PowerShell 5.1 and an SSH account with
an elevated administrator token to register/remove the service. The MID runs as
the built-in LocalService account, with access restricted to its owned directory.
No RDP, remote Node.js or changes to the local Docker context are required.

## Plan and command surface

1. Preflight SSH, Docker platform/architecture, Compose and daemon identity.
2. Download the official recipe matching the instance release, inspect/extract
   its ZIP locally, then stream a tar build context to Docker over SSH.
3. Deploy with Compose over stdin. Keep passwords off command arguments and
   out of local ownership receipts. Use a named export volume on the remote
   engine; client-side bind paths do not refer to the remote filesystem.
4. Wait for the MID to register Up, then explicitly validate trust through the
   platform's own Validate action. No direct `validated` flag writes.
5. Run commands through `ecc_queue`; view logs through SSH/Docker.
6. Stop/remove only the exact labelled container, volume, network and image, then delete
   its MID record. Keep a nonsecret local removal receipt. Partial failures retain
   ownership metadata for diagnosis and explicit cleanup; never run a broad prune.

```sh
jsn --profile pdi midservers add --ssh elite-2 --name worker1 \
  --install-method docker --username mid_account --password-stdin
jsn --profile pdi midservers validate worker1 --force
jsn --profile pdi midservers logs worker1 --ssh elite-2 --tail 100
jsn --profile pdi midservers logs worker1 --ssh elite-2 --follow
jsn --profile pdi midservers execute worker1 --command 'printf JSN_ECC_OK'
jsn --profile pdi midservers stop worker1 --ssh elite-2
jsn --profile pdi midservers start worker1 --ssh elite-2
jsn --profile pdi midservers remove worker1 --ssh elite-2 --force
```

Pass the password through a secret reader or pipe, not a literal shell command.
Without `--password-stdin`, JSN uses its masked interactive password prompt. Use
`--force` only for an approved trust/deletion/context operation. Use the same MID
name, SSH alias and optional local `--directory` for later lifecycle operations.
SSH uses the configured alias/key/known-host policy, suppresses TTY and overrides
interactive `RemoteCommand` so Docker commands reach the target directly.

A remote Docker MID executes ECC commands **inside its Linux container**. It does
not provide a Windows host shell. Log following stops only the viewer when
interrupted; it does not stop the MID. Docker access controls who can inspect
container environment; the MID password is still available to Docker operators
while the deployment exists.

Before every lifecycle operation, JSN checks the daemon identity and ownership
labels. Existing names, changed engines and missing/mismatched labels stop the
operation. Stopping/removal failures preserve metadata and block MID-record
cleanup rather than pretending teardown succeeded.

## Native Windows service

```sh
jsn --profile pdi midservers add --ssh windows-host --name windows-worker \
  --install-method direct --username mid_account --password-stdin
jsn --profile pdi midservers validate windows-worker --force
jsn --profile pdi midservers logs windows-worker --ssh windows-host --tail 100
jsn --profile pdi midservers execute windows-worker --command 'echo JSN_ECC_OK'
jsn --profile pdi midservers stop windows-worker --ssh windows-host
jsn --profile pdi midservers start windows-worker --ssh windows-host
jsn --profile pdi midservers remove windows-worker --ssh windows-host --force
```

JSN downloads the official Windows ZIP matching the instance release on the
remote machine, validates archive paths and the vendor service launcher, restricts
filesystem ACLs, writes the MID configuration, registers a uniquely named service
using the vendor wrapper, grants that account START/STOP rights on only its own
service, and starts it as LocalService with automatic startup. Those service
rights allow the MID to restart itself during platform validation. Passwords travel over
SSH stdin. Local receipts contain ownership information and the archive SHA256.
Each lifecycle operation verifies the owner marker, service executable and runtime
identity. Removal stops the service, unregisters it through the vendor launcher,
verifies absence, and deletes only the owned installation before deleting its MID
record. The LocalService SID is retained in the vendor file-permission allow-list so
startup hardening preserves its access. Bounded log tails are supported; native log following is currently
unavailable. Native ECC commands run on Windows with the service account's rights.

## Native Linux background process

```sh
jsn --profile pdi midservers add --ssh linux-host --name linux-worker \
  --install-method direct --native-platform linux \
  --username mid_account --password-stdin
jsn --profile pdi midservers validate linux-worker --force
jsn --profile pdi midservers execute linux-worker --command 'echo JSN_ECC_OK'
jsn --profile pdi midservers logs linux-worker --ssh linux-host --tail 100
jsn --profile pdi midservers remove linux-worker --ssh linux-host --force
```

The target needs Linux x64, Python 3, a non-root SSH account and enough disk space
for the official ZIP and expanded runtime. JSN downloads and validates the ZIP on
the target, uses its bundled JRE and the vendor background launcher, then verifies
that the owned process survives SSH disconnect. Native operations check the remote
owner marker and process UID/executable/path. No Docker is required. No systemd service or sudo account
provisioning is implied. Check vendor-supported operating systems for your MID
release before selecting Debian or another distribution.
