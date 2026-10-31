import { spawnSync } from 'node:child_process';
import { declareCapabilities } from '../capabilities.js';
import { AppError, CodeAPI, CodeNetwork } from '../errors.js';
import { checkLatest, getReleaseChannel, getVersion } from './version.js';

for (const name of ['upgrade', 'update']) {
  declareCapabilities(name, { noInstance: true, skipDailyChecks: true });
}

function installPackage(args, { structured }) {
  const result = spawnSync('npm', args, { stdio: structured ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new AppError(CodeAPI, 'npm could not upgrade jsn.', 'Check npm installation permissions and connectivity, then retry.');
  }
}

function isNewer(candidate, installed) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    if (!match) throw new AppError(CodeAPI, 'The registry returned an invalid package version.');
    return { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') };
  };
  const a = parse(candidate), b = parse(installed);
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  }
  if (!a.pre || !b.pre) return !a.pre && Boolean(b.pre);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === b.pre[i]) continue;
    if (a.pre[i] === undefined) return false;
    if (b.pre[i] === undefined) return true;
    const an = /^\d+$/.test(a.pre[i]), bn = /^\d+$/.test(b.pre[i]);
    if (an && bn) return Number(a.pre[i]) > Number(b.pre[i]);
    if (an !== bn) return !an;
    return a.pre[i] > b.pre[i];
  }
  return false;
}

export function upgradeCmd(wrap, { version = getVersion, check = checkLatest, install = installPackage } = {}) {
  return {
    command: 'upgrade',
    aliases: ['update'],
    describe: 'Upgrade jsn through npm (preserves the installed release channel)',
    builder: (y) => y
      .option('channel', { type: 'string', choices: ['dev', 'latest'], describe: 'Choose the npm release channel' })
      .option('dry-run', { type: 'boolean', describe: 'Show the install command without installing' })
      .option('force', { type: 'boolean', describe: 'Reinstall even when the selected version is not newer' }),
    handler: wrap(async (argv, app) => {
      const current = version();
      const channel = argv.channel || getReleaseChannel(current);
      const args = ['install', '-g', `@jacebenson/jsn@${channel}`];
      const command = `npm ${args.join(' ')}`;
      if (argv.dryRun || argv['dry-run']) {
        app.ok({ version: current, channel, dryRun: true, installCmd: command }, { summary: command });
        return;
      }
      const latest = await check({ version: current, channel });
      if (!latest) throw new AppError(CodeNetwork, 'Could not check the npm release channel.', 'Check connectivity and retry; use --dry-run to inspect the command.');
      const switching = argv.channel && channel !== getReleaseChannel(current);
      if (!argv.force && !switching && !isNewer(latest, current)) {
        app.ok({ version: current, latest, channel, upToDate: true }, { summary: `jsn ${current} — no newer version available` });
        return;
      }
      await install(args, { structured: Boolean(!process.stdout.isTTY || argv.json || argv.get || argv.format === 'json') });
      app.ok({ previousVersion: current, version: latest, channel, upgraded: true }, { summary: `Installed jsn from the ${channel} channel (registry version ${latest})` });
    }),
  };
}
