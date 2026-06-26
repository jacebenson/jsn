#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const type = process.argv[2];
if (!type || !['patch', 'minor', 'major'].includes(type)) {
  console.error('Usage: npm run release -- <patch|minor|major>');
  process.exit(1);
}

let branch;
try {
  branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
} catch {
  console.error('Error: Not in a git repository');
  process.exit(1);
}

if (branch !== 'nodejs') {
  console.error(`Error: Releases can only be made from 'nodejs' branch (currently on '${branch}')`);
  process.exit(1);
}

const prefix = 'v';

console.log('');
console.log(`🚀 Releasing from '${branch}'`);
console.log(`   Bump: ${type}`);
console.log('');

// Run tests
console.log('⏳ Running tests...');
try {
  execSync('npm test', { stdio: 'inherit' });
} catch {
  console.error('');
  console.error('❌ Tests failed. Release aborted.');
  process.exit(1);
}

// Bump version with correct tag prefix
console.log('');
console.log(`⏳ Bumping version (${type})...`);
execSync(`npm version ${type} --tag-version-prefix=${prefix}`, { stdio: 'inherit' });

// Push commits and tags
console.log('');
console.log('⏳ Pushing to origin...');
execSync('git push && git push --tags', { stdio: 'inherit' });

// Show final state
const newPkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
console.log('');
console.log('✅ Release complete!');
console.log(`   Version: ${newPkg.version}`);
console.log(`   Tag:     ${prefix}${newPkg.version}`);
console.log('');
