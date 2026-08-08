import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('confirmDelete', () => {
  let confirmDelete;

  const makeApp = (profile) => ({
    config: {
      activeProfile: 'test',
      defaultProfile: 'test',
      profiles: { test: profile || {} },
    },
  });

  it('allows when profile has skip_confirmations', async () => {
    ({ confirmDelete } = await import('../src/helpers.js'));
    const ok = await confirmDelete(makeApp({ skip_confirmations: true }), {}, 'Delete incident INC001');
    assert.strictEqual(ok, true);
  });

  it('allows when --force is passed (no profile flag)', async () => {
    ({ confirmDelete } = await import('../src/helpers.js'));
    const ok = await confirmDelete(makeApp({}), { force: true }, 'Delete incident INC001');
    assert.strictEqual(ok, true);
  });

  it('rejects non-interactive deletes without --force (default ask)', async () => {
    ({ confirmDelete } = await import('../src/helpers.js'));
    await assert.rejects(
      () => confirmDelete(makeApp({}), {}, 'Delete incident INC001'),
      /confirmation required.*--force/s
    );
  });

  it('rejects even when --force is absent but read_only is set (flags are independent)', async () => {
    ({ confirmDelete } = await import('../src/helpers.js'));
    await assert.rejects(
      () => confirmDelete(makeApp({ read_only: true }), {}, 'Delete incident INC001'),
      /confirmation required.*--force/s
    );
  });

  it('allows when both flags are set', async () => {
    ({ confirmDelete } = await import('../src/helpers.js'));
    const ok = await confirmDelete(makeApp({ skip_confirmations: true }), { force: true }, 'Delete incident INC001');
    assert.strictEqual(ok, true);
  });

  it('handles missing active profile gracefully (throws, does not crash)', async () => {
    ({ confirmDelete } = await import('../src/helpers.js'));
    await assert.rejects(
      () => confirmDelete({ config: { profiles: {} } }, {}, 'Delete incident INC001'),
      /confirmation required.*--force/s
    );
  });
});
