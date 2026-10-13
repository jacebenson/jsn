import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

const INSTALL_HOST = 'install.service-now.com';

function defaultRun(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    stdio: options.stdio || 'inherit',
  });
}

function assertSafePart(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} may contain only letters, numbers, dots, underscores, and dashes`);
  }
}

export function normalizeMidName(name) {
  const shortName = String(name || '').replace(/^mid\.server\./, '');
  assertSafePart(shortName, 'MID Server name');
  return shortName;
}

export function buildMidRecipeUrl(releaseName) {
  const match = String(releaseName).match(/(\d{4})-(\d{2})-(\d{2})|(\d{2})-(\d{2})-(\d{4})/);
  if (!match) throw new Error(`MID release name has no build date: ${releaseName}`);
  const year = match[1] || match[6];
  const month = match[2] || match[4];
  const day = match[3] || match[5];
  const filename = `mid-linux-container-recipe.${releaseName}.linux.x86-64.zip`;
  return `https://${INSTALL_HOST}/glide/distribution/builds/package/app-signed/mid-linux-container-recipe/${year}/${month}/${day}/${filename}`;
}

export async function validateMidCredentials(instanceURL, username, password, fetchImpl = fetch) {
  if (!username || !password) throw new Error('MID Server username and password are required');
  const endpoint = `${String(instanceURL).replace(/\/$/, '')}/api/now/table/sys_properties?sysparm_query=name=mid.version&sysparm_fields=value&sysparm_limit=1`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      },
    });
  } catch {
    throw new Error('Could not reach the ServiceNow instance to validate the MID Server credentials');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('The MID Server username or password was rejected by the ServiceNow instance');
  }
  if (!response.ok) {
    throw new Error(`MID Server credential validation failed with HTTP ${response.status}`);
  }
  const body = await response.json();
  const releaseName = body?.result?.[0]?.value;
  if (!releaseName) throw new Error('Credential validation succeeded, but the instance returned no mid.version value');
  return { releaseName };
}

export function detectDocker(run = defaultRun) {
  const status = { installed: false, compose: false, daemon: false, available: false };
  try { run('docker', ['--version'], { stdio: 'ignore' }); status.installed = true; } catch { return status; }
  try { run('docker', ['compose', 'version'], { stdio: 'ignore' }); status.compose = true; } catch { return status; }
  try { run('docker', ['info'], { stdio: 'ignore' }); status.daemon = true; } catch { return status; }
  status.available = true;
  return status;
}

export function dockerComposeAvailable(run = defaultRun) {
  return detectDocker(run).available;
}

function composeFile({ serviceName }) {
  return `services:\n  ${serviceName}:\n    container_name: ${serviceName}\n    image: ${serviceName}:\${MID_RELEASE}\n    restart: unless-stopped\n    volumes:\n      - ./export:/opt/snc_mid_server/agent/export\n    environment:\n      MID_INSTANCE_URL: \${MID_INSTANCE_URL}\n      MID_INSTANCE_USERNAME: \${MID_INSTANCE_USERNAME}\n      MID_INSTANCE_PASSWORD: \${MID_INSTANCE_PASSWORD}\n      MID_SERVER_NAME: \${MID_SERVER_NAME}\n`;
}

export async function installDockerMidServer({
  instanceURL,
  username,
  password,
  name,
  directory,
  releaseName: suppliedReleaseName,
  fetchImpl = fetch,
  run = defaultRun,
}) {
  if (!dockerComposeAvailable(run)) {
    throw new Error('Docker and Docker Compose are required for Docker MID Server installation');
  }
  const shortName = normalizeMidName(name);
  const displayName = `mid.server.${shortName}`;
  const releaseName = suppliedReleaseName || (await validateMidCredentials(instanceURL, username, password, fetchImpl)).releaseName;
  const recipeURL = buildMidRecipeUrl(releaseName);
  const installDir = directory || path.join(os.homedir(), '.local', 'share', 'jsn', 'midservers', shortName);
  fs.mkdirSync(installDir, { recursive: true, mode: 0o700 });
  const exportDir = path.join(installDir, 'export');
  fs.mkdirSync(exportDir, { recursive: true, mode: 0o700 });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-mid-'));
  const filename = path.basename(recipeURL);
  const archive = path.join(workDir, filename);
  const recipeDir = path.join(workDir, 'recipe');
  try {
    run('curl', ['-fSL', '--connect-timeout', '10', '--max-time', '300', recipeURL, '-o', archive]);
    fs.mkdirSync(recipeDir, { recursive: true, mode: 0o700 });
    run('unzip', ['-q', archive, '-d', recipeDir]);
    const composePath = path.join(installDir, 'docker-compose.yaml');
    const serviceName = `jsn_mid_${shortName.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
    run('docker', ['build', '--tag', `${serviceName}:${releaseName}`, recipeDir]);
    fs.writeFileSync(composePath, composeFile({ serviceName, instanceURL, displayName }), { mode: 0o600 });
    const env = {
      MID_RELEASE: releaseName,
      MID_INSTANCE_URL: `${String(instanceURL).replace(/\/$/, '')}/`,
      MID_INSTANCE_USERNAME: username,
      MID_INSTANCE_PASSWORD: password,
      MID_SERVER_NAME: displayName,
    };
    run('docker', ['compose', '-f', composePath, 'up', '-d'], { cwd: installDir, env });
    return {
      name: displayName,
      releaseName,
      installDir,
      composePath,
      serviceName,
      rollback: () => run('docker', ['compose', '-f', composePath, 'down'], { cwd: installDir, env }),
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export { defaultRun };
