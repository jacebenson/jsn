import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateRemoteTarget } from './midserver-remote.js';
import { buildMidZipUrl } from './midserver-direct.js';

const FILE = '.jsn-mid-linux-remote.json';
// Static program only in argv; all deployment data and credentials travel on stdin.
const PROGRAM = String.raw`
import os,sys,json,stat,platform,shutil,subprocess,time,zipfile,urllib.request,hashlib,re,xml.etree.ElementTree as ET
p=json.load(sys.stdin)
def fail(): raise RuntimeError('Remote native MID safety check failed')
def result(v): print('JSN_RESULT:'+json.dumps(v))
def private(d):
 s=os.lstat(d)
 if not stat.S_ISDIR(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode&0o077: fail()
def ancestors(d):
 while d!='/':
  s=os.lstat(d)
  if not stat.S_ISDIR(s.st_mode) or (s.st_mode&0o022 and not s.st_mode&stat.S_ISVTX): fail()
  d=os.path.dirname(d)
def owned():
 private(p['remoteDirectory']); ancestors(p['remoteDirectory'])
 f=os.path.join(p['remoteDirectory'],'.jsn-owner.json'); s=os.lstat(f)
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode&0o077: fail()
 m=json.load(open(f))
 if any(m.get(k)!=p.get(k) for k in ['owner','instanceURL','name','remoteDirectory']): fail()
def processes():
 found=[]; agent=os.path.join(p['remoteDirectory'],'agent')
 for entry in os.listdir('/proc'):
  if not entry.isdigit(): continue
  try:
   proc='/proc/'+entry
   if os.stat(proc).st_uid!=os.getuid(): continue
   exe=os.readlink(proc+'/exe'); cwd=os.readlink(proc+'/cwd')
   if exe in [agent+'/bin/wrapper-linux-x86-64',agent+'/jre/bin/java'] and cwd==agent: found.append(int(entry))
  except (FileNotFoundError,PermissionError,ProcessLookupError): continue
 return found
def safe_tree():
 for root,dirs,files in os.walk(p['remoteDirectory'],followlinks=False):
  for name in dirs+files:
   s=os.lstat(os.path.join(root,name))
   if not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode)) or s.st_uid!=os.getuid(): fail()
def launcher(action):
 owned(); safe_tree()
 if action=='stop':
  pidfile=os.path.join(p['remoteDirectory'],'agent','work','jsn_mid_'+p['owner'].replace('-','')+'.pid')
  s=os.lstat(pidfile)
  if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_size>64: fail()
  value=open(pidfile).read().strip()
  if not re.fullmatch('[1-9][0-9]*',value) or int(value) not in processes(): fail()
 subprocess.run(['sh','bin/mid.sh',action],cwd=os.path.join(p['remoteDirectory'],'agent'),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True,timeout=90,start_new_session=True)
if platform.system()!='Linux' or platform.machine() not in ['x86_64','amd64'] or os.getuid()==0: fail()
action=p['action']; d=p.get('remoteDirectory')
if action=='prepare':
 home=os.path.expanduser('~'); ancestors(home)
 if os.lstat(home).st_uid!=os.getuid(): fail()
 d=os.path.join(home,'.jsn-mid',p['owner'])
 if os.path.lexists(d): fail()
 result(dict(remoteDirectory=d,platform='linux-x64',elevated=False,requiresElevation=False,runtime='user-background',freeBytes=shutil.disk_usage(home).free,python=platform.python_version()))
elif action=='install':
 if os.path.lexists(d): fail()
 parent=os.path.dirname(d)
 if not os.path.exists(parent): os.mkdir(parent,0o700)
 private(parent); ancestors(parent)
 if shutil.disk_usage(parent).free<3*1024**3: fail()
 os.mkdir(d,0o700); os.umask(0o077)
 marker={k:p[k] for k in ['owner','instanceURL','name','remoteDirectory']}
 with open(os.path.join(d,'.jsn-owner.json'),'x') as f: json.dump(marker,f)
 archive=os.path.join(d,'.download.zip')
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args): fail()
 opener=urllib.request.build_opener(NoRedirect)
 total=0; digest=hashlib.sha256()
 with opener.open(p['archiveURL'],timeout=600) as source,open(archive,'xb') as dest:
  while True:
   chunk=source.read(1024*1024)
   if not chunk: break
   total+=len(chunk)
   if total>1024**3: fail()
   digest.update(chunk); dest.write(chunk)
 with zipfile.ZipFile(archive) as z:
  entries=z.infolist(); seen=set(); expanded=0
  if len(entries)>20000: fail()
  for e in entries:
   n=e.filename; parts=n.rstrip('/').split('/'); mode=e.external_attr>>16; kind=stat.S_IFMT(mode)
   if not parts or parts[0] not in ['agent','META-INF'] or '\\' in n or any(x in ['','.','..'] or any(ord(c)<32 for c in x) for x in parts) or kind not in [0,stat.S_IFDIR,stat.S_IFREG]: fail()
   if n.rstrip('/') in seen: fail()
   seen.add(n.rstrip('/')); expanded+=e.file_size
   if expanded>2*1024**3: fail()
  for e in entries:
   dest=os.path.join(d,e.filename)
   if e.is_dir(): os.makedirs(dest,mode=0o700,exist_ok=True); continue
   os.makedirs(os.path.dirname(dest),mode=0o700,exist_ok=True)
   with z.open(e) as source,open(dest,'xb') as target: shutil.copyfileobj(source,target,1024*1024)
   os.chmod(dest,0o700 if (e.external_attr>>16)&0o111 else 0o600)
 agent=os.path.join(d,'agent')
 for name in ['config.xml','conf/wrapper.conf','conf/wrapper-override.conf','bin/mid.sh','bin/wrapper-linux-x86-64','jre/bin/java']:
  if not os.path.isfile(os.path.join(agent,name)): fail()
 wrapper=open(os.path.join(agent,'conf/wrapper.conf')).read()
 script=open(os.path.join(agent,'bin/mid.sh')).read()
 if 'wrapper.java.command=jre/bin/java' not in wrapper or 'wrapper-override.conf' not in wrapper or 'SERVICE_MANAGEMENT_TOOL' not in script: fail()
 config=os.path.join(agent,'config.xml'); tree=ET.parse(config,parser=ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))); root=tree.getroot()
 if root.tag!='parameters': fail()
 for key,value in {'url':p['instanceURL']+'/','name':p['name'],'mid.instance.username':p['username'],'mid.instance.password':p['password']}.items():
  nodes=[e for e in root.findall('parameter') if e.get('name')==key]
  if len(nodes)>1: fail()
  e=nodes[0] if nodes else ET.SubElement(root,'parameter',{'name':key}); e.set('value',value)
  if key=='mid.instance.password': e.set('secure','true')
 tree.write(config,encoding='utf-8',xml_declaration=True)
 token='jsn_mid_'+p['owner'].replace('-','')
 with open(os.path.join(agent,'conf/wrapper-override.conf'),'a') as f: f.write('\nwrapper.name='+token+'\nwrapper.displayname=ServiceNow MID '+token+'\n')
 with open(os.path.join(agent,'bin/mid.shconf_override'),'a') as f: f.write('\nAPP_NAME="'+token+'"\nAPP_LONG_NAME="ServiceNow MID '+token+'"\nSERVICE_MANAGEMENT_TOOL=initd\n')
 os.unlink(archive); result(dict(installed=True,archiveSha256=digest.hexdigest(),status='stopped'))
else:
 owned()
 if action=='start':
  if processes(): fail()
  launcher('start'); time.sleep(2)
  if not processes(): fail()
 elif action=='stop':
  if processes(): launcher('stop')
  for attempt in range(60):
   if not processes(): break
   time.sleep(1)
  if processes(): fail()
 elif action=='remove':
  if processes(): fail()
  safe_tree(); shutil.rmtree(d); result(dict(removed=True)); sys.exit(0)
 elif action=='logs':
  safe_tree()
  directory=os.path.join(d,'agent','logs'); candidates=[]
  if os.path.isdir(directory):
   for n in os.listdir(directory):
    if re.fullmatch(r'agent0\.log(?:\.[0-9]+)?',n) or n=='wrapper.log':
     f=os.path.join(directory,n); s=os.lstat(f)
     if stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid(): candidates.append((n!='wrapper.log',s.st_mtime,f))
  text=''
  if candidates:
   with open(max(candidates)[2],'rb') as f:
    f.seek(max(0,os.fstat(f.fileno()).st_size-1024*1024)); text=f.read().decode('utf-8','replace')
  result(dict(logs='\n'.join(text.splitlines()[-p['tail']:]))); sys.exit(0)
 elif action!='inspect': fail()
 ids=processes(); result(dict(status='running' if ids else 'stopped',pids=ids,runtime='user-background',requiresElevation=False))
`;

