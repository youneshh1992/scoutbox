#!/usr/bin/env node
// One-command local startup for the connected ScoutBox system:
//   npm run dev          → backend + Player + Pro + Grassroots
//   npm run dev:all      → also the Trust & Safety console
// Run from the repository root ON THE MACHINE WHOSE BROWSER YOU WILL USE —
// every URL below is local to the machine that runs this script.
//
// The launcher validates prerequisites, refuses to double-start, starts the
// backend first, waits for CONTENT-verified readiness (not just an open
// port), prints the URL sheet, and stops only its own children on Ctrl-C.
// It never touches scoutbox-server/data beyond what the server itself does.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WITH_ADMIN = process.argv.includes('--with-admin');
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000';

const APPS = [
  { name: 'backend', dir: 'scoutbox-server', port: 4000, cmd: 'node', args: ['server.mjs'], url: 'http://localhost:4000', label: 'API — /health to check', ready: async () => {
    const res = await fetch('http://localhost:4000/health');
    const h = await res.json();
    if (!h.ok || !h.engine) throw new Error('health incomplete');
    return `engine: ${h.engine} · dev logins: ${h.devLogins ? 'ON (local development only)' : 'off'}`;
  } },
  { name: 'player', dir: 'scoutbox-player', port: 8081, cmd: 'npx', args: ['expo', 'start', '--web', '--port', '8081'], env: { EXPO_PUBLIC_API_URL: API_URL, BROWSER: 'none' }, url: 'http://localhost:8081', label: 'ScoutBox Player (web)', marker: 'root' },
  { name: 'pro', dir: 'scoutbox-club', port: 5173, cmd: 'npx', args: ['vite', '--port', '5173', '--strictPort'], url: 'http://localhost:5173', label: 'ScoutBox Pro', marker: 'ScoutBox Pro' },
  { name: 'grassroots', dir: 'scoutbox-grassroots', port: 5175, cmd: 'npx', args: ['vite', '--port', '5175', '--strictPort'], url: 'http://localhost:5175', label: 'ScoutBox Grassroots', marker: 'ScoutBox Grassroots' },
  ...(WITH_ADMIN ? [{ name: 'admin', dir: 'scoutbox-admin', port: 5174, cmd: 'npx', args: ['vite', '--port', '5174', '--strictPort'], url: 'http://localhost:5174', label: 'Trust & Safety console', marker: 'ScoutBox' }] : []),
];

// ---------- prerequisites: deps installed, ports free
let bad = false;
for (const app of APPS) {
  if (app.name !== 'grassroots' && !fs.existsSync(path.join(ROOT, app.dir, 'node_modules'))) {
    console.error(`✗ ${app.dir}/node_modules missing — run \`npm run setup\` first (installs from the lockfiles).`);
    bad = true;
  }
}
if (bad) process.exit(1);

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}
const busy = [];
for (const app of APPS) if (!(await portFree(app.port))) busy.push(app);
if (busy.length > 0) {
  console.error('✗ Ports already in use — a ScoutBox stack (or something else) may already be running.');
  console.error('  This launcher never kills processes it did not start. Inspect the owners first:');
  for (const app of busy) console.error(`   :${app.port}  (${app.name})  →  lsof -i :${app.port}`);
  process.exit(1);
}

// ---------- start children (backend first)
const children = [];
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => process.exit(code), 800);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function start(app) {
  const child = spawn(app.cmd, app.args, {
    cwd: path.join(ROOT, app.dir),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(app.env ?? {}) },
  });
  const tag = `[${app.name}]`.padEnd(13);
  const fwd = (stream, out) => stream.on('data', (d) => out.write(String(d).split('\n').filter(Boolean).map((l) => `${tag}${l}`).join('\n') + '\n'));
  fwd(child.stdout, process.stdout);
  fwd(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`${tag}exited (${code}) — a required process died, stopping the stack`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

// Readiness = the app's actual content answers, not merely an open socket.
async function waitReady(app, timeoutMs) {
  const started = Date.now();
  for (;;) {
    if (shuttingDown) throw new Error('shutting down');
    try {
      if (app.ready) return await app.ready();
      const res = await fetch(app.url);
      const text = await res.text();
      if (res.ok && text.includes(app.marker)) return null;
      throw new Error(`unexpected response (${res.status})`);
    } catch (e) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`${app.name} not ready after ${Math.round(timeoutMs / 1000)}s — see the ${`[${app.name}]`} log lines above (${e.message})`);
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  }
}

try {
  start(APPS[0]); // backend first — everything else talks to it
  const backendInfo = await waitReady(APPS[0], 30_000);
  for (const app of APPS.slice(1)) start(app);
  const notes = [backendInfo];
  for (const app of APPS.slice(1)) notes.push(await waitReady(app, app.name === 'player' ? 120_000 : 60_000));

  console.log('\n──────────────────────────────────────────────────────────');
  console.log('ScoutBox is up — one backend, one database, connected mode.');
  console.log('These URLs are LOCAL TO THIS MACHINE (open them in a browser');
  console.log('on the same machine, or substitute this machine\'s LAN IP):');
  for (const app of APPS) console.log(`  • ${app.url}  (${app.label})`);
  if (notes[0]) console.log(`  ${notes[0]}`);
  console.log('  Phone on the same Wi-Fi: EXPO_PUBLIC_API_URL=http://<this-machine-LAN-IP>:4000 (see README)');
  if (fs.existsSync('/root/.ccr')) {
    console.log('\n  ⚠ This looks like a Claude cloud container: these URLs are NOT');
    console.log('    reachable from your own browser. Run this script on your computer.');
  }
  console.log('──────────────────────────────────────────────────────────\n');
} catch (e) {
  console.error(`✗ startup failed: ${e.message}`);
  shutdown(1);
}
