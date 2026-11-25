import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const yaml = createRequire(new URL('../../cli/package.json', import.meta.url))('js-yaml');
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const moduleUrl = new URL('../scripts/verify-production-release.mjs', import.meta.url);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jsn-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.name', 'Release test');
  git(source, 'config', 'user.email', 'release@example.invalid');
  mkdirSync(join(source, 'cli'));
  const commit = (version) => {
    writeFileSync(join(source, 'cli/package.json'), JSON.stringify({ version }));
    git(source, 'add', '.');
    git(source, 'commit', '-m', `release ${version}`);
    return git(source, 'rev-parse', 'HEAD');
  };
  const old = commit('1.0.0');
  git(source, 'tag', 'v1.0.0');
  const current = commit('1.1.0');
  git(source, 'tag', '-a', 'v1.1.0', '-m', 'annotated release');
  const remote = join(root, 'remote.git');
  git(root, 'clone', '--bare', source, remote);
  const checkout = join(root, 'checkout');
  git(root, 'clone', '--depth=1', '--no-tags', `file://${remote}`, checkout);
  return { root, source, remote, checkout, old, current, commit };
}

test('accepts an existing main tag and returns its immutable commit', async (t) => {
  const f = fixture(t);
  const { verifyProductionRelease } = await import(moduleUrl);
  const result = verifyProductionRelease({ cwd: f.checkout, remote: f.remote, tag: 'v1.1.0', eventName: 'workflow_dispatch', eventRef: 'refs/heads/main' });
  assert.deepEqual(result, { tag: 'v1.1.0', sha: f.current });
});

test('rejects non-production tag syntax before even accessing Git', async () => {
  const { verifyProductionRelease } = await import(moduleUrl);
  for (const tag of ['', 'main', 'v01.0.0', 'v1.0.0-dev.1', 'v1.0.0\n', '--upload-pack=bad', 'v1.0.0^{commit}']) {
    assert.throws(() => verifyProductionRelease({ cwd: '/does-not-exist', tag, eventName: 'workflow_dispatch', eventRef: 'refs/heads/main' }), /existing production version tag/, JSON.stringify(tag));
  }
});

test('production workflow gates publish on trusted-main verification and checks out only its SHA', () => {
  const workflow = yaml.load(readFileSync(new URL('../workflows/publish-prod.yml', import.meta.url), 'utf8'));
  const verify = workflow.jobs.verify;
  assert.ok(verify, 'a separate verification job must run before publish');
  assert.deepEqual(verify.permissions, { contents: 'read' });
  const bootstrap = verify.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(bootstrap.with.repository, 'jacebenson/jsn');
  assert.equal(bootstrap.with.ref, 'main');
  assert.equal(bootstrap.with['fetch-depth'], 0);
  assert.equal(bootstrap.with['persist-credentials'], false);
  const gate = verify.steps.find(step => step.id === 'release');
  assert.equal(gate.env.RELEASE_TAG, '${{ inputs.tag || github.ref_name }}');
  assert.equal(gate.run, 'node .github/scripts/verify-production-release.mjs');
  assert.equal(workflow.jobs.publish.needs, 'verify');
  assert.equal(workflow.jobs.publish.environment, 'prod');
  assert.equal(workflow.jobs.publish.permissions['id-token'], 'write');
  const steps = workflow.jobs.publish.steps;
  assert.equal(steps[0].with.ref, '${{ needs.verify.outputs.sha }}');
  const versionIndex = steps.findIndex(step => step.name === 'Verify tag matches package version');
  assert.ok(versionIndex > 0 && versionIndex < steps.findIndex(step => step.run === 'npm ci'));
  assert.equal(steps[versionIndex].env.TAG_VERSION, '${{ needs.verify.outputs.tag }}');
  assert.equal(steps[versionIndex].env.RELEASE_SHA, '${{ needs.verify.outputs.sha }}');
  assert.match(steps[versionIndex].run, /git rev-parse HEAD/);
  assert.ok(steps.some(step => step.run === 'npm test'));
  assert.ok(steps.some(step => step.run === 'npm run lint'));
  assert.ok(steps.some(step => step.run === 'npm publish --access public --provenance --tag latest'));
});

for (const [label, tag] of [['lightweight old ancestor', 'v1.0.0'], ['annotated current tag', 'v1.1.0']]) {
  test(`accepts ${label} from a shallow checkout without local tags`, async (t) => {
    const f = fixture(t);
    const { verifyProductionRelease } = await import(moduleUrl);
    assert.equal(git(f.checkout, 'rev-parse', '--is-shallow-repository'), 'true');
    assert.throws(() => git(f.checkout, 'rev-parse', '--verify', `refs/tags/${tag}`));
    const result = verifyProductionRelease({ cwd: f.checkout, remote: f.remote, tag, eventName: 'workflow_dispatch', eventRef: 'refs/heads/main' });
    assert.equal(result.sha, tag === 'v1.0.0' ? f.old : f.current);
    assert.equal(git(f.checkout, 'rev-parse', '--is-shallow-repository'), 'false');
    git(f.checkout, 'checkout', '--detach', result.sha);
    // A subsequently moved tag cannot change the selected checkout.
    git(f.source, 'tag', '-f', tag, f.old);
    git(f.source, 'push', '--force', f.remote, `refs/tags/${tag}`);
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), result.sha);
  });
}

