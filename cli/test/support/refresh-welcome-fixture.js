// Regenerate intentional command-surface changes using the test capture path.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runCli, freshConfigHome, sha256, FIXTURE_DIR } from './welcome-harness.js';
import path from 'node:path';

const metaPath = path.join(FIXTURE_DIR, 'base-output.json');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const { dir } = freshConfigHome();
const modes = {
  help: [], json: ['--json'], quiet: ['--quiet'], csv: ['--csv'],
  markdown: ['--markdown'], get: ['--get', 'data.version'],
};
for (const [name, args] of Object.entries(modes)) {
  const result = runCli(args, dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ifError(result.error);
  meta.bytes[name] = Buffer.byteLength(result.stdout);
  meta.sha256[name] = sha256(result.stdout);
  if (name === 'help') fs.writeFileSync(path.join(FIXTURE_DIR, 'base-help.txt'), result.stdout);
  if (name === 'json') meta.json_command_count = JSON.parse(result.stdout).data.commands.length;
}
meta.commit = '34dcfff + origin/main merge';
fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(meta, null, 2)}\n`);
