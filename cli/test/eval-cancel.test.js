// jsn eval cancels its background script on the instance when it stops
// waiting (client timeout or Ctrl-C), through cancel_my_transaction.do in the
// same session. No instance: the SDK's session, CSRF and transport are stubbed.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SDKClient } from '../src/sdk.js';
import { evalCmd } from '../src/commands/eval.js';
import { makeApp } from './support/app-test-helpers.js';
import { wrapHandler } from './support/command-test-helpers.js';

const BASE = 'https://test.service-now.com';
const COOKIES = 'JSESSIONID=s1; glide_user_route=n1';
const CANCELING = `<?xml version="1.0" encoding="UTF-8"?><xml><message text="  Canceling: ${BASE}/sys.scripts.do">  Canceling: ${BASE}/sys.scripts.do</message></xml>`;
const NOTHING = '<?xml version="1.0" encoding="UTF-8"?><xml><message text="All transactions have completed, nothing to cancel">All transactions have completed, nothing to cancel</message></xml>';
const CANCELLED = 'Transaction cancelled - cancelled by user request';

// A script that runs until the cancel reaches it, then its own request ends
// with the platform's cancellation line, as dev485581 did on 25 Nov 2026.
function runningScript() {
  let end;
  const done = new Promise(resolve => { end = resolve; });
  return { run: () => done, cancel: () => { setImmediate(() => end(CANCELLED)); return CANCELING; } };
}

function scriptClient({ run, cancel, timeout = 20 }) {
  const client = new SDKClient(BASE, { getCredentials: async () => ({ auth_method: 'basic', username: 'u', password: 'p' }) }, { timeout });
  const calls = { posts: [], cancels: [] };
  client._warmSession = async () => COOKIES;
  client._getScriptsPageCSRF = async () => 'ck';
  client.rawRequest = async (endpoint, opts, settings) => {
    if (endpoint === `${BASE}/sys.scripts.do`) { calls.posts.push({ opts, settings }); return run(calls); }
    if (endpoint.includes('/cancel_my_transaction.do')) { calls.cancels.push({ endpoint, opts }); return cancel(calls); }
    throw new Error(`unexpected request ${endpoint}`);
  };
  return { client, calls };
}

function assertOneCancelInSession(calls) {
  assert.strictEqual(calls.cancels.length, 1);
  assert.strictEqual(calls.cancels[0].endpoint, `${BASE}/cancel_my_transaction.do?sysparm_output=xml`);
  assert.strictEqual(calls.cancels[0].opts.headers.Cookie, COOKIES);
}

