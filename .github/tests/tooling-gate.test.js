import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { load } = createRequire(new URL('../../cli/package.json', import.meta.url))('js-yaml');

test('required Tests gate rejects GitHub tooling failures without rerunning the CLI suite', () => {
  const workflow = load(fs.readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs.workflows;
  assert.equal(job.if, "needs.changes.outputs.cli == 'true'");
  assert.ok(job.steps.some(step => step.run === 'npm run test:workflows'));
  assert.ok(!job.steps.some(step => step.run === 'npm test'));
  assert.equal(job.steps.find(step => step.uses?.startsWith('actions/checkout')).with['fetch-depth'], 0);
  assert.ok(workflow.jobs.test.needs.includes('workflows'));
  const script = workflow.jobs.test.steps[0].run;
  const run = result => spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
    env: { PATH: process.env.PATH, TARGET: 'skipped', CHANGES: 'success', CLI: 'success', SITE: 'success', DOCS: 'skipped', WORKFLOWS: result },
  });
  for (const result of ['success', 'skipped']) assert.equal(run(result).status, 0);
  for (const result of ['failure', 'cancelled', '']) assert.notEqual(run(result).status, 0);
});
