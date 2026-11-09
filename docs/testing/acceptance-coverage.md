# Acceptance coverage ledger

Baseline `2df7c2baa87219e62d105941ccaeafbf6f86bbeb`, CLI `5.4.0`. Initial platform is Linux.

The [machine-readable ledger](../../cli/test/acceptance/coverage.json) inventories actual registered commands. It does **not** claim complete behavioral coverage. All acceptance bindings are pending. No live checks ran in this inventory lane.

## Runner integration contract

`schemaVersion: 1` is data, not a new test framework.

- `entries[].path` is the canonical registered token path. `signature` retains positional syntax. Aliases are alternate tokens, not extra capabilities. Keep every nested path, hidden compatibility entry and parent default handler.
- `entries[].effectiveOptions` contains IDs into `optionDefinitions`. IDs have the form `declaring path --name`; `$root` identifies global options. This represents inherited defaults and child overrides without duplicating definitions. Each definition includes aliases, type, repeatability, choices, default when declared, description and required assertions.
- `sources`, profile/discovery metadata and `baseline.sourceSha256` provide implementation and change-impact evidence. `declaredMutation` copies the real capability guard. It is not a network safety allowlist. Raw REST can mutate despite a GET-shaped request, and a no-instance family can contain a network handler.
- `mode` suggests `local`, `local-or-external-service`, `readonly` or `pdi`. `handlerEnvironment` refines reviewed local exceptions. Profile middleware can still demand instance configuration before a local handler. Always derive runtime network policy from actual scenarios, not this suggestion.
- `prerequisites` are requirement labels, not scenario IDs. Bind prerequisites to actual exported scenarios or explicit environment checks during integration. Do not invent scenarios for missing requirements.
- `existingTestRefs` means direct source association to a command implementation, not per-action assertion coverage. `sharedFactoryTestRefs` and `sharedSourceTests` keep reusable engine/parser/factory evidence separate. Every baseline test file, source imports, literal declaration titles and content digest is retained in `existingTests`. Dynamic tests and nested suite expansion are not counted from source strings.
- `acceptance.scenarioIds` and `workflowRequirements[].scenarioIds` intentionally start empty. Bind only real imported scenarios with matching canonical `commandPaths`. Unknown paths, unknown test references, duplicate IDs, missing dependencies and absent option/outcome assertions must fail reconciliation.
- Each path has required outcomes and each effective option needs explicit assertion/receipt binding. Common parsing, help, output and alias cases may share tests. A test exercising a generic factory does not prove every provider table, ACL, relationship or meaningful option on its consumers.
- Required results distinguish `not-run`, `passed`, `failed`, `blocked-prerequisite`, `blocked-access`, `unsupported-provider` and `excluded-live`. Missing bindings and zero checks keep acceptance incomplete. Inventory validation is not a behavioral pass.

## Observed inventory

| Inventory unit | Count |
| --- | ---: |
| Root families | 87 |
| Registered paths, including parents | 474 |
| Leaf registrations | 393 |
| Parent registrations | 81 |
| Hidden compatibility registrations | 4 |
| Alternate alias tokens across all levels | 237 |
| Effective path/option bindings | 7064 |
| Baseline test files | 178 |
| Paths with direct command-source test associations | 313 |
| Store paths excluded from live checks | 7 |
| Behavioral acceptance passes established here | 0 |

These counts come from recursively building the actual `LocalCLI` tree without parsing or dispatching handlers. The old root-only discovery view omitted deeper registrations and hidden commands. Factory replacement and alias collision ownership follow the real adapter's `register` method. Counts describe registrations, not successful supported outcomes.

The source registers `midservers <identifier>` with signature `<identifier> logs`. It is preserved as `registrationKind: positional-pattern-registration`, not silently renamed to a literal action. Its real dispatch needs behavioral verification. Implicit help, root first-run/discovery and completion plumbing are separate `builtins`; they are not extra root families.

## Existing offline evidence

