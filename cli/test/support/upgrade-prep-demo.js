// Run from the repository root. Output is synthetic fixture evidence only.
import fs from 'node:fs';
import path from 'node:path';
import { upgradeFixture } from './upgrade-prep-fixture.js';

const destination = process.argv[2];
if (!destination) throw new Error('Supply an evidence directory.');
fs.mkdirSync(destination, { recursive: true });
const fixture = await upgradeFixture();
try {
  const base = ['upgrade', 'prep', '--profile', 'fixture', '--related-profile', 'lower'];
  const commands = [
    ['demo-human.txt', [...base, '--format', 'markdown']],
    ['demo-evidence-reference.json', [...base, '--get', 'data.sources[7]']],
    ['demo-complete.json', [...base, '--json']],
  ];
  for (const [file, args] of commands) {
    const result = await fixture.run(args);
    fs.writeFileSync(path.join(destination, file), result.stdout);
  }
  fs.writeFileSync(path.join(destination, 'demo-requests.json'), JSON.stringify(fixture.requests, null, 2));
  fs.writeFileSync(path.join(destination, 'demo-commands.json'), JSON.stringify(commands.map(([file, args]) => ({ file, argv: ['node', 'cli/bin/jsn.js', ...args], label: 'SANITIZED FIXTURE DATA', exit: 0 })), null, 2));
  if (fixture.violations.length) throw new Error('Fixture observed non-allowlisted requests.');
  console.log(`Saved actual CLI stdout and GET request ledger in ${destination}`);
} finally { await fixture.close(); }
