// Lightweight documentation validation. Node builtins only: no installation,
// no build, and no network. Run from the repository root.
//   node scripts/check-docs.mjs [base-sha]
// With a base, only Markdown changed since that base is validated, so an
// existing unrelated defect does not block a docs edit. Without a usable base,
// every tracked Markdown file is validated.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const base = process.argv[2];
const baseUsable = base && !/^0+$/.test(base);

let changed = true;
let markdown;
try {
  markdown = baseUsable
    ? execFileSync('git', ['diff', '--name-only', '--no-renames', '--diff-filter=ACMR', base, 'HEAD'], { cwd: root, encoding: 'utf8' })
      .split('\n').map(file => file.trim()).filter(file => /\.mdx?$/i.test(file) && fs.existsSync(path.join(root, file)))
    : execFileSync('git', ['ls-files', '--', '*.md', '*.mdx'], { cwd: root, encoding: 'utf8' })
      .split('\n').map(file => file.trim()).filter(Boolean);
} catch (error) {
  if (!baseUsable && /not a git repository/i.test(String(error.stderr || error.message))) {
    console.error('check-docs: run from a Git checkout of the repository');
    process.exit(1);
  }
  // A missing or unreadable base must not silently narrow the check.
  changed = false;
  markdown = execFileSync('git', ['ls-files', '--', '*.md', '*.mdx'], { cwd: root, encoding: 'utf8' })
    .split('\n').map(file => file.trim()).filter(Boolean);
}

const failures = [];
const fail = message => failures.push(message);

// The published CLI package advertises its README and must ship every listed
// path. This catches a deleted README or a stale `files` entry without running
// npm.
function checkPackagedReadme() {
  const readme = path.join(root, 'cli/README.md');
  if (!fs.existsSync(readme) || fs.statSync(readme).size === 0) fail('cli/README.md is missing or empty');
  const rootReadme = path.join(root, 'README.md');
  if (!fs.existsSync(rootReadme) || fs.statSync(rootReadme).size === 0) fail('README.md is missing or empty');
  const manifest = path.join(root, 'cli/package.json');
  if (!fs.existsSync(manifest)) return fail('cli/package.json is missing');
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch {
    return fail('cli/package.json is not valid JSON');
  }
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  if (!files.includes('README.md')) fail('cli/package.json files must include README.md');
  for (const entry of files) {
    if (!fs.existsSync(path.join(root, 'cli', entry))) fail(`cli/package.json files entry does not exist: ${entry}`);
  }
}

const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;
const SKIP_TARGET = /[<>{}*$]/;

function stripCode(source) {
  return source
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

function targets(source) {
  const found = [];
  for (const match of stripCode(source).matchAll(/!?\[[^\]]*\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g)) found.push(match[1]);
  for (const match of stripCode(source).matchAll(/^[ \t]{0,3}\[[^\]]+\]:[ \t]*(\S+)/gm)) found.push(match[1]);
  return found;
}

let relativeLinks = 0;
let externalLinks = 0;
let siteRoutes = 0;

for (const file of markdown.sort()) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  for (let target of targets(source)) {
    target = target.replace(/^<|>$/g, '').trim();
    if (!target) continue;
    if (EXTERNAL.test(target) || target.startsWith('//')) {
      if (/^https?:|^mailto:/i.test(target)) externalLinks += 1;
      continue;
    }
    if (target.startsWith('#')) continue;
    // Site-absolute routes are the website suite's concern, not files here.
    if (target.startsWith('/')) { siteRoutes += 1; continue; }
    if (SKIP_TARGET.test(target)) continue;
    const clean = target.split('#')[0].split('?')[0];
    if (!clean) continue;
    let decoded = clean;
    try { decoded = decodeURIComponent(clean); } catch { /* keep the literal path */ }
    relativeLinks += 1;
    if (!fs.existsSync(path.resolve(root, path.dirname(file), decoded))) {
      fail(`${file}: missing relative link target ${JSON.stringify(target)}`);
    }
  }
}

checkPackagedReadme();

const scope = changed && baseUsable ? `changed since ${base.slice(0, 12)}` : 'all tracked Markdown';
console.log(`Docs check: ${markdown.length} Markdown file(s) ${scope}.`);
console.log(`Relative links and paths verified: ${relativeLinks}.`);
console.log(`External links recorded but not fetched: ${externalLinks} (availability is not asserted).`);
if (siteRoutes) console.log(`Site-absolute routes left to the website suite: ${siteRoutes}.`);
if (failures.length) {
  console.error(`\n${failures.length} documentation problem(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('Packaged README and advertised package paths exist.');