A focused run reused five existing test files and returned **51 passed, 0 failed, 0 skipped**, exit 0. This is recorded in `focusedExecution`, and those files alone have `executionStatus: passed-offline-focused-run`. All other cataloged tests remain `not-run` in this lane.

```sh
cd cli
JSN_NO_VERSION_CHECK=1 JSN_NO_SKILL_CHECK=1 JSN_NO_WELCOME=1 node --test \
  test/actions.test.js test/capabilities.test.js test/cli-adapter.test.js \
  test/record-profiles.test.js test/records-engine.test.js
```

Source inspection and actual test output establish these limited contracts:

| Existing tests | Evidence exercised | Not established |
| --- | --- | --- |
| `actions.test.js` | Handler payload forwarding, definition extraction, output/error envelopes, schema validation, confirmation, exact deletion readback; actual executable help, usage errors and read-only-profile mutation refusal | Live action persistence, publication, runtime provider execution |
| `capabilities.test.js` | Real registry declarations, aliases, mutation paths and no-instance/daily-check policy | Provider ACLs, safe live mutation lifecycles |
| `cli-adapter.test.js` | Nested/alias parsing, defaults, positionals, boolean negation, repeated options, numeric/choice rejection, completion callback and help | Every feature-specific option contract |
| `record-profiles.test.js` | Declarative profile tables/aliases/defaults, validation, immutable definitions and factory hooks | Every factory-backed table and provider-specific behavior |
| `records-engine.test.js` | Bounded resolution, ambiguity refusal, reference preservation and actual CLI generic/ticket/factory reads/writes through synthetic transport | Live writeback and provider-side rules |

The catalog includes live opt-in tests but never runs them automatically. No full-suite result is asserted here. Existing tests whose filenames or imports mention a feature are leads for scenario binding, not passing capability receipts.

## Required workflows and safety boundaries

Every workflow below is **required, unbound and not run** in this lane. Actual implementations in other acceptance modules must be reconciled separately; this document makes no claim about their completion.

- `oauth-owned-fixture-lifecycle`: Authenticate via OAuth; create unique exact-ID fixtures, verify content independently, reject unsafe writes, cleanup/readback and restore original session context.
- `basic-cookie-targeted-auth`: OAuth creates attributable dedicated users and role links. Private isolated Basic and non-admin-cookie credentials; rejected renewal, expiry, account mismatch, permissions and auth-sensitive workflows; no admin elevation to hide ACL failure.
- `owned-update-set-promotion`: Owned capture and retrieved set only. Poll native preview/commit terminal trackers, verify provider state/content, stop on unresolved problems, restore original application/update-set session selection.
- `owned-flow-lifecycle`: Verify saved definition and preservation, owned publish plus test execution to terminal output/state, safe-edit acquisition/release and error/cancel no-write behavior. Never publish or execute pre-existing artifacts.
- `catalog-definition-to-fulfillment`: Create owned item, variables and dependent flow; order with variables; independently verify request/RITM and actual fulfillment outcome. An existing-item order or accepted submission alone is incomplete.
- `local-cli-lifecycle`: Use isolated HOME/XDG/workspace and controlled external-service/npm fixtures. Test setup/config persistence, cancellation, docs source modes, skill destination/content freshness, completion dispatch, history privacy/pruning, upgrade behavior and saved snippet round-trip. Never upgrade the real installation.
- `readonly-vendor`: Explicit read-only target, bounded reads, no eval or instance mutation; normal OAuth/session refresh allowed. These paths illustrate the lane, not an allowlist or proof of every read.
- `performance-context`: Actual before/after capture IDs, source/binary provenance, monotonic per-test timing and observed domain-separation traits or unknown. Non-gating; public sanitized projection, raw private evidence.
- `mid-dependent-dispatch`: Ready-state prerequisite only for dependent dispatch: Up and raw validated=true before job write; no provisioning or alteration of existing hosts.

