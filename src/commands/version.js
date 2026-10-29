import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { declareCapabilities } from '../capabilities.js';

declareCapabilities('version', { noInstance: true, skipDailyChecks: true });

const NPM_PKG = '@jacebenson/jsn';
export function getReleaseChannel(version = getVersion()) {
  return /^\d+\.\d+\.\d+-dev\./.test(version) ? 'dev' : 'latest';
}

export function getInstallCommand(version = getVersion()) {
  return `npm install -g ${NPM_PKG}${getReleaseChannel(version) === 'dev' ? '@dev' : ''}`;
}

export function getVersion() {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

const backgroundChecks = new Set();

export function cancelBackgroundChecks() {
  for (const controller of backgroundChecks) controller.abort();
  backgroundChecks.clear();
}

export async function checkLatest({ timeout = 1500, background = false, version = getVersion() } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  timer.unref();
  if (background) backgroundChecks.add(controller);
  try {
    const res = await fetch(`https://registry.npmjs.org/${NPM_PKG}/${getReleaseChannel(version)}`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.version === 'string' ? data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    backgroundChecks.delete(controller);
  }
}

export function versionCmd(wrap) {
  return {
    command: 'version',
    describe: 'Show version information',
    builder: (y) => y
      .option('check', {
        alias: 'c',
        type: 'boolean',
        describe: 'Check npm registry for newer version',
      }),
    handler: wrap(async (argv, app) => {
      const version = getVersion();

      if (argv.check) {
        const latest = await checkLatest({ version });
        if (!latest) {
          app.ok({ version }, {
            summary: `jsn ${version} (could not reach npm registry to check for updates)`,
            notice: `Run \`npm view ${NPM_PKG}@${getReleaseChannel(version)} version\` directly to check manually`,
          });
          return;
        }

        const isUpToDate = version === latest;

        if (isUpToDate) {
          app.ok({
            version,
            latest,
            upToDate: true,
          }, {
            summary: `jsn ${version} — up to date`,
          });
        } else {
          app.ok({
            version,
            latest,
            upToDate: false,
            installCmd: getInstallCommand(version),
          }, {
            summary: `jsn ${version} — newer version ${latest} available`,
            breadcrumbs: [
              { action: 'update', cmd: getInstallCommand(version), description: `Update jsn from ${version} to ${latest}` },
            ],
          });
        }
      } else {
        app.ok({ version }, { summary: `jsn ${version}` });
      }
    }),
  };
}
