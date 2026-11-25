// Deliberate release/coverage invariants: docs/DECISIONS.md, CI validation ownership.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { load } from 'js-yaml';

const root = new URL('../../', import.meta.url);
const read = (name) => load(fs.readFileSync(new URL(`.github/workflows/${name}.yml`, root), 'utf8'));
const workflows = Object.fromEntries(['ci', 'docs-site', 'docs-snapshot', 'promote-main-to-dev', 'publish-dev', 'publish-prod', 'release-prod'].map(name => [name, read(name)]));
const commands = job => job.steps.filter(step => step.run).map(step => step.run).join('\n');

function validate(w) {
  const ci = w.ci;
  assert.equal(ci.concurrency.group, 'ci-${{ github.event.pull_request.number || github.run_id }}');
  assert.equal(ci.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
  assert.deepEqual(ci.jobs.cli.strategy.matrix.os, ['ubuntu-latest', 'windows-2022']);
  assert.equal(ci.jobs.site.uses, './.github/workflows/docs-site.yml');
  assert.equal(ci.jobs.site.needs, 'changes');
  assert.equal(ci.jobs.site.if, "needs.changes.outputs.site == 'true'");
  assert.ok(ci.jobs.test.needs.includes('site'));
  assert.equal(ci.jobs.test.if, 'always()');
  assert.match(commands(ci.jobs.test), /test "\$SITE" = success \|\| test "\$SITE" = skipped/);
  const docs = w['docs-site'];
  assert.deepEqual(Object.keys(docs.on).sort(), ['workflow_call', 'workflow_dispatch']);
  const steps = docs.jobs.site.steps;
  const run = commands(docs.jobs.site);
  assert.equal((run.match(/docker build /g) || []).length, 1);
  assert.match(run, /--entrypoint bin\/test/);
  assert.match(run, /--test test\/sync-docs.test.mjs test\/markdown.test.mjs/);
  assert.match(run, /docker cp .*preserved-urls.json/);
  const artifact = steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(artifact.with.path, 'site/tmp/preserved-urls.json');
  assert.equal(artifact.with['if-no-files-found'], 'error');
  for (const name of ['docs-snapshot', 'promote-main-to-dev', 'publish-dev', 'publish-prod', 'release-prod']) {
    assert.equal(w[name].concurrency['cancel-in-progress'], false, name);
    assert.ok(!('workflow_run' in w[name].on), name);
  }
  for (const [name, environment] of [['publish-dev', 'dev'], ['publish-prod', 'prod']]) {
    assert.equal(w[name].permissions['id-token'], 'write');
    assert.equal(w[name].permissions.contents, 'read');
    assert.equal(w[name].jobs.publish.environment, environment);
    assert.match(commands(w[name].jobs.publish), /npm test/);
    assert.match(commands(w[name].jobs.publish), /npm run lint/);
  }
  assert.match(commands(w['publish-prod'].jobs.publish), /test "\$tag_version" = "\$package_version"/);
  assert.deepEqual(Object.keys(w['release-prod'].on), ['workflow_dispatch']);
  assert.deepEqual(w['release-prod'].on.workflow_dispatch.inputs.release_type.options, ['patch', 'minor', 'major']);
  assert.match(commands(w['release-prod'].jobs.release), /gh workflow run publish-prod.yml --ref main -f tag="\$TAG"/);
  assert.match(commands(w['promote-main-to-dev'].jobs.promote), /gh workflow run publish-dev.yml --ref dev/);
}

test('CI owns automatic website validation without weakening release boundaries', () => validate(workflows));

test('workflow guards reject regressions and pass after restoration', () => {
  const mutations = [
    w => { w.ci.concurrency['cancel-in-progress'] = true; },
    w => { w['publish-prod'].concurrency['cancel-in-progress'] = true; },
    w => { w['docs-site'].on.push = { branches: ['main'] }; },
    w => { w['docs-site'].jobs.site.steps = w['docs-site'].jobs.site.steps.filter(step => !step.run?.includes('--entrypoint bin/test')); },
    w => { w['docs-site'].jobs.site.steps = w['docs-site'].jobs.site.steps.filter(step => !step.run?.includes('test/markdown.test.mjs')); },
    w => { w['publish-dev'].jobs.publish.environment = 'prod'; },
    w => { w['release-prod'].on.push = {}; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(workflows);
    mutate(changed);
    assert.throws(() => validate(changed), assert.AssertionError);
    validate(workflows);
  }
});