Store is excluded from all LIVE modes, including discovery reads. Its offline tests stay required. Windows/macOS and third-party comparisons are deferred. Public result-site ingestion/display is pending outside this artifact. Performance is observational, not a release gate. MID availability blocks only a truly dependent operation; it never authorizes provisioning, general deployment changes or access to an existing host.

All mutations need exact run-owned fixture IDs, immediate ownership/dependency checkpoints, independent readback, bounded polling and cleanup readback. Preserve application/update-set/session selection. Use explicit keep/cleanup controls; never delete by broad prefix. Authentication refresh and session bootstrap are distinct from instance-record mutations.

Full OAuth workflow coverage is required for major/minor releases. Patches select impacted scenarios and their dependencies, with a full-run option. Shared auth/parser/output/SDK changes have broad impact. Binding the inventory does not grant release or live-execution authority.

## Executable inventory reconciliation

Run from the repository root. This command imports the real CLI, builds all nodes without handlers and checks exact path/signature/alias/option/guard parity, source/test digests and references. Four negative probes reject an uninventoried command, unknown test reference, unknown option and alias drift. Its result must still say `acceptanceStatus: incomplete`.

The reconciler deliberately uses the adapter's tree for inventory, not as a production command implementation. This is the precise boundary under audit. It does not infer behavior from implementation regexes or call a help mapping behavioral coverage.

```sh
probe_home=$(mktemp -d "${TMPDIR:?}/jsn-coverage.XXXXXX")
HOME="$probe_home" XDG_CONFIG_HOME="$probe_home/config" \
JSN_NO_VERSION_CHECK=1 JSN_NO_SKILL_CHECK=1 JSN_NO_WELCOME=1 JSN_NO_PROMPTS=1 \
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const repo=process.cwd();
const ledger=JSON.parse(fs.readFileSync('cli/test/acceptance/coverage.json','utf8'));
const {cli}=await import(pathToFileURL(path.join(repo,'cli/src/cli.js')));
const {isMutationCommand}=await import(pathToFileURL(path.join(repo,'cli/src/mutations.js')));
const sha=s=>createHash('sha256').update(s).digest('hex');
const specs=(spec,at)=>{
 const v={name:spec.name,declaredAt:at,type:spec.type||'boolean',aliases:typeof spec.alias==='string'?[spec.alias]:spec.alias||[],repeatable:spec.type==='array'||spec.array===true,description:spec.description||spec.describe||''};
 for(const key of ['choices','default','demandOption','requiresArg','hidden'])if(spec[key]!==undefined)v[key]=spec[key];
 return v;
};
function inventory(){
 const rows=[];
 function visit(node,parts=[],options=new Map()){
  node.build(); const tokens=[...parts,node.name].filter(Boolean),p=tokens.join(' ');
  const inherited=new Map(options);
  for(const [name,spec] of node.options)inherited.set(name,specs(spec,p||'$root'));
  if(p)rows.push({path:p,signature:node.definition.command,aliases:[...node.aliases],hidden:!!node.definition.hidden,kind:node.children.length?'parent':'leaf',hasHandler:typeof node.definition.handler==='function',children:node.children.map(c=>[...tokens,c.name].join(' ')),declaredMutation:isMutationCommand({_:tokens}),effectiveOptions:[...inherited.values()].sort((a,b)=>a.name.localeCompare(b.name))});
  for(const child of node.children)visit(child,tokens,inherited);
 }
 visit(cli.root); return rows.sort((a,b)=>a.path.localeCompare(b.path));
}
function validate(data,actual){
 assert.equal(data.schemaVersion,1);
 assert.equal(new Set(data.entries.map(e=>e.path)).size,data.entries.length,'duplicate path');
 assert.deepEqual(data.entries.map(e=>e.path),actual.map(e=>e.path),'registry drift: added or removed command');
 const testFiles=new Set(data.existingTests.map(t=>t.file));
 for(let i=0;i<actual.length;i++){
  const expected=data.entries[i],observed=actual[i];
  for(const key of ['signature','aliases','hidden','kind','hasHandler','children','declaredMutation'])assert.deepEqual(expected[key],observed[key],`${expected.path}: ${key}`);
  const resolved=expected.effectiveOptions.map(id=>{
   assert.ok(data.optionDefinitions[id],`unknown option ${id}`);
   const {requiredAssertions,...definition}=data.optionDefinitions[id];
   assert.ok(requiredAssertions.length>0);return definition;
  });
  assert.deepEqual(resolved,observed.effectiveOptions,`${expected.path}: option drift`);
  for(const ref of expected.existingTestRefs)assert.ok(testFiles.has(ref),`unknown test reference ${ref}`);
  assert.ok(expected.acceptance.requirements.length>0);
  for(const source of expected.sources)assert.ok(fs.existsSync(source),`missing source ${source}`);
 }
 for(const [file,digest]of Object.entries(data.baseline.sourceSha256))assert.equal(sha(fs.readFileSync(file)),digest,`source changed: ${file}`);
 for(const test of data.existingTests)assert.equal(sha(fs.readFileSync(test.file)),test.sha256,`baseline test changed: ${test.file}`);
 return actual.length;
}
const actual=inventory();const count=validate(ledger,actual);
cli.command({command:'zz-uninventoried-probe',handler:()=>{}});
assert.throws(()=>validate(ledger,inventory()),/registry drift/);
cli.root.children=cli.root.children.filter(node=>node.name!=='zz-uninventoried-probe');
const badRef=structuredClone(ledger);badRef.entries[0].existingTestRefs.push('cli/test/unknown-probe.test.js');
assert.throws(()=>validate(badRef,actual),/unknown test reference/);
const badOption=structuredClone(ledger);badOption.entries[0].effectiveOptions.push('$root --unknown-probe');
assert.throws(()=>validate(badOption,actual),/unknown option/);
const badAlias=structuredClone(ledger);badAlias.entries[0].aliases.push('unknown-alias-probe');
assert.throws(()=>validate(badAlias,actual),/aliases/);
console.log(JSON.stringify({inventoryStatus:'validated',registeredPaths:count,negativeProbes:4,acceptanceStatus:'incomplete',behavioralPasses:0}));
JS
```

