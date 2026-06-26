#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

let branch;
try {
  branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
} catch {
  branch = 'unknown';
}

const version = pkg.version;
const prefix = 'v';

console.log('');
console.log('📦 Release Reminder');
console.log('');
console.log(`   Current version: ${version}`);
console.log(`   Current branch:  ${branch}`);
console.log('');
console.log('   To create a release tag, run:');
console.log('');
console.log(`     git tag ${prefix}${version}`);
console.log('     git push origin --tags');
console.log('');
