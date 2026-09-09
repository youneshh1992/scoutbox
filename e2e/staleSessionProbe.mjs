// Probe: player demo must never crash on a stale persisted session.
// Serves e2e/dist over http (expo-router demo needs http, not file://).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = 8137;
const html = readFileSync(new URL('./dist/scoutbox-player-demo.html', import.meta.url));
const srv = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(PORT);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
};

async function loadWith(session) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  if (session !== undefined) {
    await ctx.addInitScript((s) => {
      try { localStorage.setItem('scoutbox-player-session', s); } catch {}
    }, session);
  }
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForTimeout(1500);
  const body = await page.innerText('body');
  return { ctx, page, body, errors };
}

// 1. Fresh load — no stored state.
{
  const { ctx, body, errors } = await loadWith(undefined);
  check('fresh load shows onboarding', /or continue as a demo account/i.test(body));
  check('fresh load has no "No such player"', !body.includes('No such player'));
  check('fresh load no page errors', errors.length === 0);
  await ctx.close();
}

// 2. Stale UNVERSIONED session (what an M13 build left behind).
{
  const { ctx, body, errors } = await loadWith(JSON.stringify({ kind: 'player', id: 'demo-999' }));
  check('unversioned stale session falls back to onboarding', /or continue as a demo account/i.test(body));
  check('unversioned stale session has no "No such player"', !body.includes('No such player'));
  check('unversioned stale session no page errors', errors.length === 0);
  await ctx.close();
}

// 3. Stale but VERSIONED session — exercises the boot resolution path.
{
  const { ctx, body, errors } = await loadWith(JSON.stringify({ v: 2, kind: 'player', id: 'demo-999' }));
  check('versioned stale id falls back to onboarding', /or continue as a demo account/i.test(body));
  check('versioned stale id has no "No such player"', !body.includes('No such player'));
  check('versioned stale id no page errors', errors.length === 0);
  await ctx.close();
}

// 3b. Stale guardian id — same guarantee on the guardian path.
{
  const { ctx, body, errors } = await loadWith(JSON.stringify({ v: 2, kind: 'guardian', id: 'gu-gone' }));
  check('stale guardian id falls back to onboarding', /or continue as a demo account/i.test(body));
  check('stale guardian id no page errors', errors.length === 0);
  await ctx.close();
}

// 4. Regression: a valid session still persists across reload.
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.getByText('Kola Adeyemi').waitFor();
  await page.getByText('Enter', { exact: true }).first().click();
  await page.waitForTimeout(1200);
  const loggedIn = /weekly scout report/i.test(await page.innerText('body'));
  check('demo login works', loggedIn);
  await page.reload();
  await page.waitForTimeout(1500);
  const after = await page.innerText('body');
  check('valid session survives reload', /weekly scout report/i.test(after) && !/or continue as a demo account/i.test(after));
  check('reload no page errors', errors.length === 0);
  await ctx.close();
}

await browser.close();
srv.close();
console.log(failures === 0 ? 'STALE SESSION PROBE OK' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