When a source digest or registration changes, review and regenerate the ledger against the new exact revision; do not weaken the check or rewrite provenance to make it green. New tests from this acceptance change are not part of the pinned baseline test catalog. The parent binds their real exported scenarios after integration.

## Complete registered family/action inventory

Each row includes the parent and all descendant registrations. The JSON carries every signature, alias, option definition, mode, prerequisite and test reference. A parent with its own handler is an additional behavior, not only a container. Factory consumers retain distinct table/profile requirements even when they share implementation.

| Family | Descendant registered paths, relative to family | Declared mutation paths, relative to family | Root aliases |
| --- | --- | --- | --- |
| `acls` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `acl` |
| `actions` | `action-type-schema`, `create`, `definition`, `delete`, `help`, `list`, `show`, `step-types`, `test`, `update` | `create`, `update`, `edit`, `delete`, `test` | `action` |
| `aliases` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `alias`, `als` |
| `appmenu` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `app-menu`, `menu` |
| `appmodules` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `appmodule`, `am` |
| `approvals` | `approve`, `history`, `list`, `reject`, `submit` | `approve`, `reject`, `submit` | None |
| `assignments` | `list`, `show` | None declared | `assignment` |
| `asyncrules` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `asyncrule` |
| `atf` | `list`, `results`, `run`, `run-suite`, `suites` | `run`, `run-suite` | None |
| `attachments` | `download`, `list`, `upload` | `upload`, `add` | `attachment` |
| `auth` | `login`, `logout`, `modify`, `refresh`, `remove`, `status`, `switch` | None declared | None |
| `b4rules` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `b4rule` |
| `cases` | `list`, `search`, `show`, `tables` | None declared | `case` |
| `catalogitems` | `create`, `list`, `order`, `search`, `show` | `create`, `order` | `ci` |
| `catalogscripts` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `catalogscript` |
| `cataloguipolicies` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `cataloguipolicy`, `cup` |
| `changes` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `change_request`, `chg` |
| `clientscripts` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `clientscript`, `cs` |
| `cmdb` | `list`, `relationships`, `search`, `show` | None declared | None |
| `codesearch` | `search` | None declared | None |
| `columns` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `column`, `col` |
| `completion` | No children; direct handler | None declared | None |
| `customizations` | `capture`, `compare`, `html`, `list`, `show` | None declared | None |
| `decisiontables` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `decisiontable` |
| `diff` | `record` | None declared | None |
| `discover` | No children; direct handler | None declared | None |
| `docs` | `install` hidden, `search` hidden, `show` hidden, `status` hidden | None declared | None |
| `domains` | `current`, `list`, `session-current`, `session-list`, `session-reset`, `session-set`, `set`, `show` | `set`, `session-set`, `session-reset` | `domain`, `dom` |
| `email` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `emails` |
| `eval` | No children; direct handler | parent itself | None |
| `flows` | `create`, `delete`, `doctor`, `executions`, `list`, `publish`, `schemas`, `show`, `status`, `test`, `unlock`, `update` | `create`, `update`, `edit`, `delete`, `publish`, `test`, `unlock` | `flow` |
| `forms` | `list`, `show` | None declared | `form`, `f` |
| `graphql` | No children; direct handler | parent itself | None |
| `groupmembers` | `add`, `list`, `remove` | `add`, `remove` | `groupmember`, `gmember`, `gm` |
| `grouproles` | `add`, `list`, `remove` | `add`, `remove` | `grouprole`, `grole`, `gr` |
| `groups` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `group` |
| `history` | `list`, `prune` | None declared | None |
| `import` | `list`, `show` | None declared | `imports`, `imp` |
| `incidents` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `incident`, `inc` |
| `includes` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `include`, `si` |
| `knowledge` | `search`, `show` | None declared | `kb` |
| `listcontrols` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `listcontrol`, `lc` |
| `lists` | `list`, `show` | None declared | `list-layout`, `l` |
| `logs` | `follow`, `list`, `show` | None declared | `log` |
| `midservers` | `<identifier>`, `add`, `events`, `execute`, `issues`, `list`, `logs`, `remove`, `show`, `start`, `stop`, `validate` | `add`, `remove`, `execute`, `start`, `stop`, `validate` | `midserver`, `mid` |
| `perf` | `capture`, `compare`, `list`, `show`, `transactions`, `transactions top` | None declared | `performance` |
| `platform` | `health`, `stats` | None declared | None |
| `privileges` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `privilege`, `priv` |
| `properties` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `property`, `prop` |
| `records` | `aggregate`, `bulk`, `create`, `delete`, `get`, `inspect`, `list`, `update`, `watch` | `create`, `update`, `delete`, `bulk` | None |
| `relationships` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `relationship`, `rel` |
| `requests` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `sc_req_item`, `req` |
| `rest` | No children; direct handler | parent itself | None |
| `restmessage` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `rm`, `restmsg` |
| `roles` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `role`, `r` |
| `rules` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `rule`, `br` |
| `scan` | `cancel`, `checks`, `checks activate`, `checks create`, `checks deactivate`, `checks delete`, `checks list`, `checks show`, `checks update`, `results`, `run`, `status`, `suites`, `suites activate`, `suites add-check`, `suites create`, `suites deactivate`, `suites delete`, `suites list`, `suites remove-check`, `suites show`, `suites update` | `checks create`, `checks update`, `checks delete`, `checks activate`, `checks deactivate`, `suites create`, `suites update`, `suites delete`, `suites activate`, `suites deactivate`, `suites add-check`, `suites remove-check`, `run`, `cancel` | None |
| `scheduledjobs` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `scheduledjob` |
| `scopes` | `create`, `list`, `set`, `show` | `create`, `set` | `scope`, `sc` |
| `scrapi` | `create`, `list`, `show` | `create` | `scripted-rest`, `rest-api` |
| `scriptactions` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `scriptaction` |
| `setup` | No children; direct handler | None declared | None |
| `skill` | `check`, `fetch`, `install`, `path`, `show` | None declared | None |
| `skipped-updates` | `list`, `preview`, `process`, `review` | `process` | None |
| `snippets` | `delete`, `list`, `run`, `save`, `show` | None declared | None |
| `soapmessages` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `soapmsg` |
| `sppages` | `list`, `show` | None declared | `sp-pages` |
| `spwidgets` | `list`, `show` | None declared | `sp-widget`, `widgets` |
| `store` | `install`, `list`, `search`, `show`, `status`, `update` | `install`, `update` | None |
| `tables` | `behavior`, `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `table`, `t` |
| `tasks` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `sc_task`, `task` |
| `tickets` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `ticket` |
| `transactions` | No children; direct handler | None declared | None |
| `triggers` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `trigger` |
| `uiactions` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `uiaction`, `ua` |
| `uimacros` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `uimacro` |
| `uipages` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `ui-page`, `pages` |
| `uipolicies` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `uipolicy`, `up` |
| `updatesets` | `commit`, `complete`, `create`, `export`, `ignore`, `import`, `list`, `parent`, `preview`, `problems`, `reopen`, `set`, `show` | `create`, `set`, `complete`, `ignore`, `parent`, `import`, `reopen`, `preview`, `commit` | `updateset`, `us` |
| `upgrade` | No children; direct handler | None declared | `update` |
| `users` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `user` |
| `uxapplicability` | `list`, `show` | None declared | `uxapp` |
| `uxlists` | `list`, `show` | None declared | `uxlist` |
| `uxscripts` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `uxscript`, `ux` |
| `version` | No children; direct handler | None declared | None |
| `views` | `create`, `delete`, `list`, `show`, `update` | `create`, `update`, `delete` | `view`, `vw` |
| `workflows` | `list`, `show` | None declared | `workflow` |

## Meaningful-option obligations

All registered option definitions are in `optionDefinitions`, with declaring path and original help description. Effective bindings preserve child overrides. The following shared groups avoid a Cartesian product without losing feature-specific semantics:

- Output and extraction: auto/TTY, JSON, human formats, CSV/Markdown/quiet/styled shortcuts and precedence, envelope extraction and missing paths, stdout/stderr and nonzero error contracts. Preserve feature-specific shapes and human summaries.
- Target and policy: profile/instance aliases, audience filtering, read-only refusal, confirmation, safe capture context and mutation-history reason privacy. Target pinning precedes network.
- Queries and projection: fields/columns, display/raw/both references, query constraints, ordering, bounds, continuation and count uncertainty. A short page is not completeness.
- Payloads: repeatable field order and precedence, JSON/file inputs, malformed or absent documents, identifier resolution, scope, preview/dry-run no-write evidence and writeback verification.
- Wait and execution: bounded timeout/polling, terminal provider errors, cancellation, uncertain dispatch outcomes without blind resubmission, real runtime outputs.
- Local configuration and paths: isolated directories, permissions, overwrite refusal, restoration, retention, credential/body redaction, installation source/destination and upgrade channel semantics.
- Family-specific options: use the declared description, choices and default plus exact provider outcome assertions. Examples include catalog variables/requested-for, flow definition/input maps and publication/test separation, retrieved-update-set XML validation/commit prerequisites, domain configuration versus live session domain and MID local/remote methods. Global-parser success cannot satisfy these.

`requiredAssertions` is a candidate contract per option type. A shared scenario may satisfy many primitive parsing checks. If an option has no observable effect in a particular mode or cancellation path, bind an explicit evidenced not-applicable decision instead of silently dropping it. Hidden compatibility spellings and command aliases still require dispatch equivalence, not duplicate provider lifecycles.
