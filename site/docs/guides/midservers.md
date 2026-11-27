---
title: MID Server management
---

Manage MID Servers remotely without attaching to the instance console.

## Installation preflight

Local `midservers add` prints its resolved destination to stderr before downloading
or creating installation files. Interactive terminals offer a prefilled location;
Enter accepts it. `--directory` supplies the location for scripted runs. The default
remains `~/.servicenow/mids/<instance>/<mid-name>`. Destinations must be absolute,
absent and beneath non-symlink, non-group/world-writable parents (sticky temporary
roots are permitted). Existing directories are not adopted. The Docker installer
also accepts an empty private user-owned directory when called programmatically.

After the MID credential probe succeeds, JSN uses its existing authenticated
session for read-only account, role and Basic Auth property checks. It requires
`mid_server`, active/unlocked/web-service-only account flags, and checks the actual
configured `glide.authenticate.basic_auth.allowed_roles` when restrictions are active
and enforced. Web Services Access Only accounts are exempt under the documented
Australia policy. The exception table records administrator decisions, not blanket
permissions. When needed, JSN reads the decision dictionary and actual English
choice values; missing/ambiguous schema is unknown. A selected decision is not proof
that its role grant or account conversion has taken effect. JSN never grants roles or changes
authentication policy. HTTP 401 and 403 remain distinct; neither proves a missing
role. Credential acceptance, registration Up and manual trust validation are separate.

For SSH installs, `--directory` still names **local ownership metadata**, not the
remote runtime location. Native SSH setup resolves and validates the target default
on the target before writing controller metadata or downloading. Interactive setup
offers that default; `--remote-directory` overrides the native target path. Linux
uses the target home and Windows uses the target USERPROFILE, both partitioned as
`.servicenow/mids/<instance>/<mid-name>`. Existing targets, linked ancestors and
unsafe parents reject. Remote Docker uses owned named volumes, not a target compose
directory; `--remote-directory` is explicitly rejected for that mode.

Successful setup records a nonsecret private location mapping under
`~/.servicenow/mid-locations/`, keyed by instance origin, normalized name and SSH
alias. This is discovery data, never proof of runtime ownership. Lifecycle callers
resolve it for start/stop/logs/remove and then apply their existing ownership checks.
Verified teardown forgets the matching mapping; failed teardown retains it. An
explicit override cannot clear a mapping for a different installation.

Direct lifecycle reconciles persisted state against actual owned processes before
rejecting a start. Windows console SIGINT/SIGTERM waits for verified owned-process
exit; stale state alone does not block recovery. Removal stops the owned runtime
and verifies exit before files and the instance record can be deleted. Unknown
process identity or failed exit verification retains files and the location mapping.

Policy references: [Basic authentication restriction](https://github.com/ServiceNow/ServiceNowDocs/blob/australia/markdown/platform-security/authentication/basic-auth-restriction.md)
and [Basic authentication exceptions](https://github.com/ServiceNow/ServiceNowDocs/blob/australia/markdown/platform-security/authentication/basic-auth-exceptions.md).
These documents identify WSAO exemptions and decision effects; they do not publish
raw exception-choice enum values, which JSN does not guess.

## Remote MID management over SSH

JSN runs on a POSIX controller and connects through a preconfigured, noninteractive
SSH alias. Docker targets need a running Linux amd64 engine and Docker Compose.
Native Windows targets need x64 Windows, PowerShell 5.1 and an SSH account with
an elevated administrator token to register/remove the service. The MID runs as
the built-in LocalService account, with access restricted to its owned directory.
No RDP, remote Node.js or changes to the local Docker context are required.

Use `midservers add` for local installation, or add `--ssh <alias>` to install on
a remote target. Current SSH authentication must be noninteractive: use a key,
agent or an already authenticated connection. An SSH password prompt is a separate
future option; `--password-stdin` supplies the ServiceNow MID password only.

[Live lifecycle verification and terminal evidence](https://github.com/jacebenson/jsn/blob/main/site/docs/evidence/verification/260-remote-mid.md)
cover Linux native, Linux Docker and Windows native installation through teardown.

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

## ECC queue backlog

`midservers queue` answers "what is waiting for which MID?" without touching a
MID's runtime. It reads `ecc_queue` through the Stats API and shows one row per
`agent` routing value, ordered by waiting count and then the age of the oldest
waiting row:

```sh
jsn --profile pdi midservers queue
jsn --profile pdi midservers queue worker1 --older-than 2h --limit 50
jsn --profile pdi midservers queue --older-than 1d --json --get data.agents
```

The filter is `queue=output` with `state` at `ready` or `processing`, created
before the `--older-than` window (default `15m`, also `2h`/`1d`). Rows at
`queue=input` in `state=error` are counted separately per agent. Each agent is
joined to its `ecc_agent` row through the `mid.server.<name>` routing value that
`midservers execute` writes. An agent with no matching `ecc_agent` row is shown
as unknown, not as zero; a MID absent from the report simply had no rows in
that window, which is not a health verdict.

Verified on a live instance: `ecc_queue.queue` is the input/output direction
(`sys_choice` values `input`/`output`), `ecc_queue.topic` is the named work type
(observed values include `SystemCommand` and `HeartbeatProbe`), and `agent`
holds `mid.server.<name>` or the broadcast value `mid.server.*`. The command is
read-only and bounded: `--limit` defaults to 25 agents (maximum 200) and
`--older-than` is rejected before any request when malformed. The verification
instance had no waiting output rows during capture, so the backlog table is
covered by synthetic tests rather than a live sample.

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
