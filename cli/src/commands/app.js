// `jsn app ...` — local app-project tooling, plus installing a package.
//
// `build` turns a validated project directory (app.yaml + records/ + code/)
// into a deployable artifact. Two backends exist, and the choice is the
// project's (`app.yaml` `backend:`) unless `--backend` overrides it:
//
//   update-set  one XML export the existing importer accepts
//   package     one native app-package zip (inventory + scope + update records)
//
// `build` is local-only: no instance, no upload, no state change. Promotion for
// an update set stays a manual, deliberate step on the target instance
// (import → preview → commit).
//
// `deploy` is the package backend's install path: it builds the same zip in
// memory, uploads it through the platform's app upload processor, waits for the
// install tracker, and then reads the application row and every packaged record
// back to prove the instance holds what was uploaded. It is the only command in
// this family that writes to an instance, and it is declared as such.

import fs from 'node:fs';
import path from 'node:path';
import { deferredFamilyDefinition } from '../command-families.js';
import { readAppProject } from '../app-project.js';
import { buildAppUpdateSet } from '../app-build-update-set.js';
import { buildPackageZip, packageFileName } from '../app-build-package.js';
import { deployAppPackage } from '../app-deploy.js';
import { updateSetFilename } from '../update-set-xml.js';
import { errUsage, errUsageHint, AppError } from '../errors.js';
import { buildRerunCommand, confirmWrite, quoteShellArg } from '../helpers.js';

const SUPPORTED_BACKENDS = ['update-set', 'package'];

/**
 * The confirmation gate for `app deploy`.
 *
 * `confirmWrite()` returns the answer — false when the person declined — and only
 * throws in non-interactive mode. The deploy must stop on a decline, so the answer
 * is returned to the caller instead of being awaited for its side effect.
 *
 * @param {object} argv
 * @param {object} app
 * @param {object} project
 * @param {{confirm?: Function}} [deps] — seam for tests
 * @returns {Promise<boolean>} true when the install may proceed
 */
export async function confirmDeployInstall(argv, app, project, deps = {}) {
  const confirm = deps.confirm || confirmWrite;
  const question = `Install app "${project.app.name}" ${project.app.version} `
    + `(scope ${project.app.scope}, ${project.records.length} records) on ${app.getEffectiveInstance()}? `
    + 'This writes to the instance.';
  return (await confirm(argv, app, question, { rerun: deployRerun(argv) })) === true;
}

function writeArtifact(file, contents) {
  const target = path.resolve(file);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  try {
    // `contents` is XML text or zip bytes; writing through a same-directory
    // temp file means a failed build never leaves a partial artifact behind.
    fs.writeFileSync(temporary, contents, { flag: 'wx' });
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* nothing to clean up */ }
    throw new AppError('write_error', `Cannot write ${target}: ${error.message}`);
  }
  return target;
}

function nextCommands(out, setName) {
  const file = quoteShellArg(out);
  const name = quoteShellArg(setName);
  return [
    `jsn updatesets import ${file}`,
    `jsn updatesets preview ${name}`,
    `jsn updatesets commit ${name}`,
  ];
}

/**
 * The package artifact plus the local, honest description of deploying it.
 *
 * `jsn app deploy` is that command for the package backend, so the hint names it
 * instead of an instance-side action.
 */
function buildPackageArtifact(project, { out, dir = '.' } = {}) {
  const now = new Date();
  const built = buildPackageZip(project, { now });
  const written = writeArtifact(out === undefined ? packageFileName(project.app) : out, built.zip);
  const deployHint = `Install ${path.basename(written)} on the target instance with `
    + `jsn app deploy --dir ${quoteShellArg(dir)} --yes `
    + '(or Application Manager → Install from file). '
    + 'Nothing was written to any instance by this build.';
  return { built, zip: built.zip, written, deployHint };
}

/**
 * The `--yes` rerun a deploy hint must offer: the same directory, the same demo
 * choice, and the profile the caller selected (buildRerunCommand re-pins it).
 */
