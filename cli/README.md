# JSN: ServiceNow CLI

A command-line interface for ServiceNow. Read and update records, manage flows, inspect platform data, and automate routine work from your terminal or AI agent.

## Install

Supports the current Node.js LTS release. Supports macOS, Linux, and Windows.

```bash
npm install -g @jacebenson/jsn
jsn setup
```

See the [setup guide](https://github.com/jacebenson/jsn/blob/main/docs/docs-setup.md) to connect an instance safely.

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

Publishing uses npm trusted publishing (OIDC) and advances the channel's dist-tag.
CI/CD does not deprecate older versions or require an `NPM_TOKEN` secret. Older
versions remain available; their availability does not extend the support window.

The optional maintenance script `scripts/deprecate-old-versions.mjs` can preview
older versions with `node scripts/deprecate-old-versions.mjs latest` (or `dev`).
Applying deprecations with `--apply` requires npm authentication and
`NODE_AUTH_TOKEN`; it is separate from publishing. The script requires the
checkout's package version to match the channel's current npm tag.

## Try it

```bash
jsn incidents list --query "active=true^priority=1"
jsn records list --table incident --limit 10 --json
jsn flows list
```

Run `jsn --help` for the command list. See the [CLI guide](https://github.com/jacebenson/jsn/blob/main/docs/cli-guide.md) for authentication, output formats, development, and examples. The [docs site](https://jacebenson.github.io/jsn/) has feature guides.

## AI agents

JSN includes a skill for Claude Code, OpenCode, Hermes, Cursor, Copilot, and other agents. Use `jsn skill install --target all` to install it or `jsn skill show` to inspect it.

## Development

```bash
cd cli
npm ci
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

`show` is the one view of an item — `describe` and `inputs` are aliases for it.
It reads the item twice and answers once: the Table API gives the definition
(`sc_cat_item` plus `item_option_new`), and
`/api/sn_sc/servicecatalog/items/{id}` gives what this account can actually
request. The catalog API wins when it answers; the definition list keeps the
command working when it does not, with `variables_source` naming which one
answered and `variables_api_error` carrying the reason for the fallback.

Questions come back as `{name, label, type, friendly_type, mandatory,
instance_supplied}` with `required_variables` and `instance_supplied_variables`,
so a script can build the payload without guessing names or types. Layout
entries that draw the form but hold no value — containers, labels, HTML and rich
text blocks, breaks and UI macros — are not reported as questions; only their
container children are walked. `required_variables` excludes the
instance-supplied ones: "Requested for" (type 31) is mandatory in the API
payload, but the instance fills it from the session and `--requested-for`
overrides it. `order` refuses locally when a required question is missing and an
unknown variable name is reported as `unknown_variable_names` without blocking.
The server remains the authority.

What the API returns is what a caller can send: questions withheld by a catalog UI
policy are absent, and a policy-applied mandatory flag is not visible here, so the
server still decides at submission. Record producers and order guides expose their
variables but are not orderable through `order`.

Orders use `order_now`, preserving catalog fulfillment rather than inserting an
RITM directly. `order_now` returns the request (REQ); JSN then reads the request's
items and reports `request_id`, `request_number` and `requested_items`
(`sys_id`/`number`). If that follow-up read is denied, the order is still
reported as placed with `requested_items_readable: false` — inspect requests
rather than resubmitting. The command handles standard catalog items; record
producers and order guides require separate workflows. Server rules validate
dynamic variables at submission; a preview does not validate those rules.
Preview output lists variable names and required names, not entered values.
Previews only read, so they work on a read-only profile; submitting requires a
write-enabled profile and no development update set. Confirmation follows the
existing profile policy; automation can supply `--force` only for an approved
order. Timeout or incomplete response is an uncertain outcome: inspect requests
before retrying. JSN does not automatically submit a second order.
`create/list/show` retain their definition-management behavior.

See the [Service Catalog API reference](https://www.servicenow.com/docs/r/api-reference/rest-apis/c_ServiceCatalogAPI.html).

### Viewing service and HR cases

`jsn cases list`, `jsn cases show <number>` and `jsn cases search "<text>"` read
cases through the normal authenticated Table API. Which case table is meant
depends on the installed application, so JSN probes the known case tables in
order — `sn_customerservice_case` (Customer Service Management), then
`sn_hr_core_case` (HR Service Delivery) — and uses the first one the profile can
read. `jsn cases tables` reports each candidate without claiming access, and
`--table <name>` names any other case table.

```bash
jsn cases list --json
jsn cases list --hr --query "active=true"
jsn cases search "printer" --table sn_customerservice_case
jsn cases show CS0001001
```

Visibility is not widened by JSN: application roles and ACLs decide which
records are returned, and a denied table reports `forbidden` (HTTP 403) rather
than an empty list. An instance without a case application reports which tables
were unavailable instead of pretending there are no cases, and naming such a
table with `--table` fails the same way (`Reading <table> failed (HTTP 400)`,
exit 2) instead of printing an empty list. To scope a list to the connected
account, add a query term — field names differ per application, for example
`--query "opened_by=javascript:gs.getUserID()"`. These commands only read; case
work that changes state stays in the application UI or `jsn records update`.

HR cases are a thin addition over this generic path: `--hr` selects
`sn_hr_core_case`. Employee self-service visibility depends on the HR roles and
ACLs of the connected account — an administrator profile does not represent an
employee's view. HR case tasks, relations and the employee portal's widgets are
not exposed yet.

## Domain configuration and browser sessions

`jsn domains current` reports the selected profile's configured `X-Now-Domain`
header. `domains set <name-or-id>` and `domains set clear` configure that header
locally. Header effectiveness depends on the instance; clearing it does not
reset the actual server session domain.

With saved browser-session (`gck`) credentials, use these explicit commands:

```bash
jsn domains session-current --profile example --json
jsn domains session-list --profile example --search '*Internal' --limit 20 --offset 0 --json
jsn domains session-reset --profile example --json
jsn domains session-list --profile example --json
jsn domains session-set <domain-sys-id> --profile example --json
```

`session-list` returns one picker-visible page (`items`, `offset`, `limit`,
`next_offset`). Search matches a name prefix, or a substring with a leading `*`.
Visibility depends on the actual session domain. For cross-branch selection,
explicitly reset to global, then list and select a domain from that result.
Neither listing nor selecting silently resets the session. `session-current`
reports both `configured_domain` and `session_domain`.

**Session reset and selection may affect a browser sharing these credentials.**
Both commands verify the resulting domain with a separate readback. They leave
profile configuration unchanged and omit the configured domain header on picker
requests. Save the original domain ID from `session-current` if you intend to
restore it afterward. A failed readback can leave the session changed; inspect
`session-current` before retrying. These commands do not call `touch-session`.
Other authentication methods retain the existing profile configuration flow.

## Documentation search

```bash
jsn docs "GlideRecord" --limit 5
jsn docs --path "api-reference/c_GlideRecordClientSideAPI.md"
```

No ServiceNow connection is required. Hosted docs at `https://jsn.jace.pro` are
the default and download no database. `jsn setup` asks once for defaults for new
connections and whether to use hosted documentation. Decline hosted docs to let
JSN start a local server, or decline that too and enter your own service base URL.
Later changes live under **Defaults and documentation** in setup. Existing connections
keep their saved settings.

Local mode downloads the public documentation on first use and checks for updates
daily while running. The server starts again automatically when needed. A first
search can report that the index is still being prepared; later updates preserve
the last working index if offline. Local storage lives under
`~/.jsn/docs/docs.db` for the default family. Other families use
`~/.jsn/docs/releases/NAME/docs.db`. `JSN_DATA_HOME` overrides the parent directory.
Existing default-family installs keep their original index path.

To host the same service yourself, run `jsn docs --serve --host 0.0.0.0 --port 3000`.
It manages its own index; expose it through your normal HTTPS proxy. The hosted
website and this server share one search engine. `JSN_DOCS_URL` temporarily
overrides the saved choice without starting a local server.

Choose a family with `jsn docs "GlideRecord" --release brazil`. The same option
applies to `--path`, `docs show <ID>`, `docs status`, `docs sync`, `docs install`
and `--serve`. Resolution is `--release` first, then the optional `docs.release`
preference, then `australia`. Release names contain 1–40 lowercase letters,
digits or dashes. The service decides which families exist.

Documentation preferences are saved in the global profile config at
`$XDG_CONFIG_HOME/servicenow/config.json`, normally
`~/.config/servicenow/config.json`. Alongside `docs.source` and `docs.url`, set
`docs.release` without changing the service URL:

```json
{ "docs": { "source": "hosted", "url": "https://jsn.jace.pro", "release": "brazil" } }
```

`jsn docs releases` lists installed families, revisions, document counts, index
paths and the default marker without contacting the network. To install an
optional local index, use `jsn docs install --source snapshot --release brazil`,
or `jsn docs sync --release brazil --no-embed`. Sync downloads the named Git
branch; `--no-ingest` downloads only the source. Snapshot installs use
`/docs-index/releases/NAME/manifest.json` and verify the declared release. Only
the default family can fall back to the old `/docs-index/manifest.json` when
the family manifest returns 404. That legacy manifest may omit `release`.
`jsn docs --serve --release brazil` serves only Brazil and rejects requests
for other families. Search, read and status JSON include the selected `release`.

Exact paths remain stable across revisions. Numeric IDs can be pinned with
`--revision <search-revision>`. Older `docs search`, `docs show` and `docs status`
spellings remain compatible but are omitted from the everyday help menu.