describe('eval cancels its background script when it stops waiting', () => {
  it('a timeout sends exactly one cancel in the same session and reports the confirmed cancel', async () => {
    const { client, calls } = scriptClient(runningScript());
    await assert.rejects(client.executeScript('while (true) {}', ''), (error) => {
      assert.strictEqual(error.code, 'network_error');
      assert.match(error.message, /still running after \d+s; it was cancelled on the instance \(Transaction cancelled - cancelled by user request\)/);
      assert.strictEqual(error.cancel.status, 'cancelled');
      return true;
    });
    assertOneCancelInSession(calls);
    // The script's own request stays open past the deadline to carry the platform's answer.
    assert.ok(calls.posts[0].settings.timeout > 20);
  });

  it('Ctrl-C sends exactly one cancel in the same session and reports the confirmed cancel', async () => {
    const controller = new AbortController();
    const script = runningScript();
    const { client, calls } = scriptClient({ ...script, timeout: 60000, run: () => { setImmediate(() => controller.abort()); return script.run(); } });
    await assert.rejects(client.executeScript('while (true) {}', '', { signal: controller.signal }), (error) => {
      assert.strictEqual(error.code, 'interrupted');
      assert.match(error.message, /^Interrupted while the background script was running; it was cancelled on the instance/);
      assert.strictEqual(error.cancel.status, 'cancelled');
      return true;
    });
    assertOneCancelInSession(calls);
  });

  it('a normal finish sends no cancel, even when Ctrl-C comes after it', async () => {
    const controller = new AbortController();
    const { client, calls } = scriptClient({ run: async () => '<PRE>*** Script: done</PRE>', cancel: () => assert.fail('no cancel') });
    assert.strictEqual(await client.executeScript('gs.print("done")', '', { signal: controller.signal }), '*** Script: done');
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.strictEqual(calls.cancels.length, 0);
  });

  it('a failed cancel is reported as failed, never as cancelled', async () => {
    const { client, calls } = scriptClient({ run: () => new Promise(() => {}), cancel: async () => { throw new Error('Network error: fetch failed'); } });
    await assert.rejects(client.executeScript('while (true) {}', ''), (error) => {
      assert.match(error.message, /the cancel request failed \(Network error: fetch failed\), so it may still be running/);
      assert.doesNotMatch(error.message, /was cancelled/);
      assert.strictEqual(error.cancel.status, 'failed');
      return true;
    });
    assertOneCancelInSession(calls);
  });

  it('an unreadable cancel answer is reported as failed', async () => {
    const { client, calls } = scriptClient({ run: () => new Promise(() => {}), cancel: async () => '<html>login.do</html>' });
    await assert.rejects(client.executeScript('while (true) {}', ''), (error) => error.cancel.status === 'failed');
    assertOneCancelInSession(calls);
  });

  it('a cancel the platform does not confirm is reported as not confirmed', async () => {
    // The script finished on its own between the deadline and the cancel.
    let finished;
    const { client, calls } = scriptClient({ run: () => new Promise(resolve => { finished = resolve; }), cancel: () => { finished('<PRE>*** Script: done</PRE>'); return NOTHING; } });
    await assert.rejects(client.executeScript('gs.print("done")', ''), (error) => {
      assert.match(error.message, /the cancel was not confirmed \(instance answered: All transactions have completed, nothing to cancel\)/);
      assert.doesNotMatch(error.message, /was cancelled/);
      assert.strictEqual(error.cancel.status, 'not_confirmed');
      return true;
    });
    assertOneCancelInSession(calls);
  });

  it('an acknowledged cancel whose script request never ends is not confirmed', async () => {
    let fail;
    const { client, calls } = scriptClient({ run: () => new Promise((_resolve, reject) => { fail = reject; }), cancel: async () => { setImmediate(() => fail(new Error('Network error: Request timed out'))); return CANCELING; } });
    await assert.rejects(client.executeScript('while (true) {}', ''), (error) => error.cancel.status === 'not_confirmed');
    assertOneCancelInSession(calls);
  });

  it('Ctrl-C before the script is sent posts nothing and cancels nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, calls } = scriptClient({ run: () => assert.fail('no post'), cancel: () => assert.fail('no cancel') });
    await assert.rejects(client.executeScript('gs.print(1)', '', { signal: controller.signal }), /Interrupted before the background script was sent; nothing ran/);
    assert.strictEqual(calls.posts.length + calls.cancels.length, 0);
  });

  it('honours a longer per-call timeout', async () => {
    const { client, calls } = scriptClient({ run: () => new Promise(resolve => setTimeout(resolve, 60, '<PRE>*** Script: slow</PRE>')), cancel: () => assert.fail('no cancel') });
    assert.strictEqual(await client.executeScript('gs.sleep(60)', '', { timeout: 1000 }), '*** Script: slow');
    assert.strictEqual(calls.cancels.length, 0);
  });
});

describe('jsn eval --timeout and Ctrl-C', () => {
  const app = (executeScript) => makeApp({ sdk: { executeScript }, mutationContext: { scope: 'x_app', application_id: 'app1' } });

  it('passes --timeout to executeScript in milliseconds, and leaves the default to the SDK', async () => {
    const seen = [];
    const cmd = evalCmd(wrapHandler);
    await cmd.handler({ app: app(async (_s, _scope, opts) => { seen.push(opts.timeout); return 'ok'; }), script: 'gs.print(1)', timeout: 120 });
    await cmd.handler({ app: app(async (_s, _scope, opts) => { seen.push(opts.timeout); return 'ok'; }), script: 'gs.print(1)' });
    assert.deepStrictEqual(seen, [120000, undefined]);
  });

  for (const timeout of [0, -5, 1.5, Number.NaN, 86401]) {
    it(`rejects --timeout ${timeout} before running anything`, async () => {
      let ran = 0;
      const cmd = evalCmd(wrapHandler);
      await assert.rejects(cmd.handler({ app: app(async () => { ran++; return 'ok'; }), script: 'gs.print(1)', timeout }), (error) => {
        assert.strictEqual(error.code, 'usage_error');
        assert.match(error.message, /--timeout must be a whole number of seconds from 1 to 86400/);
        return true;
      });
      assert.strictEqual(ran, 0);
    });
  }

  it('Ctrl-C while the script runs aborts the signal given to executeScript, and the handler is removed after', async () => {
    const before = process.listenerCount('SIGINT');
    const writes = [];
    const write = process.stderr.write;
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      const cmd = evalCmd(wrapHandler);
      await assert.rejects(cmd.handler({
        app: app(async (_s, _scope, opts) => {
          process.emit('SIGINT');
          assert.strictEqual(opts.signal.aborted, true);
          throw new Error('stopped');
        }),
        script: 'while (true) {}',
      }), /stopped/);
    } finally {
      process.stderr.write = write;
    }
    assert.match(writes.join(''), /Cancelling the background script on the instance/);
    assert.strictEqual(process.listenerCount('SIGINT'), before);
  });
});
