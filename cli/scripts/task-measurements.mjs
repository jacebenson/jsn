#!/usr/bin/env node
// Offline only. Reuses independent byte/content/request verifiers from #491.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { measureBaseline, budgetPath } from '../test/support/bounded-baseline.js';
import { taskReport } from './task-report.mjs';
const catalogBytes = fs.readFileSync(new URL('../../site/static/benchmarks/bounded-reads-v1.json', import.meta.url));
const catalog = JSON.parse(catalogBytes);
const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error('Usage: node cli/scripts/task-measurements.mjs OUTPUT_DIRECTORY (offline only)');
const measured = await measureBaseline({ repetitions: 3, budgets: JSON.parse(fs.readFileSync(budgetPath)) });
const cwd = new URL('../..', import.meta.url);
const sourceSHA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
const report = taskReport(measured, catalog, createHash('sha256').update(catalogBytes).digest('hex'), sourceSHA);
report.sourceDirty = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim() !== '';
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'tasks.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`${report.tasks.length} bounded tasks verified; ${report.tasks.reduce((n, t) => n + t.samples.length, 0)} published samples. Offline fixture, not full acceptance. ${output}/tasks.json`);
