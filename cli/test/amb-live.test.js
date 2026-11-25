// Opt-in live-instance check for AMB record watching (issue #396).
//
// Skipped unless the caller explicitly opts in, because it reads real
// credentials, subscribes to a real /amb endpoint and writes one field on one
// real record:
//
//   JSN_INTEGRATION_TESTS=true \
//   JSN_WATCH_TABLE=incident \
//   JSN_WATCH_SYS_ID=<sys_id> \
//   JSN_WATCH_FIELD=short_description \
//   JSN_WATCH_VALUE="watch probe $(date +%s)" \
//   node --test test/amb-live.test.js
//
// The write goes through the REST API, which is a different session from the
// AMB long-poll, so the assertion is that the subscription delivers a change
// notification for that record within a bounded window. There is no automatic
// "another user" step; a real multi-user check still needs a second operator
// or a second credential profile.

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AmbClient, normalizeRecordWatcherEvent, recordWatcherChannel } from '../src/amb.js';

const enabled = process.env.JSN_INTEGRATION_TESTS === 'true'
  && Boolean(process.env.JSN_WATCH_TABLE)
  && Boolean(process.env.JSN_WATCH_SYS_ID)
  && Boolean(process.env.JSN_WATCH_FIELD)
  && Boolean(process.env.JSN_WATCH_VALUE);
const skip = enabled ? false : 'opt-in: set JSN_INTEGRATION_TESTS=true and JSN_WATCH_* to watch one live record';

it('observes a change to a watched record through AMB', { skip, timeout: 120000 }, async () => {
  const table = process.env.JSN_WATCH_TABLE;
  const sysID = process.env.JSN_WATCH_SYS_ID;
  const field = process.env.JSN_WATCH_FIELD;
  const value = process.env.JSN_WATCH_VALUE;

  const app = new App(loadConfig());
  app.requireInstance();
  const client = new AmbClient({
    baseUrl: app.getEffectiveInstance(),
    session: () => app.sdk.ambSession(),
  });
  const channel = recordWatcherChannel(table, `sys_id=${sysID}`);
  try {
    const started = await client.start([channel]);
    assert.ok(started.clientId, 'handshake returned a clientId');

    await app.sdk.update(table, sysID, { [field]: value });

    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const messages = await client.next({ timeoutMs: 10000 });
      const event = messages
        .map(message => normalizeRecordWatcherEvent(message, { table, sysID }))
        .find(candidate => candidate.sys_id === sysID);
      if (event) {
        assert.ok(['updated', 'changed'].includes(event.operation), `unexpected operation: ${event.operation}`);
        return;
      }
    }
    assert.fail(`no AMB event observed for ${table}/${sysID} within 60s; check AMB availability, roles and that ${field} changed`);
  } finally {
    await client.stop([channel]);
  }
});
