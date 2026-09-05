#!/usr/bin/env node
// One-command local startup for the connected ScoutBox system:
//   node scripts/dev-all.mjs            → backend + Player + Pro + Grassroots
//   node scripts/dev-all.mjs --with-admin  → also the Trust & Safety console
//
// Uses each app's own dev server on its conventional port, detects port
// conflicts up front, and prints the real local URLs once everything is up.
// Ctrl-C stops the whole stack.

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WITH_ADMIN = process.argv.includes('--with-admin');
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000';

const APPS = [
  { name: 'backend', dir: 'scoutbox-server', port: 4000, cmd: 'node', args: ['server.mjs'], url: 'http://localhost:4000  (API — /health to check)' },
  { name: 'player', dir: 'scoutbox-player', port: 8081, cmd: 'npx', args: ['expo', 'start', '--web', '--port', '8081'], env: { EXPO_PUBLIC_API_URL: API_URL, BROWSER: 'none' }, url: 'http://localhost:8081  (ScoutBox Player — web)' },
  { name: 'pro', dir: 'scoutbox-club', port: 5173, cmd: 'npx', args: ['vite', '--port', '5173', '--strictPort'], url: 'http://localhost:5173  (ScoutBox Pro)' },
  { name: 'grassroots', dir: 'scoutbox-grassroots', port: 5175, cmd: 'npx', args: ['vite', '--port', '5175', '--strictPort'], url: 'http://localhost:5175  (ScoutBox Grassroots)' },
  ...(WITH_ADMIN ? [{ name: 'admin', dir: 'scoutbox-admin', port: 5174, cmd: 'npx', args: ['vite', '--port', '5174', '--strictPort'], url: 'http://localhost:5174  (Trust & Safety console — key: scoutbox-admin)' }] : []),
];

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

const busy = [];
for (const app of APPS) {
  if (!(await portFree(app.port))) busy.push(app);
}
if (busy.length > 0) {
  console.error('✗ Ports already in use — stop what holds them (or it may already be running):');
  for (const app of busy) console.error(`   :${app.port}  (${app.name})  — try: lsof -i :${app.port}`);
  process.exit(1);
}

const children = [];
for (const app of APPS) {
  const child = spawn(app.cmd, app.args, {
    cwd: path.join(ROOT, app.dir),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(app.env ?? {}) },
  });
  const tag = `[${app.name}]`.padEnd(13);
  child.stdout.on('data', (d) => process.stdout.write(String(d).split('\n').filter(Boolean).map((l) => `${tag}${l}`).join('\n') + '\n'));
  child.stderr.on('data', (d) => process.stderr.write(String(d).split('\n').filter(Boolean).map((l) => `${tag}${l}`).join('\n') + '\n'));
  child.on('exit', (code) => {
    console.error(`${tag}exited (${code}) — stopping the stack`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => process.exit(code), 800);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Print the URL sheet once the backend answers.
const started = Date.now();
const poll = setInterval(async () => {
  try {
    const res = await fetch('http://localhost:4000/health');
    if (res.ok) {
      clearInterval(poll);
      const health = await res.json();
      console.log('\n──────────────────────────────────────────────────────────');
      console.log('ScoutBox is up (connected mode — one backend, one database):');
      for (const app of APPS) console.log(`  • ${app.url}`);
      console.log(`  engine: ${health.engine} · dev logins: ${health.devLogins ? 'ON (local only)' : 'off'}`);
      console.log('  Phone on the same Wi-Fi: EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:4000 (see README)');
      console.log('──────────────────────────────────────────────────────────\n');
    }
  } catch {
    if (Date.now() - started > 60_000) {
      clearInterval(poll);
      console.error('backend did not come up within 60s — check the [backend] log lines above');
    }
  }
}, 700);
