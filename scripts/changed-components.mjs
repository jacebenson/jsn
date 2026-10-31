// Keep required CI checks present while selecting only affected applications.
import { execFileSync } from 'node:child_process';
const base = process.argv[2];
let files;
try {
  files = !base || /^0+$/.test(base) ? ['cli/', 'site/']
    : execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' }).trim().split('\n');
} catch { files = ['cli/', 'site/']; }
const workflow = files.some(file => file.startsWith('.github/workflows/') || file === 'scripts/changed-components.mjs');
const cli = workflow || files.some(file => file.startsWith('cli/'));
const site = workflow || files.some(file => /^(site\/|docs\/|cli\/src\/commands\/docs\/|cli\/package(?:-lock)?\.json$|scripts\/build-docs-site\.mjs$)/.test(file));
process.stdout.write(`cli=${cli}\nsite=${site}\n`);
