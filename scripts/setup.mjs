#!/usr/bin/env node
// Idempotent installation + environment check for the ScoutBox monorepo.
// Run once after cloning (and after pulling dependency changes):
//   npm run setup            (from the repository root)
// Routine startup does NOT install anything — that's `npm run dev`.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPS = ['scoutbox-server', 'scoutbox-player', 'scoutbox-club', 'scoutbox-admin', 'e2e'];
// scoutbox-grassroots/node_modules and scoutbox-agent/node_modules are symlinks to scoutbox-club's — no install.

let failed = false;
const fail = (m) => { console.error(`✗ ${m}`); failed = true; };
const okay = (m) => console.log(`✓ ${m}`);

// Node version: node:sqlite needs >= 22.5 (older Node falls back to a JSON
// snapshot store — works, but say so honestly).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 5)) okay(`node ${process.versions.node} (SQLite persistence available)`);
else if (major >= 20) console.warn(`⚠ node ${process.versions.node}: works, but < 22.5 uses the JSON fallback store instead of SQLite`);
else fail(`node ${process.versions.node} is too old — install Node 22+ (https://nodejs.org)`);

for (const app of APPS) {
  const dir = path.join(ROOT, app);
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
// lockfiles): Grassroots since M8, Agent since M23 P5.6B.
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
