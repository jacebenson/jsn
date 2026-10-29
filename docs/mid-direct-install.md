# Direct MID Server ZIP installation

For SSH installation, native Windows services and remote Linux background
runtimes, see [remote MID management](mid-remote-management.md). The commands below
describe installation on the local controller.

```sh
jsn midservers add --install-method direct --name worker1
```

Run this from an interactive terminal. JSN prompts for a masked MID password,
validates the account with a read of `sys_properties.mid.version`, then asks for
the MID name and whether to prepare or start. There is no password flag. The
MID account must be able to read `mid.version`; validation does not prove every
permission the running MID needs.

The installer supports Linux and Windows x86-64. Other architectures and macOS
fail before download or file creation. It uses the instance's runtime release
string and its **final** build date to choose the official signed ZIP URL:

```text
https://install.service-now.com/glide/distribution/builds/package/app-signed/mid/YYYY/MM/DD/mid.<release>.linux.x86-64.zip
https://install.service-now.com/glide/distribution/builds/package/app-signed/mid/YYYY/MM/DD/mid.<release>.windows.x86-64.zip
```

No MSI, RPM, DEB, unzip, Python or extra runtime package is required. Downloads
have a ten-minute timeout and a 1 GiB size limit. JSN requires 3 GiB free space.
The built-in ZIP reader verifies CRC and bounds expanded content at 2 GiB. It
rejects traversal, absolute paths, Windows aliases, links, special files,
duplicate names and file/directory collisions. ZIP64 and split ZIPs are not
supported. The archives include `agent/` and signing files under `META-INF/`.
JSN preserves the signing files but does not independently verify their
cryptographic signature. Downloads use HTTPS without following redirects.

## Files and credentials

The default directory is `~/.servicenow/mids/<instance>/<name>`. Use
`--directory <path>` to select another directory. The target must not exist,
even if empty. Direct installation also refuses an existing MID record with
the same name rather than taking over a running MID. Existing Docker stacks,
services, records and directories are not overwritten.

JSN edits the vendor `config.xml`, preserves optional settings and comments,
and XML-escapes the URL, username, password and name. `mid.server.worker1`
becomes the configured name `worker1`. The ECC address prefix is separate.
The vendor template's `secure="true"` password attribute stays in place.

The vendor requires the instance password in `config.xml` before its first
startup encrypts it. Treat this file and any backup as a secret. Linux
installation directories are mode 0700 and non-executable files are 0600;
executables are owner-only. On Windows, JSN sets and reads back an inherited
DACL restricted to the current user's SID before downloading or writing
credentials. A failed ACL operation aborts preparation. Windows ACL execution
has not yet been verified on a Windows host; do not infer that proof from Linux
tests.

`.jsn-mid-direct.json` identifies the owner, instance, name, native platform,
release, directory and runtime state. It contains no credentials. Wrapper
names include a hash of the instance, name and directory to separate native
runtimes. Linux refuses a matching existing system service and configures the
bundled launcher to use the initd route without registering a service.

## Native runtime boundaries

### Linux

Use a non-root account. The wizard offers a user-owned background start through
`sh bin/mid.sh start`, or preparation without starting. It does not use sudo,
create accounts, modify system services or enable startup at boot.

```sh
jsn midservers start worker1
jsn midservers stop worker1
jsn midservers logs worker1 --tail 100
jsn midservers remove worker1
```

Pass the same `--directory` override to lifecycle commands when you used one
for installation. Logs read the last 1 MiB of `agent/logs/agent0.log`, with a
maximum of 10,000 lines. Native `--follow` is not supported. Compose log behavior
is unchanged.

A successful launcher exit means the start command completed, not that the
instance registered or trusted the MID. `start` on an installation that is
already started, and `stop` on a prepared installation, are refused rather than
guessed at. An interrupted start leaves state `uncertain`; the next lifecycle
command reports that and refuses to act until you confirm no vendor MID process
from the installation is running. The add workflow reads `ecc_agent`
until status is Up. Registration timeout leaves the runtime and files in place
for diagnosis. It does not force a teardown. Up is not readiness: only the raw
`validated=true` value counts. JSN prints the record URL and asks you to use the
manual **Validate** action when trust is pending. It never creates an
`ecc_agent` record or writes `validated`.

### Windows

The wizard prepares files only. `jsn midservers start worker1` invokes the
vendor `bin\mid.bat console` in the foreground terminal, not `start.bat`.
The latter can run `installstart` with administrator privileges and is
intentionally not used. A normal console exit returns the installation to
prepared state. Use Ctrl+C in the owning terminal to interrupt it.

Native Windows service registration is **not implemented**. There is no
implicit elevation, LocalSystem default, service password persistence or
service-account creation. Vendor service registration needs an explicitly
approved privileged operation and a verified non-admin account with **Log on
as a service**. That contract and an approved Windows test host are still
required before adding a service workflow.

If a Windows console command fails or is interrupted, JSN conservatively
retains uncertain runtime metadata and refuses automated stop/removal. Confirm
all wrapper/JVM processes from that installation have stopped before manually
recovering or deleting its owned directory. Automated recovery from this state
is a remaining Windows lifecycle limitation.

## Removal and failure recovery

Preparation failures remove only the newly created owned installation
folder. Parent directories can remain. A failed native start preserves files
and marks the runtime uncertain. Linux removal must successfully stop the
owned runtime before deleting local files or the instance record. A stop
failure blocks both cleanup and record deletion. Prepared-only installations
can be removed even before registration. Existing Compose removal remains on
its original path.

`remove` also deletes the selected ServiceNow MID record after local cleanup,
so use it only when record deletion is intended. There is no automatic rollback
of an instance record because this installer never creates one itself.

## Verification status

The implementation was exercised against both real official ZIP archives for
an Australia runtime release. Linux vendor files were extracted and configured
in scratch storage; permissions and the vendor `mid.sh status` command were
checked without starting a MID. A separate disposable local provider exercises
actual Linux process invocation for prepare/start/stop/remove. This does not
prove the vendor MID engine registered with ServiceNow.

Windows archive extraction and XML editing were exercised on Linux. Windows
PowerShell ACLs, `cmd.exe` console execution, Windows service registration,
Linux vendor background start, instance registration and manual trust
validation remain untested. Windows command-selection tests are mocks, not
Windows host installation proof.

Vendor references:

- [Install a MID Server on Linux](https://www.servicenow.com/docs/r/servicenow-platform/mid-server/t_InstallAMIDServerOnLinux.html)
- [Install a MID Server on Windows](https://www.servicenow.com/docs/r/servicenow-platform/mid-server/mid-server-install-prereqs.html)

The documentation's default release may differ from your instance. The script
and template checks here used Australia archives matching runtime `mid.version`.
