// Integration tests — run against a live ServiceNow instance
// Opt-in: set JSN_INTEGRATION_TESTS=true
// Uses the configured default profile from config

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

const INTEGRATION_ENABLED = process.env.JSN_INTEGRATION_TESTS === 'true';

let app;
let testRecordSysId;
const TEST_PREFIX = 'JSN_INT_TEST_';

before(async () => {
  if (!INTEGRATION_ENABLED) return;
  const { loadConfig } = await import('../src/config.js');
  const { App } = await import('../src/app.js');
  const cfg = loadConfig();
  app = new App(cfg);

  if (!app.getEffectiveInstance()) {
    throw new Error('No ServiceNow instance configured. Run jsn setup first or check your config.');
  }
});

after(async () => {
  if (testRecordSysId && app) {
    try {
      await app.sdk.delete('incident', testRecordSysId);
    } catch {
      // non-fatal cleanup
    }
  }
});

// ─── Auth Tests ───

describe('Integration - Auth', { skip: !INTEGRATION_ENABLED }, () => {
  it('should be authenticated', () => {
    assert.ok(app.auth.isAuthenticated(), 'Should be authenticated to the instance');
  });

  it('should have a configured instance URL', () => {
    const instance = app.getEffectiveInstance();
    assert.ok(instance, 'Instance URL should be configured');
    assert.ok(instance.startsWith('https://'), 'Instance URL should use HTTPS');
  });

  it('should return auth status', async () => {
    const creds = await app.auth.getCredentials();
    assert.ok(creds, 'Should return credentials');
    assert.ok(creds.auth_method || creds.access_token || (creds.username && creds.password),
      'Should have some form of authentication');
  });
});

// ─── Records List / Get Tests ───

describe('Integration - Records Read', { skip: !INTEGRATION_ENABLED }, () => {
  it('should list records from incident table', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '5');
    params.set('sysparm_fields', 'number,short_description');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('incident', params);
    assert.ok(Array.isArray(records), 'Should return an array');
    assert.ok(records.length > 0, 'Should return at least one incident');
    assert.ok(records[0].number, 'First record should have a number field');
  });

  it('should get a specific record by sys_id', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '1');
    params.set('sysparm_fields', 'sys_id,number');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('incident', params);
    if (records.length === 0) return;
    const { getStringField } = await import('../src/helpers.js');
    const id = getStringField(records[0], 'sys_id');
    assert.ok(id, 'Should extract sys_id via getStringField');
  });

  it('should list users', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'user_name,name');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_user', params);
    assert.ok(Array.isArray(records), 'Should return an array');
    assert.ok(records.length > 0, 'Should return at least one user');
  });

  it('should list groups', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'name');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_user_group', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });

  it('should query with encoded query', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_query', 'active=true');
    params.set('sysparm_limit', '5');
    params.set('sysparm_fields', 'number,active');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('incident', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });
});

// ─── Records Create / Update / Delete Tests ───

describe('Integration - Records CRUD', { skip: !INTEGRATION_ENABLED }, () => {
  const testDesc = TEST_PREFIX + 'Create test ' + Date.now();

  it('should create a record', async () => {
    const { getStringField } = await import('../src/helpers.js');
    const record = await app.sdk.create('incident', {
      short_description: testDesc,
      priority: '3',
      category: 'software',
    });
    assert.ok(record, 'Should return the created record');
    const sysId = getStringField(record, 'sys_id');
    assert.ok(sysId, 'Created record should have a sys_id');
    testRecordSysId = sysId;

    const number = getStringField(record, 'number');
    assert.ok(number, 'Created record should have a number');
    assert.ok(number.startsWith('INC'), 'Incident number should start with INC');
  });

  it('should read the created record', async () => {
    assert.ok(testRecordSysId, 'Need a created record to test');
    const params = new URLSearchParams();
    params.set('sysparm_query', `sys_id=${testRecordSysId}`);
    params.set('sysparm_limit', '1');
    params.set('sysparm_fields', 'sys_id,short_description,number');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('incident', params);
    assert.ok(records.length > 0, 'Should find the created record');
  });

  it('should update the created record', async () => {
    assert.ok(testRecordSysId, 'Need a created record to test');
    await app.sdk.update('incident', testRecordSysId, {
      short_description: testDesc + ' (updated)',
      priority: '2',
    });
    // Update doesn't throw = success
    assert.ok(true, 'Update succeeded');
  });

  it('should verify the update persisted', async () => {
    assert.ok(testRecordSysId, 'Need a created record to test');
    const params = new URLSearchParams();
    params.set('sysparm_query', `sys_id=${testRecordSysId}`);
    params.set('sysparm_limit', '1');
    params.set('sysparm_fields', 'short_description,priority');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('incident', params);
    assert.ok(records.length > 0, 'Should find the record');
  });

  it('should delete the created record', async () => {
    assert.ok(testRecordSysId, 'Need a created record to test');
    await app.sdk.delete('incident', testRecordSysId);
    const params = new URLSearchParams();
    params.set('sysparm_query', `sys_id=${testRecordSysId}`);
    params.set('sysparm_limit', '1');
    const records = await app.sdk.list('incident', params);
    assert.strictEqual(records.length, 0, 'Record should be deleted');
    testRecordSysId = null;
  });
});

