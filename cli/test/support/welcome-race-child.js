// Race one first run against another (issue #387, matrix row 1).
//
// Every child waits on a shared barrier, then claims the welcome marker at the
// same moment. The claim is the thing under test: exactly one child may win,
// and the marker must end up complete. This is a test seam only - production
// code never waits on a barrier.
//
// argv: <configDir> <barrierDir> <childId> <childCount>

import fs from 'node:fs';
import path from 'node:path';
import { claimWelcome } from '../../src/welcome.js';

const [configDir, barrierDir, childId, childCountRaw] = process.argv.slice(2);
const childCount = Number(childCountRaw);

fs.mkdirSync(barrierDir, { recursive: true });
const ready = (id) => path.join(barrierDir, `ready-${id}`);

fs.writeFileSync(ready(childId), '');

const deadline = Date.now() + 15000;
function barrierReached() {
  for (let id = 0; id < childCount; id += 1) {
    if (!fs.existsSync(ready(id))) return false;
  }
  return true;
}

while (!barrierReached()) {
  if (Date.now() > deadline) {
    process.stdout.write(`${JSON.stringify({ error: 'barrier timeout', id: childId })}\n`);
    process.exit(1);
  }
}

const claim = claimWelcome(configDir);
process.stdout.write(`${JSON.stringify({ id: childId, claim })}\n`);
