// Preserve the existing Eleventy URL tree while changing the serving process.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const built = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: path.join(root, 'docs'), stdio: 'inherit', shell: process.platform === 'win32' });
if (built.status !== 0) process.exit(built.status || 1);
const source = path.join(root, 'docs', '_site'), destination = path.join(root, 'site', 'public');
fs.mkdirSync(destination, { recursive: true });
for (const name of fs.readdirSync(destination)) if (name !== '.keep') fs.rmSync(path.join(destination, name), { recursive: true, force: true });
fs.cpSync(source, destination, { recursive: true });
const urls = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.html')) urls.push('/' + path.relative(source, full).split(path.sep).join('/').replace(/index\.html$/, ''));
  }
}
walk(source);
fs.writeFileSync(path.join(root, 'site', 'tmp', 'preserved-urls.json'), JSON.stringify(urls));
process.stdout.write(`Copied existing documentation output; ${urls.length} HTML URLs preserved.\n`);
