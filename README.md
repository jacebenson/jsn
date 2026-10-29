# JSN: ServiceNow CLI

A command-line interface for ServiceNow. Read and update records, manage flows, inspect platform data, and automate routine work from your terminal or AI agent.

## Install

Requires Node.js 22.5.0 or newer. Supports macOS, Linux, and Windows.

```bash
npm install -g @jacebenson/jsn
jsn setup
```

See the [setup guide](docs/docs-setup.md) to connect an instance safely.

### Dev channel

For the newest changes from `main`, including changes that may be unstable:

```bash
npm install -g @jacebenson/jsn@dev
```

Dev builds check the dev channel for updates during normal use, at most once
per day. Run `jsn version --check` to check immediately. To install the newest
dev build, run `jsn upgrade` (alias: `jsn update`). It preserves your installed
channel and skips installation when no newer version is available. Use
`--dry-run` to print the npm command without network access or installation,
`--force` to reinstall, or `--channel dev|latest` to switch channels explicitly.
For example, `jsn upgrade --channel latest` returns to stable. npm installation
permissions still apply; the command does not elevate privileges automatically.

Pushes to `main` promote the commit to `dev` and publish a tested prerelease
under npm's `dev` tag. Versions include the workflow run number and attempt
(for example, `4.3.9-dev.123.1`); they do not move npm's stable `latest` tag.
The npm trusted publisher for `publish-dev.yml` must authorize the repository's
`dev` GitHub environment, alongside the production publishing configuration.

### Knowledge search

