// Bounded, real specialized CLI proof. Publishes only counts/boolean assertions,
// never the parent record, relationship IDs, private field values or commands.
import { spawnSync, execFileSync } from 'node:child_process';
const profile = process.argv[2] || 'pdi';
const common = ['bin/jsn.js', '--profile', profile, 'tables', 'show', 'incident', '--related', '--related-limit', '5'];
function run(flags) {
  return spawnSync(process.execPath, [...common, ...flags], { encoding: 'utf8', timeout: 45000,
    env: { ...process.env, JSN_NO_PROMPTS: '1', JSN_NO_HEADER: '1', JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' } });
}
const json = run(['--json']);
let output;
try { output = JSON.parse(json.stdout); } catch { output = {}; }
const related = output.data?._related;
const human = run(['--styled']);
const extraction = run(['--json', '--get', 'data._related.nonempty.0.count']);
let extracted = null; try { extracted = JSON.parse(extraction.stdout); } catch { /* Failure remains explicit. */ }
const firstCount = related?.nonempty?.[0]?.count;
const evidence = { checked_at: new Date().toISOString(), implementation_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  profile, command: `node bin/jsn.js --profile ${profile} tables show incident --related --related-limit 5`,
  safe_target: 'sys_db_object metadata definition; no business record or related rows requested', configured_descriptor_limit: 5,
  json: { exit: json.status, ok: output.ok || false, related_present: !!related,
    descriptor_count: related?.lists?.length ?? null, available_counts: related?.lists?.filter(item => item.count !== null).length ?? null,
    nonempty_count: related?.nonempty?.length ?? null, first_nonempty_count: firstCount ?? null,
    coverage: related?.coverage?.state ?? null, commands_pin_selected_profile: related?.nonempty?.every(item => item.command?.includes(`--profile ${profile}`)) ?? false,
    commands_pin_instance: related?.nonempty?.every(item => item.command?.includes('--instance ')) ?? false },
  human: { exit: human.status, related_heading: human.stdout?.includes('─ Related lists ─') || false,
    retrieval_hint: human.stdout?.includes('Retrieve: jsn records list') || false, coverage_visible: human.stdout?.includes('Coverage: ') || false },
  extraction: { exit: extraction.status, path: 'data._related.nonempty.0.count', value: extracted,
    matches_json: extracted === firstCount }, writes: 0, context_selection_changes: 0 };
evidence.ok = evidence.json.exit === 0 && evidence.json.related_present && evidence.human.exit === 0
  && evidence.human.related_heading && evidence.human.retrieval_hint && evidence.human.coverage_visible
  && evidence.extraction.exit === 0 && evidence.extraction.matches_json;
process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
if (!evidence.ok) process.exitCode = 1;
