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
// '.' is the repository root: Biome and the lefthook pre-commit hook, which its `prepare` script installs.
const APPS = ['.', 'scoutbox-player', 'scoutbox-club', 'scoutbox-admin', 'e2e'];
// scoutbox-grassroots/node_modules and scoutbox-agent/node_modules are symlinks to scoutbox-club's — no install.

let failed = false;
const fail = (m) => {
  console.error(`✗ ${m}`);
  failed = true;
};
const okay = (m) => console.log(`✓ ${m}`);

// Node runs the apps' tooling and the server's scripts: the version scoutbox-server/package.json asks for.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 18)) okay(`node ${process.versions.node}`);
else fail(`node ${process.versions.node} is too old: install Node.js 22.18 or later (https://nodejs.org).`);

// The server: Gleam on Erlang/OTP, and the patched SQLite driver it is built against.
const version = (cmd) => {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
};
const gleam = version('gleam --version');
const otp = version(`erl -noshell -eval 'io:format("~s", [erlang:system_info(otp_release)]), halt().'`);
if (gleam) okay(gleam);
else fail('gleam not found: install Gleam (https://gleam.run/getting-started/installing/).');
if (otp) okay(`Erlang/OTP ${otp}`);
else fail('erl not found: install Erlang/OTP, which Gleam runs on.');
if (gleam && otp) {
  try {
    execSync('npm run --silent esqlite', { cwd: path.join(ROOT, 'scoutbox-server'), stdio: 'inherit' });
    okay('scoutbox-server: patched esqlite built');
  } catch {
    fail('scoutbox-server: npm run esqlite failed — see output above');
  }
}

for (const rel of APPS) {
  const app = rel === '.' ? 'repo tools (formatter, git hooks)' : rel;
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(path.join(dir, 'package-lock.json'))) {
    fail(`${app}/package-lock.json missing — clone incomplete?`);
    continue;
  }
  const marker = path.join(dir, 'node_modules', '.package-lock.json');
  const lock = path.join(dir, 'package-lock.json');
  const fresh = fs.existsSync(marker) && fs.statSync(marker).mtimeMs >= fs.statSync(lock).mtimeMs;
  if (fresh) {
    okay(`${app}: dependencies up to date`);
    continue;
  }
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

if (failed) {
  console.error('\nSetup incomplete — fix the ✗ items above.');
  process.exit(1);
}
console.log('\nSetup complete. Start everything with:  npm run dev');
