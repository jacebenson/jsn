import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectWorkflow, formatWorkflowOutline } from '../src/workflow-inspection.js';

const id = n => String(n).padStart(32, '0');
async function fixture(configuration = {}, { reverse = false, denied = false } = {}) {
  const calls = [];
  const tables = {
    wf_workflow: [{ sys_id: id(900), name: 'Content' }],
    wf_workflow_version: [{ sys_id: id(901), workflow: id(900), name: 'Content', start: id(1), published: 'true', active: 'true' }],
    wf_activity: [
      { sys_id: id(1), name: 'Begin' },
      { sys_id: id(2), name: 'Notify', 'activity_definition.name': 'Notification' },
      { sys_id: id(3), name: 'Approve', 'activity_definition.name': 'Approval - Group' },
      { sys_id: id(4), name: 'End' },
    ],
    wf_transition: [[1, 2], [2, 3], [3, 4]].map(([from, to], i) => ({ sys_id: id(100 + i), from: id(from), to: id(to) })),
    sys_variable_value: Object.entries(configuration).flatMap(([activity, fields]) => Object.entries(fields).map(([element, value]) => ({
      document_key: id(activity), 'variable.element': element, value,
    }))),
  };
  const sdk = { listStrict: async (table) => {
    calls.push(table);
    if (denied && table === 'sys_variable_value') throw Object.assign(new Error('denied'), { status: 403 });
    const rows = tables[table] || [];
    return reverse ? [...rows].reverse() : rows;
  } };
  const data = JSON.parse(JSON.stringify(await inspectWorkflow(sdk, { identifier: id(900) })));
  assert.deepEqual(calls, ['wf_workflow', 'wf_workflow_version', 'wf_activity', 'wf_condition', 'wf_transition', 'wf_stage', 'sys_variable_value']);
  return data;
}
function steps(data, options) {
  const before = JSON.stringify(data);
  const text = formatWorkflowOutline(data, { includeConfiguration: true, ...options });
  assert.equal(JSON.stringify(data), before, 'formatting must not mutate any JSON fields');
  assert.doesNotMatch(text, /▶ CONFIGURATION|\b[0-9a-f]{32}\b/i);
  return text.split(`▶ STEPS\n${'─'.repeat(50)}\n`)[1].split('\n\n')[0].split('\n');
}

test('every configured element renders under its own typed step sorted and aligned by field name', async () => {
  const configuration = {
    2: { subject: 'Proposal ${number}', email_to: '${opened_by}', email: 'Number: ${number}' },
    3: { reject_handling: 'Reject', groups: 'Change Management', duration: '00:05:00', condition: 'active=true',
      advanced: 'false', script_condition: 'answer = true;', field: 'approval', wait_for: 'all', wait_for_condition: 'state=3',
      timer_type: 'relative', schedule_type: 'user', timezone_type: 'user', timezone_field: 'timezone', schedule_field: 'schedule',
      user_specified_schedule: 'Business hours', user_specified_timezone: 'UTC', relative_duration: '1 day',
      email_to_group: 'Managers', script: 'current.update();' },
  };
  const expected = [
    '  1. Begin', '  2. Notify  (Notification)',
    '       email:    Number: ${number}', '       email_to: ${opened_by}', '       subject:  Proposal ${number}',
    '  3. Approve  (Approval - Group)',
    '       advanced:                false',
    '       condition:               active=true',
    '       duration:                00:05:00',
    '       email_to_group:          Managers',
    '       field:                   approval',
    '       groups:                  Change Management',
    '       reject_handling:         Reject',
    '       relative_duration:       1 day',
    '       schedule_field:          schedule',
    '       schedule_type:           user',
    '       script:                  current.update();',
    '       script_condition:        answer = true;',
    '       timer_type:              relative',
    '       timezone_field:          timezone',
    '       timezone_type:           user',
    '       user_specified_schedule: Business hours',
    '       user_specified_timezone: UTC',
    '       wait_for:                all',
    '       wait_for_condition:      state=3',
    '  4. End',
  ];
  assert.deepEqual(steps(await fixture(configuration)), expected);
  assert.deepEqual(steps(await fixture(configuration, { reverse: true })), expected);
});

