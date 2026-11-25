# Remote MID lifecycle verification (#260)

Actual live checks ran on the requested Linux and Windows SSH targets against
profile `pdi` on 2026-10-29. The repository binary was `node bin/jsn.js`, version
4.3.13. Final Windows and Docker runs used source `f759100`; the native Linux
run preceded the Windows-controller guard, which leaves its POSIX runtime path
unchanged. A fresh doctor verified the selected OAuth profile
before driving the instance; a final doctor still passed after cleanup.

[Machine-readable selected results](260-remote-mid-pdi.json) contain no passwords,
tokens, cookies, user IDs or instance hostname. The transcript below shows selected
fields from actual outputs, with fixture names, SSH aliases and local paths
replaced by placeholders. Every listed CLI operation exited zero.

## Live result matrix

| Runtime | Registration | Platform trust | ECC stdout | Remote logs | Teardown |
| --- | --- | --- | --- | --- | --- |
| Linux native ZIP | Up | validated=true | `JSN_MID_260_NATIVE_LINUX_OK` | 25 lines | Owned runtime/files and MID record gone |
| Linux Docker | Up | validated=true | `JSN_MID_260_FINAL_DOCKER_OK` | 30 lines | Container, volume, network, image and MID record gone |
| Windows native ZIP, clean final install | Up | validated=true | `JSN_MID_260_FRESH_WINDOWS_OK` | 30 lines | Service, processes, files and MID record gone |

Linux native and Docker start/stop were also exercised. Native Linux inspection
survived a separate SSH connection. Windows was independently inspected as a
running `NT AUTHORITY\LocalService` service with `StartMode=Auto`; its actual
service DACL granted that account START and STOP. Platform validation exercised
the MID's own service restart. No reboot or RDP was used.

## Selected Windows terminal round trip

The password was piped from a private fixture, never included in command arguments.

```sh
node bin/jsn.js --profile pdi midservers add --ssh "$WINDOWS_SSH" \
  --name "$MID" --username "$MID_USER" --password-stdin \
  --install-method direct --directory "$CONTROL_DIR" \
  --wait-timeout 600000 --json --force
# {"ok":true,"data":{"registration":"up","validated":false}}

node bin/jsn.js --profile pdi midservers validate "$MID" \
  --timeout 600000 --json --force
# {"ok":true,"data":{"validated":true}}

node bin/jsn.js --profile pdi midservers execute "$MID" \
  --command 'echo JSN_MID_260_FRESH_WINDOWS_OK' --json --force
# {"ok":true,"data":{"response":{"stdout":"JSN_MID_260_FRESH_WINDOWS_OK"}}}

node bin/jsn.js --profile pdi midservers logs "$MID" --ssh "$WINDOWS_SSH" \
  --directory "$CONTROL_DIR" --tail 30 --json --force
# 30 agent log lines returned

node bin/jsn.js --profile pdi midservers remove "$MID" --ssh "$WINDOWS_SSH" \
  --directory "$CONTROL_DIR" --json --force
# {"ok":true,"data":{"remote_runtime_removed":true,"record_deleted":true}}
```

Linux native used the same command surface with `--native-platform linux` and
`--install-method direct`. Docker used `--install-method docker`. Both passed the
same explicit platform trust and ECC round trip; no direct validated-field writes
were used.

## Problems found by the live Windows run

Earlier attempts authenticated successfully but failed vendor startup permission
checks. The vendor enforcement allow-list depends on USERDOMAIN; the SSH admin
and LocalService contexts produced different lists/hashes, causing a fresh
runtime to remove its own access. Installation now runs the unmodified vendor
enforcer with the service domain context and restores the controller environment
in `finally`. The final clean install needed no manual permission repair.

The security log also showed validation's `restartService` request, while an
owned `mid.bat restart` controller remained waiting. The installer now grants
LocalService START/STOP on only the unique MID service. A leftover owned wrapper
process also exposed a teardown lock: removal now verifies exact executable and
process identity before terminating a leftover owned process after service
unregistration, then deletes the owned files. Service removal and cleanup were
repeated successfully after the final clean run.

Windows reported an unexpected hostname because its existing hosts file mapped
the host's LAN address to `host.docker.internal`; reverse lookup returned that
name. The MID was a native Windows service. No host-file or DNS changes were made.
Windows Docker Desktop's credential helper failed under the SSH logon; this is
recorded as an environment limitation, not a passing Windows Docker install.

## Independent cleanup verification

After the CLI reported removal, fresh SSH/API reads confirmed:

- All five Windows trial services and directories absent; no processes executing
  from any owned installation; the separate vendor-inspection ZIP deleted.
- Final Docker container, volume, labeled network and image absent. The first
  test's legacy Compose network was separately checked for its exact project
  label and zero attached containers before removal.
- Native Linux directory absent and no runtime remaining after verified stop.
- Both disposable MID names absent from `ecc_agent`.
- Disposable MID-role account and owned role assignment removed; account absence
  verified. ECC audit records were retained.

Local nonsecret ownership receipts remain. The plaintext fixture credential file
was deleted after all runtimes and the disposable account were gone.

## Regression verification and limits

Full final suite: **1,631 passed, 2 skipped, 0 failed** (1,633 total). Full lint,
focused runtime/safety tests, whitespace checks and the local documentation drive
passed. GitHub CI and documentation-site checks passed for runtime source
`f759100`; this evidence addition changes documentation only.

The controller was POSIX. Native remote log reads are bounded tails; Docker also
supports follow with viewer-only cancellation. Native Linux is a non-root user
background process, without systemd/reboot persistence. The test does not certify
other distributions or vendor support. Windows automatic startup was configured
and inspected, but a host reboot was not part of the authorized test. SSH password
prompt support is not implemented: the transport needs noninteractive SSH access
through a key, agent or an authenticated connection.
