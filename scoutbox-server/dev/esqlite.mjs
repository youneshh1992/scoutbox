// Builds `vendor/esqlite`: esqlite (the NIF under sqlight) from its pinned Hex tarball, with `vendor/esqlite.patch`
// applied and its NIF compiled. `gleam.toml` takes it as a path dependency, which replaces the Hex copy for sqlight
// too. Run it once after cloning, and again after changing the patch or the pin; `npm run e2e` runs it first. It
// does nothing when the build is already current.
//   node dev/esqlite.mjs
//
// Why: stock esqlite runs `step` on a dirty I/O scheduler, and its fetchall calls `step` once per row, so every
// row pays two scheduler switches and every reader contends for the dirty schedulers' one run queue. The patch adds
// `fetchmany` (a batch of rows in one call, on a normal scheduler, within a time budget) and `fetchmany_dirty` (the
// same on a dirty one, for slow steps); `platform/store` chooses between them per batch. Measurements and reasoning: the TypeScript
// tree's `.claude/plans/gleam-migration-evaluation.md`, "Read speed, and the decision".
//
// esqlite's source isn't committed (its SQLite amalgamation alone is 9 MB): an upgrade is a new pin and checksum
// (from `manifest.toml` of a project that depends on the Hex package) and the patch reapplied.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = '0.10.1';
const SHA256 = '578c49543b81d1fb91f62adf7459ec2924abf86c98a1b0c9900f89674b664959'; // the Hex outer checksum

// esqlite's own flags (its rebar.config.script), so the SQLite inside is the one the Hex package builds.
const SQLITE_FLAGS = [
  '-Os',
  '-DSQLITE_DQS=0',
  '-DSQLITE_THREADSAFE=1',
  '-DSQLITE_DEFAULT_MEMSTATUS=0',
  '-DSQLITE_DEFAULT_WAL_SYNCHRONOUS=1',
  '-DSQLITE_LIKE_DOESNT_MATCH_BLOBS',
  '-DSQLITE_MAX_EXPR_DEPTH=0',
  '-DSQLITE_OMIT_DEPRECATED',
  '-DSQLITE_OMIT_PROGRESS_CALLBACK',
  '-DSQLITE_USE_ALLOCA',
  '-DSQLITE_OMIT_AUTOINIT',
  '-DSQLITE_USE_URI',
  '-DSQLITE_ENABLE_FTS3',
  '-DSQLITE_ENABLE_FTS3_PARENTHESIS',
  '-DSQLITE_ENABLE_FTS4',
  '-DSQLITE_ENABLE_FTS5',
  '-DSQLITE_ENABLE_MATH_FUNCTIONS',
  '-DSQLITE_ENABLE_JSON1',
  '-DSQLITE_ENABLE_RTREE',
  '-DSQLITE_ENABLE_GEOPOLY',
];
const LINK_FLAGS =
  os.platform() === 'darwin' ? ['-dynamiclib', '-undefined', 'dynamic_lookup'] : ['-shared', '-std=c11', '-lm'];

const HERE = path.dirname(new URL(import.meta.url).pathname);
const VENDOR = path.resolve(HERE, '../vendor');
const OUT = path.join(VENDOR, 'esqlite');
const PATCH = path.join(VENDOR, 'esqlite.patch');
const TARBALL = path.join(VENDOR, `esqlite-${VERSION}.tar`);
const STAMP = path.join(OUT, '.built');
const NIF = path.join(OUT, 'priv', 'esqlite3_nif.so');

const stamp = crypto
  .createHash('sha256')
  .update(
    [VERSION, fs.readFileSync(PATCH, 'utf8'), ...SQLITE_FLAGS, ...LINK_FLAGS, os.platform(), os.arch()].join('\n'),
  )
  .digest('hex');
if (fs.existsSync(NIF) && fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8') === stamp) process.exit(0);

const run = (cmd, args, cwd = OUT) =>
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

if (!fs.existsSync(TARBALL) || sha256(TARBALL) !== SHA256) {
  const res = await fetch(`https://repo.hex.pm/tarballs/esqlite-${VERSION}.tar`);
  if (!res.ok) throw new Error(`esqlite: Hex answered ${res.status}`);
  fs.writeFileSync(TARBALL, Buffer.from(await res.arrayBuffer()));
}
if (sha256(TARBALL) !== SHA256) throw new Error(`esqlite: ${TARBALL} does not match the pinned checksum`);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'priv'), { recursive: true });
const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'esqlite-'));
try {
  run('tar', ['-xf', TARBALL, '-C', unpacked], VENDOR);
  run('tar', ['-xzf', path.join(unpacked, 'contents.tar.gz'), '-C', OUT], VENDOR);
} finally {
  fs.rmSync(unpacked, { recursive: true, force: true });
}
run('patch', ['-p1', '--forward', '--input', PATCH]);

// Gleam takes only Gleam projects as path dependencies. This one has Erlang modules in src/ (Gleam compiles them)
// and the NIF in priv/ (Gleam copies it); the name keeps sqlight's requirement on `esqlite` satisfied.
fs.writeFileSync(
  path.join(OUT, 'gleam.toml'),
  `# Written by dev/esqlite.mjs: esqlite ${VERSION} from Hex with vendor/esqlite.patch applied.\n` +
    `name = "esqlite"\nversion = "${VERSION}"\ntarget = "erlang"\n`,
);

const erts = run('erl', [
  '-noshell',
  '-eval',
  'io:format("~s", [filename:join([code:root_dir(), "erts-" ++ erlang:system_info(version), "include"])]), halt().',
]);
run('cc', [
  ...LINK_FLAGS,
  '-fPIC',
  `-I${erts}`,
  '-Ic_src/sqlite3',
  ...SQLITE_FLAGS,
  '-o',
  NIF,
  'c_src/esqlite3_nif.c',
  'c_src/sqlite3/sqlite3.c',
]);
// Gleam doesn't copy a dependency's priv/ again over an earlier build of it, so a stale NIF (the Hex copy's, or
// one from an older patch) would load and leave the new functions unloaded.
for (const mode of ['dev', 'prod', 'lsp']) {
  fs.rmSync(path.resolve(HERE, '../build', mode, 'erlang/esqlite'), { recursive: true, force: true });
}
fs.writeFileSync(STAMP, stamp);
console.log(`esqlite ${VERSION}: patched and built in vendor/esqlite`);
