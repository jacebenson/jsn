import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildMidRecipeUrl,
  dockerComposeAvailable,
  detectDocker,
  installDockerMidServer,
  normalizeMidName,
  validateMidCredentials,
} from '../src/midserver-install.js';

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('MID Server installer', () => {
  it('builds the official recipe URL from a release name', () => {
    assert.equal(
      buildMidRecipeUrl('mid-linux-2026-05-19'),
      'https://install.service-now.com/glide/distribution/builds/package/app-signed/mid-linux-container-recipe/2026/05/19/mid-linux-container-recipe.mid-linux-2026-05-19.linux.x86-64.zip',
    );
  });

  it('normalizes the mid.server prefix and rejects unsafe names', () => {
    assert.equal(normalizeMidName('mid.server.oct12'), 'oct12');
    assert.throws(() => normalizeMidName('oct12/evil'), /may contain only/);
  });

  it('returns the MID release when credentials validate', async () => {
    const result = await validateMidCredentials('https://example.service-now.com', 'mid-user', 'secret', async (url, options) => {
      assert.match(url, /sys_properties/);
      assert.match(options.headers.Authorization, /^Basic /);
      return { ok: true, status: 200, json: async () => ({ result: [{ value: 'mid-linux-2026-05-19' }] }) };
    });
    assert.deepEqual(result, { releaseName: 'mid-linux-2026-05-19' });
  });

  it('rejects invalid credentials without exposing the password', async () => {
    await assert.rejects(
      () => validateMidCredentials('https://example.service-now.com', 'mid-user', 'secret', async () => ({ ok: false, status: 401, json: async () => ({}) })),
      /username or password was rejected/,
    );
  });

  it('detects Docker and Compose through injected commands', () => {
    const calls = [];
    assert.equal(dockerComposeAvailable((command, args) => calls.push([command, args])), true);
    assert.deepEqual(calls, [['docker', ['--version']], ['docker', ['compose', 'version']], ['docker', ['info']]]);
    assert.deepEqual(detectDocker(() => { throw new Error('missing'); }), {
      installed: false, compose: false, daemon: false, available: false,
    });
    assert.equal(dockerComposeAvailable(() => { throw new Error('missing'); }), false);
  });

  it('builds the Compose install without writing the password to disk', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-midserver-test-'));
    tempDirs.push(directory);
    const calls = [];
    const result = await installDockerMidServer({
      instanceURL: 'https://example.service-now.com',
      username: 'mid-user',
      password: 'super-secret',
      name: 'oct12',
      releaseName: 'mid-linux-2026-05-19',
      directory,
      run: (command, args, options = {}) => calls.push({ command, args, options }),
    });
    const compose = fs.readFileSync(result.composePath, 'utf8');
    assert.doesNotMatch(compose, /super-secret/);
    const composeRun = calls.find(call => call.args.includes('up'));
    assert.equal(composeRun.options.env.MID_INSTANCE_PASSWORD, 'super-secret');
    assert.equal(result.name, 'mid.server.oct12');
    assert.equal(path.basename(result.composePath), 'example-oct12.yaml');
    assert.ok(calls.some(call => call.command === 'docker' && call.args[0] === 'build' && call.args[2] === 'jsn_mid_oct12:mid-linux-2026-05-19'));
  });
});
