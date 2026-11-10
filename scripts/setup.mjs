#!/usr/bin/env node
// Idempotent installation + environment check for the ScoutBox monorepo.
// Run once after cloning (and after pulling dependency changes):
//   npm run setup            (from the repository root)
// Routine startup does NOT install anything — that's `npm run dev`.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT, runtimeSupport } from '../scoutbox-server/runtime.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// '.' is the repository root: Biome and the lefthook pre-commit hook, which its `prepare` script installs.
const APPS = ['.', 'scoutbox-server', 'scoutbox-player', 'scoutbox-club', 'scoutbox-admin', 'e2e'];
// scoutbox-grassroots/node_modules and scoutbox-agent/node_modules are symlinks to scoutbox-club's — no install.

let failed = false;
const fail = (m) => { console.error(`✗ ${m}`); failed = true; };
const okay = (m) => console.log(`✓ ${m}`);

// Node version: the server's own runtime contract (scoutbox-server/runtime.mjs),
// so this check can never drift from what the server accepts at boot.
const runtime = runtimeSupport();
if (runtime.ok) okay(`node ${process.versions.node} (${CONTRACT})`);
else fail(`${runtime.reason} Install a supported Node.js (https://nodejs.org).`);

for (const rel of APPS) {
  const app = rel === '.' ? 'repo tools (formatter, git hooks)' : rel;
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(path.join(dir, 'package-lock.json'))) { fail(`${app}/package-lock.json missing — clone incomplete?`); continue; }
  const marker = path.join(dir, 'node_modules', '.package-lock.json');
  const lock = path.join(dir, 'package-lock.json');
  const fresh = fs.existsSync(marker) && fs.statSync(marker).mtimeMs >= fs.statSync(lock).mtimeMs;
  if (fresh) { okay(`${app}: dependencies up to date`); continue; }
  console.log(`… ${app}: npm ci (matches the lockfile)`);
  try {
    execSync('npm ci', { cwd: dir, stdio: 'inherit' });
    okay(`${app}: installed`);
  } catch {
    fail(`${app}: npm ci failed — see output above`);
  }
}

// The two Vite apps that share scoutbox-club's dependency set (identical
// lockfiles): Grassroots and Agent.
for (const shared of ['scoutbox-grassroots', 'scoutbox-agent']) {
  const link = path.join(ROOT, shared, 'node_modules');
  if (!fs.existsSync(link)) {
    try {
      fs.symlinkSync(path.join('..', 'scoutbox-club', 'node_modules'), link, 'junction');
      okay(`${shared}: node_modules symlink restored`);
    } catch (e) {
      fail(`${shared}: could not restore node_modules symlink (${e.message})`);
    }
  } else {
    okay(`${shared}: node_modules symlink present`);
  }
}

if (failed) { console.error('\nSetup incomplete — fix the ✗ items above.'); process.exit(1); }
console.log('\nSetup complete. Start everything with:  npm run dev');
