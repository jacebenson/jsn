// Site data is canonical. Run from any cwd to refresh packaged offline snapshots.
import { copyFileSync } from 'node:fs';
for (const name of ['public-inventory.json', 'itom-2026-04-09.json']) {
  copyFileSync(new URL(`../../site/config/subscription-schedules/${name}`, import.meta.url), new URL(`../src/schedules/${name}`, import.meta.url));
}