function deployRerun(argv) {
  return ['app', 'deploy', '--dir', path.resolve(argv.dir ?? '.'), ...(argv['demo-data'] ? ['--demo-data'] : []), '--yes'];
}

export function appCmd(wrap) {
  return {
    ...deferredFamilyDefinition('app'),
    builder: y => y
      .command({
        command: 'build',
        describe: 'Build a local app project into an update-set XML envelope or an app-package zip (never contacts an instance)',
        builder: b => b
          .option('dir', { type: 'string', default: '.', describe: 'Project directory containing app.yaml' })
          .option('out', { alias: 'o', type: 'string', describe: 'Write the artifact to this file, or "-" for stdout (update-set only). Default: <app name>.xml, or <scope>-<version>.zip for the package backend' })
          .option('backend', { type: 'string', describe: 'Deployment backend: update-set or package (default: app.yaml backend)' })
          .epilogue('Local only: reads app.yaml, records/ and code/, writes one file, and never contacts an instance.\n'
            + 'A record is records/<table>/<slug>.json, or one .js file whose script is the code above its default export.\n'
            + 'update-set: promote with jsn updatesets import, then preview and commit.\n'
            + 'package: install the zip on the target instance (Application Manager → Install from file).\n'
            + 'Example: jsn app build --dir . --out My-App.xml --backend update-set'),
        handler: wrap(async (argv, app) => {
          // The backend is a decision about how the project ships. A name this
          // build does not implement is refused explicitly rather than being
          // silently downgraded to the one implemented path.
          if (argv.backend !== undefined && argv.backend !== '') {
            if (!SUPPORTED_BACKENDS.includes(argv.backend)) {
              throw errUsage(`Unknown backend "${argv.backend}". Supported: ${SUPPORTED_BACKENDS.join(', ')}.`);
            }
          }

          const project = readAppProject(argv.dir);
          const backend = argv.backend || project.backend;
          // `readAppProject` already restricted project.backend to a known
          // value, so this only catches a caller that bypassed it.
          if (!SUPPORTED_BACKENDS.includes(backend)) {
            throw errUsage(`Unknown backend "${backend}". Supported: ${SUPPORTED_BACKENDS.join(', ')}.`);
          }
          const jsonMode = argv.json === true || argv.format === 'json';

          if (backend === 'package') {
            // A zip is binary: streaming it to stdout would corrupt a pipe.
            if (argv.out === '-') {
              throw errUsage('The package backend writes a binary zip, so --out - is not supported. '
                + 'Write it to a file with --out <file>.zip (the default is <scope>-<version>.zip).');
            }

            const { built, zip, written, deployHint } = buildPackageArtifact(project,
              { out: argv.out, dir: argv.dir });
            const deployCommand = buildRerunCommand(argv, { rerun: deployRerun(argv) });
            app.ok({
              app: project.app.name,
              scope: project.app.scope,
              version: project.app.version,
              backend,
              records: project.records.length,
              entries: built.entries.length,
              bytes: zip.length,
              written_to_instance: false,
              out: written,
              deploy_hint: deployHint,
            }, {
              summary: `Packaged app "${project.app.name}" ${project.app.version} `
                + `(${project.records.length} records, ${built.entries.length} entries, ${zip.length} bytes)\n`
                + `  ${written}\n`
                + 'Nothing was written to any instance. To deploy it:\n'
                + `  ${deployCommand}`,
              breadcrumbs: [
                { action: 'deploy', cmd: deployCommand, description: 'Install the package on the selected instance and verify every record' },
              ],
            });
            return;
          }

          const { xml, inspection } = buildAppUpdateSet(project);
          const bytes = Buffer.byteLength(xml, 'utf8');
          const data = {
            app: project.app.name,
            scope: project.app.scope,
            backend,
            updates: inspection.count,
            bytes,
            update_set: {
              name: inspection.name,
              sys_id: inspection.sys_id,
              remote_sys_id: inspection.remote_sys_id,
              state: inspection.state,
            },
            written_to_instance: false,
          };

          if (argv.out === '-') {
            if (jsonMode) {
              app.ok({ ...data, out: null, xml }, {
                summary: `Built update set "${inspection.name}" (${inspection.count} updates) on stdout; nothing was written to any instance`,
              });
              return;
            }
            // Raw XML so `jsn app build --out - > app.xml` pipes cleanly.
            process.stdout.write(xml);
            return;
          }

          const out = writeArtifact(argv.out === undefined ? updateSetFilename(project.app.name) : argv.out, xml);
          const commands = nextCommands(out, inspection.name);
          app.ok({ ...data, out, next_commands: commands }, {
            summary: `Built update set "${inspection.name}" (${inspection.count} updates) for app "${project.app.name}"\n`
              + `  ${out}\n`
              + 'Nothing was written to any instance. To promote it:\n'
              + commands.map(command => `  ${command}`).join('\n'),
            breadcrumbs: [
              { action: 'import', cmd: commands[0], description: 'Load the XML on the target instance as a retrieved update set' },
              { action: 'preview', cmd: commands[1], description: 'Preview the loaded set before committing it' },
              { action: 'commit', cmd: commands[2], description: 'Commit after reviewing the preview' },
            ],
          });
        }),
      })
      .command({
        command: 'deploy',
        describe: 'Install this package-backend app on the selected instance and verify every record (writes to the instance)',
        builder: b => b
          .option('dir', { type: 'string', default: '.', describe: 'Project directory containing app.yaml' })
          .option('demo-data', { type: 'boolean', describe: 'Install the app with its demo data (load_demo=true)' })
          .option('yes', { type: 'boolean', describe: 'Confirm installing this package on the selected target' })
          .epilogue('Writes to the instance: builds the package in memory, uploads it through the platform app\n'
            + 'upload processor, waits for the install tracker, then reads the application row and every\n'
            + 'packaged record back. A readback disagreement is a failed deploy, never a warning.\n'
            + 'Requires a write-enabled profile; --yes confirms the target, as with jsn updatesets.\n'
            + 'Example: jsn app deploy --dir . --profile dev --yes'),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          const project = readAppProject(argv.dir);
          // The package backend is what this command installs. A project that
          // ships an update set has a different promotion path, and silently
          // packaging it would deploy something the project did not declare.
          if (project.backend !== 'package') {
            throw errUsageHint(
              `This project's backend is "${project.backend}"; jsn app deploy only installs the package backend.\n`
              + 'Set "backend: package" (and app.version) in app.yaml to deploy a package, or promote the update set instead.',
              'jsn updatesets import <file>, then preview and commit',
            );
          }

          // Build before asking anything: a project that cannot be packaged
          // must fail with nothing uploaded and nothing to confirm.
          const built = buildPackageZip(project, { now: new Date() });

          const rerunCommand = buildRerunCommand(argv, { rerun: deployRerun(argv) });
          // A declined install must upload nothing at all.
          if (!await confirmDeployInstall(argv, app, project)) return;

          const report = await deployAppPackage({
            sdk: app.sdk,
            project,
            built,
            demoData: argv['demo-data'] === true,
            options: { rerun: rerunCommand },
          });

          const appRecordCommand = `jsn records get sys_app ${quoteShellArg(report.sys_id)}`;
          app.ok({
            ...report,
            next_commands: [appRecordCommand],
          }, {
            summary: `Installed app "${report.app}" ${report.version} on ${app.getEffectiveInstance()}\n`
              + `  scope ${report.scope}, app sys_id ${report.sys_id}\n`
              + `  uploaded ${report.bytes} bytes (${report.entries} entries), `
              + `tracker ${report.tracker.label}${report.tracker.percent_complete ? ` (${report.tracker.percent_complete}%)` : ''}\n`
              + `  records verified ${report.records.verified}/${report.records.total}\n`
              + (report.records.verified === report.records.total
                ? 'The instance holds exactly what was uploaded.'
                : 'Readback did not match what was uploaded.'),
            breadcrumbs: [
              { action: 'records', cmd: appRecordCommand, description: 'Read the installed application record' },
            ],
          });
        }),
      }),
  };
}
