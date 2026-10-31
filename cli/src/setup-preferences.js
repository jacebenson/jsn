import { confirm, select, input } from '@inquirer/prompts';
import { ensureLocalDocumentation } from './commands/docs/local.js';
import { saveConfig } from './config.js';
import { docsServiceUrl, DEFAULT_DOCS_URL } from './commands/docs/client.js';

export function connectionPreferences(config, existing = {}, flags = {}) {
  const saved = { read_only: false, skip_confirmations: false, include_counts: true };
  // Legacy profiles retain their historical defaults when a field is absent.
  const source = Object.keys(existing).length ? existing : (config.connectionDefaults || {});
  for (const key of Object.keys(saved)) if (typeof source[key] === 'boolean') saved[key] = source[key];
  for (const key of ['read_only', 'skip_confirmations', 'include_counts']) {
    const flag = key.replaceAll('_', '-');
    if (typeof flags[flag] === 'boolean') saved[key] = flags[flag];
  }
  return Object.fromEntries(['read_only', 'skip_confirmations', 'include_counts'].map(key => [key, Boolean(saved[key])]));
}

export async function askConnectionPreferences(defaults, prompts = { confirm }) {
  return {
    read_only: await prompts.confirm({ message: 'Read-only connections (block changes)?', default: defaults.read_only }),
    skip_confirmations: !(await prompts.confirm({ message: 'Confirm before deleting records?', default: !defaults.skip_confirmations })),
    include_counts: await prompts.confirm({ message: 'Include result totals on list commands?', default: defaults.include_counts }),
  };
}

export async function chooseConnectionPreferences(config, flags = {}, prompts = { confirm }) {
  const defaults = connectionPreferences(config, {}, flags);
  const summary = `Read-only: ${defaults.read_only ? 'yes' : 'no'} · Delete confirmations: ${defaults.skip_confirmations ? 'off' : 'on'} · Result totals: ${defaults.include_counts ? 'on' : 'off'}`;
  if (await prompts.confirm({ message: `${summary}\nUse these defaults for this connection?`, default: true })) return defaults;
  return askConnectionPreferences(defaults, prompts);
}

export async function configureDocumentation(config, prompts = { input, confirm }) {
  const current = config.docs || { source: 'hosted', url: DEFAULT_DOCS_URL };
  const hosted = await prompts.confirm({ message: 'Use JSN-hosted documentation?', default: current.source === 'hosted' });
  const next = { source: hosted ? 'hosted' : 'custom', url: DEFAULT_DOCS_URL };
  if (!hosted && await prompts.confirm({ message: 'Run a local documentation server for you?', default: current.source !== 'custom' })) {
    next.source = 'local';
    next.url = (await ensureLocalDocumentation()).url;
  } else if (!hosted) {
    next.url = await prompts.input({ message: 'Docs service base URL:', default: current.source === 'custom' ? current.url : 'http://127.0.0.1:3000',
      validate: value => { try { docsServiceUrl(value); return true; } catch (error) { return error.message; } } });
    next.url = docsServiceUrl(next.url);
  }
  config.docs = next;
  saveConfig(config);
  return next;
}

export async function configureGlobalDefaults(config, { documentation = true, prompts = { confirm, select, input } } = {}) {
  const preferences = await askConnectionPreferences(connectionPreferences(config), prompts);
  config.connectionDefaults = preferences;
  saveConfig(config);
  if (documentation) await configureDocumentation(config, prompts);
  return preferences;
}
