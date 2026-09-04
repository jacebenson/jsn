import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogscriptsCmd,
  clientScriptsCmd,
  spPagesCmd,
  uiPagesCmd,
} from '../src/commands/_simple.js';

describe('promoted command aliases', () => {
  it('keeps cs owned by clientscripts', () => {
    const command = clientScriptsCmd(() => {});
    const catalogCommand = catalogscriptsCmd(() => {});

    assert.ok(command.aliases.includes('cs'));
    assert.ok(!catalogCommand.aliases.includes('cs'));
  });

  it('keeps pages owned by uipages', () => {
    const command = uiPagesCmd(() => {});
    const portalCommand = spPagesCmd(() => {});

    assert.ok(command.aliases.includes('pages'));
    assert.ok(!portalCommand.aliases.includes('pages'));
  });
});
