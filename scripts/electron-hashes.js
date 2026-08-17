#!/usr/bin/env node
/**
 * Produce (or check) the SHA256 manifest of the compiled Electron main process.
 *
 * WHY THIS EXISTS
 * ===============
 * The launcher is closed source, but the half of it that touches the user's
 * machine -- filesystem, registry, process spawn, Steam, mods, auto-update -- is
 * published at the public core repository. A published source tree only means
 * something if a user can tell that the binary they installed was built from it.
 *
 * Two properties make that checkable here, and both are load-bearing:
 *
 *   1. The Electron main process is compiled by a plain `tsc -p
 *      tsconfig.electron.json`. No bundler, no minifier. dist-electron/**\/*.js is
 *      readable JavaScript that corresponds line-for-line to the published TypeScript.
 *   2. That compilation is byte-deterministic for a given TypeScript version and
 *      tsconfig, so the same source always yields the same hashes.
 *
 * So the manifest this script writes is a fingerprint of the shipped main process
 * that anyone can recompute -- from the public source, or from the app.asar inside
 * their own installation.
 *
 * The chain it supports:
 *
 *   build     `--dir dist-electron` writes ELECTRON-HASHES.txt
 *   package   `--asar release/.../app.asar --check ELECTRON-HASHES.txt` proves the
 *             packaged app carries exactly the code that was compiled
 *   mirror    the same ELECTRON-HASHES.txt is committed to the public repo
 *   public CI recompiles the mirrored source and re-checks it, in public
 *   user      `--asar <installed app.asar> --check <published manifest>`
 *
 * Only .js is hashed. Source maps are deliberately excluded: electron-builder drops
 * them from the package ("!**\/*.map"), and they embed absolute build paths, which
 * would make the manifest machine-specific and break the whole point.
 *
 * Usage:
 *   node scripts/electron-hashes.js --dir <dir> [--out <file>]
 *   node scripts/electron-hashes.js --asar <app.asar> [--out <file>]
 *   node scripts/electron-hashes.js --dir <dir> --check <manifest>
 *
 * Exit codes: 0 ok, 1 mismatch or bad usage.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/** Files inside an extracted package that make up the compiled main process. */
const ROOT_IN_ASAR = 'dist-electron';

function usage(message) {
  if (message) console.error(`electron-hashes: ${message}`);
  console.error(`
Usage:
  node scripts/electron-hashes.js --dir <dir> [--out <file>] [--check <manifest>]
  node scripts/electron-hashes.js --asar <app.asar> [--out <file>] [--check <manifest>]
`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith('--')) usage(`unexpected argument ${JSON.stringify(key)}`);
    if (value === undefined) usage(`${key} needs a value`);
    opts[key.slice(2)] = value;
  }
  return opts;
}

function walkJs(root) {
  const found = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) found.push(full);
    }
  })(root);
  return found;
}

/**
 * Sort by the POSIX-normalised relative path so a manifest written on Windows and
 * one written on Linux are byte-identical. Without this the gate would compare a
 * Windows-built manifest against a Linux-built one and fail on separators alone.
 */
function manifestFor(root) {
  return walkJs(root)
    .map((file) => ({
      rel: path.relative(root, file).split(path.sep).join('/'),
      sha: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map(({ sha, rel }) => `${sha}  ${rel}`)
    .join('\n') + '\n';
}

/**
 * Extract app.asar to a temp directory and return the dist-electron root inside it.
 * Uses the @electron/asar CLI from node_modules -- the same tool a user runs as
 * `npx @electron/asar extract`, so the documented user-facing check and this gate
 * cannot drift apart.
 */
function extractAsar(asarPath) {
  if (!fs.existsSync(asarPath)) usage(`no such archive: ${asarPath}`);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-hashes-'));

  const cli = require.resolve('@electron/asar/bin/asar.js', {
    paths: [path.join(__dirname, '..')],
  });
  execFileSync(process.execPath, [cli, 'extract', asarPath, out], { stdio: 'inherit' });

  const root = path.join(out, ROOT_IN_ASAR);
  if (!fs.existsSync(root)) {
    console.error(`electron-hashes: ${ROOT_IN_ASAR}/ not found inside ${asarPath}`);
    console.error(`extracted top level: ${fs.readdirSync(out).join(', ')}`);
    process.exit(1);
  }
  return root;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.dir && !opts.asar) usage('one of --dir or --asar is required');
  if (opts.dir && opts.asar) usage('--dir and --asar are mutually exclusive');

  const root = opts.asar ? extractAsar(opts.asar) : opts.dir;
  if (!fs.existsSync(root)) usage(`no such directory: ${root}`);

  const manifest = manifestFor(root);
  const count = manifest.trimEnd().split('\n').length;
  if (!manifest.trim()) {
    console.error(`electron-hashes: no .js files under ${root}`);
    process.exit(1);
  }

  if (opts.check) {
    const expected = fs.readFileSync(opts.check, 'utf8');
    if (manifest === expected) {
      console.log(`✅ ${count} compiled main-process files match ${opts.check}`);
      return;
    }

    // Report what actually differs. "the hashes differ" is useless when the answer
    // is usually one added file or one stale build.
    const parse = (text) =>
      new Map(
        text
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [sha, ...rest] = line.split(/\s+/);
            return [rest.join(' '), sha];
          })
      );
    const actualMap = parse(manifest);
    const expectedMap = parse(expected);

    console.error(`❌ compiled main process does not match ${opts.check}`);
    for (const [rel, sha] of actualMap) {
      if (!expectedMap.has(rel)) console.error(`  + ${rel} (present in build, absent from manifest)`);
      else if (expectedMap.get(rel) !== sha) console.error(`  ~ ${rel} (${expectedMap.get(rel).slice(0, 12)} -> ${sha.slice(0, 12)})`);
    }
    for (const rel of expectedMap.keys()) {
      if (!actualMap.has(rel)) console.error(`  - ${rel} (in manifest, missing from build)`);
    }
    process.exit(1);
  }

  if (opts.out) {
    fs.writeFileSync(opts.out, manifest);
    console.log(`📋 wrote ${count} entries to ${opts.out}`);
  } else {
    process.stdout.write(manifest);
  }
}

main();