Use `jsn knowledge search "VPN setup" --profile work` (alias `kb`) to search
accessible articles, then `jsn knowledge show KB0000010 --profile work` to read
one. Search supports bounded `--limit`/`--offset`, knowledge-base sys_ids with
`--kb`, and `--language`. JSON preserves native HTML; human output uses Markdown.
Hints preserve an explicitly selected profile/instance. The Knowledge API plugin
(`sn_km_api`) must be available; access is evaluated by that API, with no fallback
to direct table reads. Reads do not request view-count updates. See the
[Knowledge API reference](https://www.servicenow.com/docs/r/yokohama/api-reference/rest-apis/knowledge-api.html).

### Instance Scan

`jsn scan` manages checks and suites and runs scans against an explicit target.
Use `jsn scan --help` and each subcommand's `--help` to discover the options.

```bash
jsn scan checks list --profile dev
jsn scan checks create --type table --data-file check.json --profile dev
jsn scan checks activate <check-id> --profile dev
jsn scan suites add-check <suite-id> --check <check-id> --profile dev
jsn scan run --update-set "My change" --suite "My suite" --wait --profile dev
jsn scan run --table sys_script_include --record <record-id> --profile dev
jsn scan results <execution-id> --profile dev
```

Check types are `table`, `column`, `linter`, and `script`. Definitions are created
inactive unless the payload explicitly sets `active: true`; activation never
starts a scan. Both checks and suites support list/show/create/update/delete and
activate/deactivate. Suites also support add-check/remove-check.

Runs require an update set, scope, record plus table, or explicit `--full`.
Instance-wide scans may traverse many tables even when a check's script only
examines a few records. Starting and cancelling a scan require confirmation;
use `--force` only after approving that operation. `--wait --timeout 120` bounds
the wait, not the scan's lifetime. A timed-out wait keeps the execution id and
does not cancel or resubmit the scan. Use `status`, `results`, or `cancel` next.

Update-set scans examine current instance records, not the historical XML
versions. Inactive records may be skipped. Script-only checks do not participate
in record/update-set scans; use an explicitly instance-wide suite run to execute
them. Execution success does not mean zero findings or complete test coverage:
results report recorded check executions, finding counts, unreadable sources,
and truncated lists separately. A result's rerun hint preserves the previous
target combination and requires `--full` again for instance-wide scans.

Every command returns next-step breadcrumbs in human and JSON output, retaining
an explicitly selected profile or instance. `updatesets show` also offers a scan
hint. Recommendation/generation of new checks is not part of this command;
JSN contains no AI and does not infer missing business requirements.

### CMDB search

`jsn cmdb search "web" --profile work` searches names, FQDNs, IP addresses and
serial numbers on `cmdb_ci`. Use `--class cmdb_ci_server` for an exact class
match (excluding subclasses), and bounded `--limit`/`--offset` pagination.
Search text is literal; encoded-query operators and query scripts are rejected.
Existing `cmdb list --query` remains available for deliberate encoded queries.
Results include show/relationship hints and preserve the selected connection.

### Supported versions

Only the current release and the two preceding releases in each channel are
supported (three stable releases and three dev builds). For example, with
stable `4.3.11`, versions `4.3.11`, `4.3.10`, and `4.3.9` are supported.
Update to the newest version in your channel before reporting an issue.

After each successful npm publish, deployment deprecates older versions in that
channel. Deprecated versions remain installable and appear in history, but npm
prints an update warning on installation. Existing deprecation messages are
preserved. No versions are unpublished.

The deprecation step uses the repository's `NPM_TOKEN` secret with permission to
modify `@jacebenson/jsn` and noninteractive authentication (including bypass 2FA
where required). Publishing continues to use OIDC. A deprecation failure fails
the workflow after publishing; it does not roll back the published package.
To retry only deprecation after fixing authentication, use the matching release
checkout and run `node scripts/deprecate-old-versions.mjs latest --apply` (or
`dev --apply`) with npm authentication configured and `NODE_AUTH_TOKEN` set.
Omit `--apply` to preview the affected versions without changing npm. The script
requires the checkout's package version to match the channel's current npm tag.

## Try it

```bash
jsn incidents list --query "active=true^priority=1"
jsn records list --table incident --limit 10 --json
jsn flows list
```

Run `jsn --help` for the command list. See the [CLI guide](docs/cli-guide.md) for authentication, output formats, development, and examples. The [docs site](https://jacebenson.github.io/jsn/) has feature guides.

## AI agents

JSN includes a skill for Claude Code, OpenCode, Hermes, Cursor, Copilot, and other agents. Use `jsn skill install --target all` to install it or `jsn skill show` to inspect it.

## Development

```bash
npm install
npm test
```

## License

MIT


### Commands for the connected account

Login and OAuth refresh check for the current account's `admin` role. Profiles
without that role show a compact command list focused on tickets, generic
records, people/groups, documentation, and connection management. If the role
check is unavailable, the profile also uses compact help; this does not assert
that the account lacks admin. Existing profiles keep full help until renewed.

This applies to root help, root JSON, `discover`, and root shell completion.
Use `jsn --all-commands --help` or `jsn discover --all-commands --json` to inspect
every registered command. Explicit command paths remain available and ServiceNow
ACLs decide access. Reauthenticate (or refresh OAuth) after roles change.

### Ordering catalog items

Use `jsn catalogitems search "laptop" --profile work`, then
`jsn catalogitems describe <item-sys-id> --profile work` to inspect pricing and
variable definitions through the native Service Catalog API. Create a JSON file
mapping variable names to values, then preview with
`jsn catalogitems order <item-sys-id> --variables-file variables.json --dry-run --profile work`.
Omit `--dry-run` to submit after confirmation. `--quantity` defaults to one;
`--requested-for` accepts a user sys_id subject to instance delegation rules.

Orders use `order_now`, preserving catalog fulfillment rather than inserting an
RITM directly. The command handles standard catalog items; record producers and
order guides require separate workflows. Server rules validate mandatory and
dynamic variables at submission; a preview does not validate those rules. Preview
output lists variable names, not entered values. This operation requires a
write-enabled profile (also for previews), but no development update set.
Confirmation follows the existing profile policy; automation can supply `--force`
only for an approved order. Timeout or incomplete response is an uncertain
outcome: inspect requests before retrying. JSN does not automatically submit a
second order. `create/list/show` retain their definition-management behavior.

See the [Service Catalog API reference](https://www.servicenow.com/docs/r/api-reference/rest-apis/c_ServiceCatalogAPI.html).
