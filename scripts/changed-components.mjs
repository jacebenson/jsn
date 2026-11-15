// Keep required CI checks present while selecting only affected applications.
// The docs check is separate: it validates Markdown without installing or
// building either application.
import { execFileSync } from 'node:child_process';

const base = process.argv[2];
let files;
try {
  files = !base || /^0+$/.test(base) ? null
    // Disable rename detection so a rename reports both the old and new path.
    : execFileSync('git', ['diff', '--name-only', '--no-renames', base, 'HEAD'], { encoding: 'utf8' })
      .split('\n').map(file => file.trim()).filter(Boolean);
} catch { files = null; }
// No usable base: assume every application changed.
const unknownBase = files === null;
files = files || [];

const isMarkdown = file => /\.mdx?$/i.test(file);
// README edits under cli/ are user and contributor prose, not runtime input.
// Every other cli/ path stays CLI-selected, including cli/skills/** (shipped in
// the package and read at runtime), cli/test/fixtures/** (read by tests), and
// cli/package.json. Markdown is never excluded by extension alone.
const cliProseDoc = file => /^cli\/(?:README\.md|examples\/README\.md)$/i.test(file);
const cliDocsEngine = file => file.startsWith('cli/src/commands/docs/');
const cliSharedPackage = file => /^cli\/package(?:-lock)?\.json$/.test(file);
const acceptanceScript = file => file.startsWith('scripts/acceptance/');
const sitePath = file => file.startsWith('site/') || file.startsWith('docs/');
const docsSiteScript = file => /^scripts\/(?:build-docs-site|build-docs-snapshot|publish-docs-manifest|verify-docs-snapshot|report-docs-build)\.mjs$/.test(file);

function classify(file) {
  const docs = isMarkdown(file);
  // Root command wiring and workflows are shared CI infrastructure. Never
  // exempt package.json: website dependencies come from the published CLI
  // package too. Workflow files always select both applications; other .github
  // configuration does, while prose such as the PR template stays docs-only.
  if (file.startsWith('.github/workflows/')) return { cli: true, site: true, docs };
  if (file.startsWith('.github/') && !isMarkdown(file)) return { cli: true, site: true, docs };
  if (file === 'package.json' || file === 'scripts/changed-components.mjs') {
    return { cli: true, site: true, docs };
  }
  if (cliProseDoc(file)) return { cli: false, site: false, docs: true };
  if (file.startsWith('cli/')) return { cli: true, site: cliDocsEngine(file) || cliSharedPackage(file), docs };
  if (sitePath(file)) return { cli: false, site: true, docs };
  if (docsSiteScript(file)) return { cli: false, site: true, docs };
  if (acceptanceScript(file)) return { cli: true, site: false, docs };
  // Remaining Markdown is repository prose (root README, AGENTS.md, agent
  // notes); a lightweight docs check covers it.
  if (isMarkdown(file)) return { cli: false, site: false, docs: true };
  // Unrecognised root configuration or tooling: fail safe and check both apps.
  return { cli: true, site: true, docs };
}

const selected = { cli: unknownBase, site: unknownBase, docs: unknownBase };
for (const file of files) {
  const result = classify(file);
  selected.cli ||= result.cli;
  selected.site ||= result.site;
  selected.docs ||= result.docs;
}

process.stdout.write(`cli=${selected.cli}\nsite=${selected.site}\ndocs=${selected.docs}\n`);
