#!/usr/bin/env node
/**
 * Stamp the target environment into src/electron/config/build-env.ts before tsc runs.
 *
 * This is the Electron main process's equivalent of Angular's `fileReplacements`,
 * which do not apply to `tsc -p tsconfig.electron.json`. See the header of
 * src/electron/config/build-env.ts for what went wrong without it.
 *
 * Usage: node scripts/set-build-env.js <production|staging>
 *
 * The file is rewritten in place and stays committed, so a plain `tsc` or an editor
 * type-check always has something valid to resolve. That also means a local staging
 * build leaves the working tree dirty -- intentionally visible rather than hidden in
 * a gitignored generated file.
 */
const fs = require('fs');
const path = require('path');

const VALID = ['production', 'staging'];
const target = process.argv[2];

if (!VALID.includes(target)) {
  console.error(`set-build-env: expected one of ${VALID.join(', ')}, got ${JSON.stringify(target)}`);
  process.exit(1);
}

const file = path.join(__dirname, '..', 'src', 'electron', 'config', 'build-env.ts');
const source = fs.readFileSync(file, 'utf8');

// Anchored on the exact declaration so a comment mentioning 'staging' cannot be hit.
const DECLARATION = /^(export const BUILD_ENV: BuildEnvironment = )'(?:production|staging)';$/m;

if (!DECLARATION.test(source)) {
  console.error(`set-build-env: could not find the BUILD_ENV declaration in ${file}`);
  process.exit(1);
}

const updated = source.replace(DECLARATION, `$1'${target}';`);
fs.writeFileSync(file, updated);

console.log(`set-build-env: BUILD_ENV = '${target}'`);
