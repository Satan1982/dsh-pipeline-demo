import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const info = {
  name: pkg.name,
  version: pkg.version,
  node: process.version,
  builtAt: new Date().toISOString(),
};
writeFileSync('dist/build-info.json', `${JSON.stringify(info, null, 2)}\n`);
console.log(`built ${pkg.name}@${pkg.version}`);