test('empty and whitespace-only elements are suppressed and unconfigured steps have no content lines', async () => {
  const data = await fixture({ 2: { email: '', subject: ' \t\r\n ', script: '\n  ' }, 3: { advanced: 'false', duration: '0' } });
  assert.deepEqual(steps(data), ['  1. Begin', '  2. Notify  (Notification)', '  3. Approve  (Approval - Group)',
    '       advanced: false', '       duration: 0', '  4. End']);
  assert.equal(data.activities.find(activity => activity.sys_id === id(2)).configuration.subject, ' \t\r\n ');
});

test('multiline step values show three lines and an exact explicit omitted-line count', async () => {
  const email = 'one\r\ntwo\r\nthree\r\nfour\r\nfive';
  const data = await fixture({ 2: { email }, 3: { script: 'a();\nb();\nc();' } });
  assert.deepEqual(steps(data), ['  1. Begin', '  2. Notify  (Notification)', '       email: one',
    '              two', '              three', '              … (2 more lines, use --json for the full value)',
    '  3. Approve  (Approval - Group)', '       script: a();', '               b();', '               c();', '  4. End']);
  assert.equal(data.activities.find(activity => activity.sys_id === id(2)).configuration.email, email);
});

test('selected step bypasses both line and character preview limits and shows its sequential edge', async () => {
  const data = await fixture({ 2: { script: `first();\n${'x'.repeat(170)}\nthird();\nfourth();\nfifth();` } });
  assert.deepEqual(steps(data, { step: 2 }), [
    '  2. Notify  (Notification)',
    '       script: first();',
    `               ${'x'.repeat(170)}`,
    '               third();',
    '               fourth();',
    '               fifth();',
    '       → step 3 Approve [unconditional]',
  ]);
});

test('single-line step values are width-bounded with an explicit omitted-character count', async () => {
  assert.deepEqual(steps(await fixture({ 2: { email: 'x'.repeat(170) } })), ['  1. Begin', '  2. Notify  (Notification)',
    `       email: ${'x'.repeat(160)}… (10 more characters, use --json for the full value)`,
    '  3. Approve  (Approval - Group)', '  4. End']);
});

test('comment-only scripts retain sorted per-step omission notes without a trailing configuration section', async () => {
  const data = await fixture({ 2: { script_condition: '/* disabled */', script: '// disabled', email_to_script: '// disabled', subject: 'Keep' } });
  assert.deepEqual(steps(data), ['  1. Begin', '  2. Notify  (Notification)', '       subject: Keep',
    '       omitted email_to_script: comment-only script (no executable code)',
    '       omitted script: comment-only script (no executable code)',
    '       omitted script_condition: comment-only script (no executable code)',
    '  3. Approve  (Approval - Group)', '  4. End']);
  assert.equal(data.coverage.comment_only_scripts_omitted, 3);
});

test('quiet step rendering preserves numbered lines while leaving full configuration in JSON', async () => {
  const data = await fixture({ 2: { subject: 'Keep in JSON', script: 'current.update();' } });
  assert.deepEqual(steps(data, { includeConfiguration: false }), ['  1. Begin', '  2. Notify', '  3. Approve', '  4. End']);
  assert.equal(data.activities.find(activity => activity.sys_id === id(2)).configuration.subject, 'Keep in JSON');
});

test('unreadable configuration is disclosed under each affected step', async () => {
  assert.deepEqual(steps(await fixture({}, { denied: true })), ['  1. Begin', '       configuration: inaccessible',
    '  2. Notify  (Notification)', '       configuration: inaccessible', '  3. Approve  (Approval - Group)',
    '       configuration: inaccessible', '  4. End', '       configuration: inaccessible']);
});
