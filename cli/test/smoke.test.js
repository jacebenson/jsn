// Clean up any env variable that might interfere
delete process.env.SERVICENOW_OAUTH_TOKEN;

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { cli } from '../src/cli.js';

describe('CLI smoke tests', () => {
  it('should parse without error', () => {
    assert.ok(cli, 'CLI should be defined');
    assert.ok(typeof cli.parse === 'function', 'CLI should have parse method');
  });
});

after(() => {
  delete process.env.SERVICENOW_OAUTH_TOKEN;
});
