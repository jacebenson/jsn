#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const cli = path.join(root, 'cli', 'bin', 'jsn.js');
const evidenceDir = path.join(root, '.verification', 'evidence');
const scratchDir = path.join(root, '.verification', 'scratch');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'cli', 'package.json'), 'utf8'));

fs.mkdirSync(evidenceDir, { recursive: true });
fs.mkdirSync(scratchDir, { recursive: true });

const [, , action, ...args] = process.argv;
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

function runJsn(argv) {
  const result = spawnSync(process.execPath, [cli, ...argv], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1' },
  });
  return {
    argv,
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parseJson(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}`);
  }
}

function writeEvidence(prefix, value) {
  const file = path.join(evidenceDir, `${prefix}-${timestamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function doctor() {
  const profile = valueAfter('--profile') ?? 'pdi';
  const allowUnauthenticated = args.includes('--allow-unauthenticated');
  const versionResult = runJsn(['version', '--json']);
  const statusResult = runJsn(args.includes('--profile') ? ['--profile', profile, 'auth', 'status', '--json'] : ['auth', 'status', '--json']);
  const version = parseJson(versionResult, 'version');
  const status = parseJson(statusResult, 'auth status');
  const selected = (status.data?.profiles ?? []).find((item) => item.name === profile);
  const evidence = {
    kind: 'jsn-doctor',
    package_version: packageJson.version,
    binary: path.relative(root, cli),
    version: { status: versionResult.status, reported: version.data?.version ?? null },
    profile: selected ? {
      name: selected.name,
      instance_host: selected.instance ? new URL(selected.instance).hostname : null,
      default: selected.default === true,
      authenticated: selected.authenticated === true,
      verified: selected.verified ?? null,
      read_only: selected.read_only === true,
      auth_method: selected.diagnostics?.auth_method ?? null,
      auth_source: selected.diagnostics?.auth_source ?? null,
      probe_status: selected.diagnostics?.probe?.status ?? null,
      probe_code: selected.diagnostics?.probe?.code ?? null,
    } : null,
    auth_boundary: 'credential contents were not read or printed',
    commands: {
      version: versionResult.status,
      auth_status: statusResult.status,
    },
  };
  const file = writeEvidence('doctor', evidence);
  const healthy = versionResult.status === 0 && version.data?.version === packageJson.version && selected;
  const authOkay = selected?.authenticated === true;
  console.log(JSON.stringify({ ok: Boolean(healthy && (authOkay || allowUnauthenticated)), evidence: file, ...evidence }, null, 2));
  if (!healthy || (!authOkay && !allowUnauthenticated)) process.exitCode = 2;
}

function drive() {
  const query = valueAfter('--query') ?? 'GlideRecord';
  const status = runJsn(['docs', 'status', '--json']);
  const json = runJsn(['docs', 'search', query, '--limit', '3', '--json']);
  const human = runJsn(['docs', 'search', query, '--limit', '3', '--markdown']);
  const parsed = parseJson(json, 'docs search');
  const first = parsed.data?.results?.[0];
  const read = first ? runJsn(['docs', 'show', String(first.id), '--revision', parsed.data.revision, '--json']) : null;
  const document = read ? parseJson(read, 'docs show') : null;
  const readOkay = !read || (read.status === 0 && document.ok === true && typeof document.data?.body === 'string');
  const evidence = {
    kind: 'jsn-hosted-docs-drive',
    fixture: 'public documentation REST service (JSN_DOCS_URL or default deployment)',
    query,
    commands: {
      docs_status: status.status,
      docs_search_json: json.status,
      docs_search_markdown: human.status,
      docs_show_json: read?.status ?? null,
    },
    json: parsed,
    read: document ? { id: document.data?.id, path: document.data?.path, revision: document.data?.revision, body_length: document.data?.body?.length ?? 0 } : null,
    human_readable: human.stdout,
  };
  const file = writeEvidence('drive', evidence);
  console.log(JSON.stringify({ ok: status.status === 0 && json.status === 0 && human.status === 0 && parsed.ok === true && readOkay, evidence: file, query, json_records: parsed.data?.results?.length ?? parsed.data?.records?.length ?? null, human_preview: human.stdout.slice(0, 500) }, null, 2));
  if (status.status !== 0 || json.status !== 0 || human.status !== 0 || parsed.ok !== true || !readOkay) process.exitCode = 2;
}

function cleanup() {
  fs.rmSync(scratchDir, { recursive: true, force: true });
  const evidence = fs.readdirSync(evidenceDir).filter((name) => name.endsWith('.json')).sort();
  const manifest = writeEvidence('manifest', { kind: 'jsn-verification-manifest', cleanup: 'scratch removed; evidence retained', evidence });
  console.log(JSON.stringify({ ok: evidence.length > 0, evidence_dir: evidenceDir, retained: evidence, manifest }, null, 2));
  if (evidence.length === 0) process.exitCode = 2;
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

if (action === 'doctor') doctor();
else if (action === 'drive') drive();
else if (action === 'cleanup') cleanup();
else {
  console.error('Usage: verify-jsn.mjs doctor|drive|cleanup [--profile name] [--allow-unauthenticated] [--query text]');
  process.exitCode = 2;
}
