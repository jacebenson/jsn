# Command discovery and picker parity

Tracking: #320 / #328. The skill integration is a separate change.

## Discovery contract

`jsn discover [query]` matches words against live registered names, aliases,
descriptions, child action descriptions, and optional command-owned metadata.
`--table` selects an exact configured table. An unknown/custom table returns an
explicit pointer to `jsn records list --help`; it does not imply the table is
unsupported. Discovery runs without an instance or authentication.

The shared developer and ticket factories publish their actual table/default
column configuration. Show extensions are marked only where a factory has an
`onShow` hook; the marker does not promise relationships in JSON. Other commands
remain discoverable by their registrations and action descriptions. For example,
`jsn discover "attachments catalog variables"` finds the enriched requests show
handler, and `jsn requests show --help` describes its attachments and variables.

Names, descriptions, aliases and exact help paths come from the same live tree
that dispatches commands. A new registration appears automatically; replacement
registrations update the description/actions without a separate discovery map.
This is text matching, not a semantic search model.

Root help and `discover --help` give runnable examples for cross-table task
searches, custom tables, configured specialized views and raw endpoints. Generic
records is a supported choice; discovery adds no warning to records or REST
operations. Existing eval safety and REST read-only guards remain unchanged.

## Picker audit

The old skill claim that **all list commands** use the same picker was false.
The replacement root help describes shared controls and explicitly scopes them
to commands that offer a picker. This is suitable for removing duplicated
mechanics without pretending every command has identical eligibility.

Source audit (`src/commands/`, `src/helpers.js`, `src/paginated-search.js`):

| Surface | Eligibility / search behavior |
| --- | --- |
| Shared developer factory | Interactive auto output, no explicit query; searches `name`. |
| Shared ticket factory | Interactive auto output, no query and offset zero; searches `number`. |
| `records list` | Shared picker unless `--sys-id`; searches `sys_id`, including with a base query. |
| Users / groups / logs | Shared picker; search fields are `user_name`, `name`, `message` respectively. |
| Flows / catalog items / scopes / update sets / domains / forms / decision tables | Shared picker; search field `name`; each handler supplies its base query and columns. |
| CMDB list | Shared picker with no explicit query and offset zero; searches `name`. |
| ATF test/suite lists | Shared picker; searches `name`; explicit suite filtering can use a direct list path. |
| Approvals list / skipped-updates | Shared picker; search fields `sys_id` / `target_name`; approval filters and skip-review options remain command-specific. |
| Lists | Table picker (`name`) then list picker (`view`), rather than a uniform table list. |
| MID / scope / update-set selection | Some action paths use the shared picker for selection rather than a list result. |
| Perf / customization saved runs | Local saved-run selectors use paginated search in selected action paths; their `list` output is not a server-side LIKE picker. |
| Other list actions | No guarantee of a picker; examples include record attachments and registry-derived parent action lists. |

The shared picker uses ten visible choices, arrow navigation, type-to-search,
Enter selection and Esc cancellation. Scrolling fetches more unfiltered records;
server-side search is bounded by the configured limit and does not promise
unlimited search pagination. Shared `interactiveList` skips explicit formats and
noninteractive execution. Some callers handle cancellation differently; this
change documents controls rather than changing that behavior.

## Skill integration now permitted

- Replace Discovery / Interactive Picker sections with a concise pointer to
  `jsn --help` / `jsn discover --help`; keep output-mode guidance.
- Remove the rigid Command Hierarchy and Key Commands catalog. Keep the separate
  eval approval/no-protection-bypass safeguard.
- Remove Table/raw REST examples: existing command help carries these examples
  (`test/records-rest-help.test.js`).

`test/command-discovery.test.js` proves registry addition/replacement, enriched
action matching, exact table filter, custom-table fallback, JSON extraction,
human output and root help. Existing completion/help/output-contract tests
cover compatibility. This audit does not close the other #328 dependencies.
