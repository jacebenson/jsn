import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NPM_PKG = '@jacebenson/jsn';
const NPM_REGISTRY = `https://registry.npmjs.org/${NPM_PKG}/latest`;

function getVersion() {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

async function checkLatest() {
  try {
    const res = await fetch(NPM_REGISTRY);
    if (!res.ok) return null;
    const data = await res.json();
    return data.version;
  } catch {
    return null;
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
        const latest = await checkLatest();
        if (!latest) {
          app.ok({ version }, {
            summary: `jsn ${version} (could not reach npm registry to check for updates)`,
            notice: `Run \`npm view ${NPM_PKG}\` directly to check manually`,
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
            installCmd: `npm install -g ${NPM_PKG}`,
          }, {
            summary: `jsn ${version} — newer version ${latest} available`,
            breadcrumbs: [
              { action: 'update', cmd: `npm install -g ${NPM_PKG}`, description: `Update jsn from ${version} to ${latest}` },
            ],
          });
        }
      } else {
        app.ok({ version }, { summary: `jsn ${version}` });
      }
    }),
  };
}
