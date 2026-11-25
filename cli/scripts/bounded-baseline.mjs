#!/usr/bin/env node
// Run from the repository root. No live mode or provider credentials accepted.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { measureBaseline, budgetPath } from '../test/support/bounded-baseline.js';

const args = process.argv.slice(2);
const allowed = new Set(['--output', '--repetitions', '--record-baseline']);
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw new Error(`Unknown argument ${args[i]}`);
  if (args[i] !== '--record-baseline') { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing argument value'); i++; }
}
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const recording = args.includes('--record-baseline');
const result = await measureBaseline({ repetitions: Number(value('--repetitions', '5')),
  budgets: recording ? undefined : JSON.parse(fs.readFileSync(budgetPath, 'utf8')) });
result.source_sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' }).trim();
result.source_dirty = execFileSync('git', ['status', '--porcelain'], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' }).trim() !== '';
if (recording) {
  fs.writeFileSync(budgetPath, JSON.stringify({ rationale: 'Exact maximum observed stdout/stderr bytes for pinned fixture, three or more fresh runs. No padding or universal limit. Deliberate fixture/envelope changes require review and explicit re-recording. A stable fixture.example.test CLI identity is routed to random loopback HTTP ports by the test transport; measured stdout bytes are unmodified.',
    fixture_sha256: result.fixture_sha256,
    cases: Object.fromEntries(result.cases.map(c => [c.id, Object.fromEntries(['stdout_bytes', 'stderr_bytes'].map(k => [k, Math.max(...c.samples.map(s => s[k]))]))])) }, null, 2) + '\n');
  result.status = 'recorded-not-budget-checked';
}
const output = path.resolve(value('--output', 'bounded-baseline-results'));
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
const lines = ['# Bounded JSN baseline', '', `Status: ${result.status}. JSN ${result.version}, Node ${result.node}. Source ${result.source_sha}, dirty=${result.source_dirty}.`,
  `Fixture SHA256 ${result.fixture_sha256}. Provider ${result.provider}. ${result.repetitions} repetitions per case.`, '',
  result.process + '. ' + result.cache + '.', result.timing + '.',
  'Tokens unavailable. All sizes are UTF-8 stdout/stderr bytes, not token counts or wire bytes.',
  'Raw flat references only. Display/both reference labels are not lossless raw-ID equivalents in CSV/TSV.',
  'Local correctness passed. Live dual-vendor trends not exercised; integration pending PR490.', '',
  '| Case | Rows | stdout bytes | stderr bytes | HTTP/count calls | median ms | p95 ms |', '|---|---:|---:|---:|---|---:|---:|'];
for (const c of result.cases) {
  const s = c.samples[0]; lines.push(`| ${c.id} | ${s.rows} | ${s.stdout_bytes} | ${s.stderr_bytes} | ${s.http_calls}/${s.count_calls} | ${c.elapsed_ms.median.toFixed(2)} | ${c.elapsed_ms.p95.toFixed(2)} |`);
}
lines.push('', '## Count overhead', '', 'Unpaired difference of JSON medians, measurement only. Each count adds one sequential stats GET.');
for (const c of result.count_overhead) lines.push(`- ${c.table}: ${c.median_count_minus_no_count_ms.toFixed(2)} ms`);
lines.push('', 'Exact commands and individual samples are in results.json. Section selection retains ancestor context and complete subtree, not guaranteed semantic answer completeness.');
fs.writeFileSync(path.join(output, 'REPORT.md'), lines.join('\n') + '\n');
console.log(`${result.status}: ${result.cases.length} cases, ${result.cases.reduce((n, c) => n + c.samples.length, 0)} fresh CLI processes; ${output}`);
