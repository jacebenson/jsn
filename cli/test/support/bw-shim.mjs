// A `bw` stand-in for tests: the documented CLI subset the Bitwarden backend
// uses, against a JSON file named by JSN_BW_VAULT. Never talks to a real vault.
import fs from 'node:fs';

const vault = process.env.JSN_BW_VAULT;
const args = process.argv.slice(2);
const at = args.indexOf('--session');
const session = at === -1 ? null : args[at + 1];
// Without `--session`, index -1 and 0 would otherwise drop the subcommand.
const argv = at === -1 ? args : args.filter((_, index) => index !== at && index !== at + 1);
const read = () => JSON.parse(fs.readFileSync(vault, 'utf8'));
const write = (doc) => fs.writeFileSync(vault, JSON.stringify(doc));
const fail = (message) => { process.stderr.write(`${message}\n`); process.exit(1); };
const decode = (value) => JSON.parse(Buffer.from(value, 'base64').toString('utf8'));

// `bw status` answers without a session, like the real CLI.
if (!session && argv[0] !== 'status') fail('Vault is locked.');

switch (argv[0]) {
  case 'status':
    process.stdout.write(JSON.stringify({ status: 'unlocked', serverUrl: 'https://vault.example' }));
    break;
  case 'encode':
    process.stdout.write(Buffer.from(fs.readFileSync(0, 'utf8'), 'utf8').toString('base64'));
    break;
  case 'get': {
    const item = read().items.find(entry => entry.name === argv[2]);
    if (!item) fail('Not found.');
    process.stdout.write(JSON.stringify(item));
    break;
  }
  case 'create': {
    const doc = decode(argv[2]);
    const next = read();
    next.items.push({ ...doc, id: `item-${next.items.length + 1}` });
    write(next);
    process.stdout.write('{}');
    break;
  }
  case 'edit': {
    const doc = decode(argv[3]);
    const next = read();
    next.items = next.items.map(entry => (entry.id === argv[2] ? doc : entry));
    write(next);
    process.stdout.write('{}');
    break;
  }
  case 'delete': {
    const next = read();
    next.items = next.items.filter(entry => entry.id !== argv[2]);
    write(next);
    process.stdout.write('{}');
    break;
  }
  default:
    fail(`Unsupported: ${argv.join(' ')}`);
}