function remote(target, payload, { run = execFileSync, timeout = 30000 } = {}) {
  validateRemoteTarget(target);
  const encoded = Buffer.from(PROGRAM).toString('base64');
  const command = `python3 -c 'import base64;exec(base64.b64decode("${encoded}"))'`;
  let output;
  try { output = String(run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', '--', target, command], { input: JSON.stringify(payload), timeout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })); }
  catch { throw new Error('Remote Linux MID operation failed; Python 3 and a non-root Linux x64 account are required. Inspect owned installation before retrying.'); }
  const line = output.split(/\r?\n/).findLast(value => value.startsWith('JSN_RESULT:'));
  try { if (!line) throw new Error(); return JSON.parse(line.slice(11)); }
  catch { throw new Error('Remote Linux MID returned no verified result'); }
}
function save(directory, m) { fs.writeFileSync(path.join(directory, FILE), JSON.stringify(m, null, 2), { mode: 0o600 }); fs.chmodSync(path.join(directory, FILE), 0o600); }
function load(directory) {
  const dir = fs.lstatSync(directory), file = fs.lstatSync(path.join(directory, FILE));
  if (!dir.isDirectory() || dir.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || (dir.mode & 0o077) || (file.mode & 0o077)) throw new Error('Linux MID metadata must be private');
  const m = JSON.parse(fs.readFileSync(path.join(directory, FILE), 'utf8')); validateRemoteTarget(m.target);
  if (m.version !== 1 || !/^[a-f0-9-]{36}$/.test(m.owner) || !m.remoteDirectory?.startsWith('/') || m.remoteDirectory !== path.posix.normalize(m.remoteDirectory) || !m.remoteDirectory.endsWith(`/.jsn-mid/${m.owner}`)) throw new Error('Invalid Linux MID ownership metadata');
  return m;
}
export function prepareLinuxRemoteMidServer({ target, instanceURL, name, directory, platform = process.platform, ...options }) {
  if (platform === 'win32') throw new Error('A POSIX controller is required for private local metadata');
  validateRemoteTarget(target);
  const url = new URL(instanceURL);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name || '')) throw new Error('Valid HTTPS origin and MID name required');
  if (fs.existsSync(directory)) throw new Error('Local deployment directory exists; no adoption');
  const owner = randomUUID();
  const report = remote(target, { action: 'prepare', owner }, options);
  if (report.platform !== 'linux-x64' || report.requiresElevation !== false || report.freeBytes < 3 * 1024 ** 3 || !report.remoteDirectory?.endsWith(`/.jsn-mid/${owner}`)) throw new Error('Linux preflight failed');
  const m = { version: 1, target, owner, instanceURL: url.origin, name, ...report, state: 'prepared' };
  fs.mkdirSync(directory, { mode: 0o700 }); fs.chmodSync(directory, 0o700); save(directory, m); return m;
}
export function installLinuxRemoteMidServer({ directory, releaseName, username, password, ...options }) {
  const m = load(directory);
  if (m.state !== 'prepared' || !username || !password || [...String(username) + String(password)].some(char => char.codePointAt(0) < 32 && !['\t', '\n', '\r'].includes(char))) throw new Error('Fresh deployment and valid credentials required');
  const archiveURL = buildMidZipUrl(releaseName, 'linux');
  m.state = 'installing'; save(directory, m);
  try {
    const result = remote(m.target, { ...m, action: 'install', archiveURL, username, password }, { ...options, timeout: 1200000 });
    if (!result.installed || !/^[a-f0-9]{64}$/i.test(result.archiveSha256 || '')) throw new Error('Installation unverified');
    Object.assign(m, { state: 'installed', releaseName, archiveSha256: result.archiveSha256 }); save(directory, m); return m;
  } catch (error) { m.state = 'uncertain'; save(directory, m); throw error; }
}
function operation(action, { directory, ...options }) {
  const m = load(directory);
  try {
    const result = remote(m.target, { ...m, action }, { ...options, timeout: action === 'start' || action === 'stop' ? 180000 : 30000 });
    if ((action === 'start' && result.status !== 'running') || (action === 'stop' && result.status !== 'stopped')) throw new Error('Runtime state unverified');
    if (action === 'remove' && result.removed !== true) throw new Error('Removal unverified');
    m.state = action === 'remove' ? 'removed' : result.status; save(directory, m); return { ...m, ...result };
  } catch (error) { m.state = 'uncertain'; save(directory, m); throw error; }
}
export const inspectLinuxRemoteMidServer = options => operation('inspect', options);
export const startLinuxRemoteMidServer = options => operation('start', options);
export const stopLinuxRemoteMidServer = options => operation('stop', options);
export function removeLinuxRemoteMidServer(options) {
  stopLinuxRemoteMidServer(options);
  return operation('remove', options);
}
export function logsLinuxRemoteMidServer({ directory, tail = 100, ...options }) {
  if (!Number.isInteger(tail) || tail < 1 || tail > 10000) throw new Error('Log tail must be 1–10000');
  const m = load(directory); return remote(m.target, { ...m, action: 'logs', tail }, options).logs;
}