for (const scenario of ['off-main', 'mismatch', 'branch-only', 'missing', 'malformed', 'shell input', 'dispatch branch', 'push changed', 'push branch']) {
  test(`rejects ${scenario} before a candidate script or publish mock runs`, async (t) => {
    const f = fixture(t);
    const { verifyProductionRelease } = await import(moduleUrl);
    let tag = 'v1.1.0';
    let eventName = 'workflow_dispatch';
    let eventRef = 'refs/heads/main';
    let eventSha;
    if (scenario === 'off-main') {
      git(f.source, 'checkout', '-b', 'side');
      f.commit('2.0.0');
      tag = 'v2.0.0';
      git(f.source, 'tag', tag);
      git(f.source, 'push', f.remote, `refs/tags/${tag}`);
    }
    if (scenario === 'mismatch') {
      tag = 'v9.0.0';
      git(f.source, 'tag', tag);
      git(f.source, 'push', f.remote, `refs/tags/${tag}`);
    }
    if (scenario === 'branch-only') {
      tag = 'v3.0.0';
      git(f.source, 'branch', tag);
      git(f.source, 'push', f.remote, `refs/heads/${tag}`);
    }
    if (scenario === 'missing') tag = 'v8.0.0';
    if (scenario === 'malformed') tag = 'refs/tags/v1.1.0';
    const marker = join(f.root, 'candidate-script-ran');
    if (scenario === 'shell input') tag = `v1.1.0; touch ${marker}`;
    if (scenario === 'dispatch branch') eventRef = 'refs/heads/side';
    if (scenario.startsWith('push')) {
      eventName = 'push';
      eventRef = scenario === 'push branch' ? 'refs/heads/main' : 'refs/tags/v1.1.0';
      eventSha = f.old;
    }
    const publish = () => {
      verifyProductionRelease({ cwd: f.checkout, remote: f.remote, tag, eventName, eventRef, eventSha });
      writeFileSync(marker, 'publish mock');
    };
    const reasons = {
      'off-main': /not an ancestor of canonical main/,
      mismatch: /does not match cli\/package.json/,
      'branch-only': /Couldn't find remote ref|couldn't find remote ref/i,
      missing: /Couldn't find remote ref|couldn't find remote ref/i,
      malformed: /existing production version tag/,
      'shell input': /existing production version tag/,
      'dispatch branch': /Dispatch production publishing from main/,
      'push changed': /no longer matches the tag push SHA/,
      'push branch': /Expected a version tag push/,
    };
    assert.throws(publish, reasons[scenario]);
    assert.equal(existsSync(marker), false);
  });
}

test('the pinned-checkout version step stops before npm on wrong SHA or version', (t) => {
  const f = fixture(t);
  const workflow = yaml.load(readFileSync(new URL('../workflows/publish-prod.yml', import.meta.url), 'utf8'));
  const versionStep = workflow.jobs.publish.steps.find(step => step.name === 'Verify tag matches package version');
  const marker = join(f.root, 'npm-called');
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\nprintf called > '${marker}'\n`, { mode: 0o755 });
  for (const [sha, tag, accepted] of [[f.current, 'v1.1.0', true], [f.old, 'v1.1.0', false], [f.current, 'v1.0.0', false]]) {
    rmSync(marker, { force: true });
    const result = spawnSync('bash', ['-e', '-c', `${versionStep.run}\nnpm publish`], {
      cwd: join(f.checkout, 'cli'), encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TAG_VERSION: tag, RELEASE_SHA: sha },
    });
    assert.equal(result.status === 0, accepted, result.stderr);
    assert.equal(existsSync(marker), accepted);
  }
});

test('release automation pushes the generated commit to main before dispatching publish from main', () => {
  const release = yaml.load(readFileSync(new URL('../workflows/release-prod.yml', import.meta.url), 'utf8'));
  const steps = release.jobs.release.steps;
  const push = steps.findIndex(step => step.run === 'git push origin HEAD:main "$TAG"');
  const dispatch = steps.findIndex(step => step.run === 'gh workflow run publish-prod.yml --ref main -f tag="$TAG"');
  assert.ok(push >= 0 && dispatch > push);
});

test('tag pushes bind both lightweight and annotated tags to their event commit', async (t) => {
  const f = fixture(t);
  const { verifyProductionRelease } = await import(moduleUrl);
  for (const [tag, eventSha] of [['v1.0.0', f.old], ['v1.1.0', f.current]]) {
    assert.equal(verifyProductionRelease({ cwd: f.checkout, remote: f.remote, tag, eventName: 'push', eventRef: `refs/tags/${tag}`, eventSha }).sha, eventSha);
  }
});