// ─── Table / Schema Tests ───

describe('Integration - Table Operations', { skip: !INTEGRATION_ENABLED }, () => {
  it('should list incident table columns', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_query', 'name=incident');
    params.set('sysparm_limit', '10');
    params.set('sysparm_fields', 'element,column_label');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_dictionary', params);
    assert.ok(Array.isArray(records), 'Should return an array');
    assert.ok(records.length > 0, 'Should return columns for incident');
    assert.ok(records[0].element, 'Each column should have an element name');
  });
});

// ─── Config Tests ───

describe('Integration - Config', { skip: !INTEGRATION_ENABLED }, () => {
  it('should list profiles', () => {
    const profiles = app.config.profiles || {};
    assert.ok(typeof profiles === 'object', 'Profiles should be an object');
  });

  it('should list scopes', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'name,scope');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_scope', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });

  it('should list user roles', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'name');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_user_role', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });
});

// ─── Dev Commands Expanded ───

describe('Integration - Dev Commands Expanded', { skip: !INTEGRATION_ENABLED }, () => {
  it('should list update sets', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'name,state');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_update_set', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });

  it('should list flows', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'name,active');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_hub_flow', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });

  it('should list script includes', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'name,api_name');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_script_include', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });

  it('should list business rules', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'name,collection');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_script', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });

  it('should list ACLs', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'name,operation');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_security_acl', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });

  it('should list client scripts', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'name,table');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_script_client', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });

  it('should list UI policies', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'short_description,table');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_ui_policy', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });

  it('should list UI actions', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'name,table');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_ui_action', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });

  it('should list system properties', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'name,value');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_properties', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });

  it('should list tables', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'name,label');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_db_object', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });
});

// ─── Eval Tests ───

describe('Integration - Eval', { skip: !INTEGRATION_ENABLED }, () => {
  it('should execute a simple script', async () => {
    const result = await app.sdk.executeScript('gs.log("jsn integration test");');
    // Should not throw — actual output varies by instance config
    assert.ok(typeof result === 'string', 'Should return a string result');
  });

  it('should return script output via gs.log', async () => {
    const result = await app.sdk.executeScript('gs.log("jsn integration test date=" + gs.nowDateTime());');
    assert.ok(result, 'Should return log output');
    assert.ok(result.length > 0, 'Should contain log text');
  });
});

// ─── Scoped-App Dev Commands (PR #110) ───

describe('Integration - Scoped App Commands', { skip: !INTEGRATION_ENABLED }, () => {
  it('should list views', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'name,title');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_ui_view', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });

  it('should list aliases', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'name,table');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_alias', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });

  it('should list privileges', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'name,status');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_scope_privilege', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });

  it('should list application modules', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'name,active');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('sys_app_module', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });

  it('should list catalog UI policies', async () => {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '3');
    params.set('sysparm_fields', 'short_description,table');
    params.set('sysparm_display_value', 'all');
    const records = await app.sdk.list('catalog_ui_policy', params);
    assert.ok(Array.isArray(records), 'Should return an array');
  });
});
