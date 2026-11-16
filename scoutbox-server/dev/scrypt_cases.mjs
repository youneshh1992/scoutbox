// Writes test/fixtures/scrypt_cases.json: passwords and salts with the key Node's crypto.scryptSync derives for them,
// and stored hashes made by the TypeScript server's own hashPassword (adapters.mjs). The Gleam test derives every
// key and verifies every stored hash. Regenerate with `node dev/scrypt_cases.mjs`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { hashPassword } = await import(path.join(HERE, '../../../scoutbox/scoutbox-server/adapters.mjs'));

// A seeded generator, so the fixture is reproducible.
let seed = 20261116;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = (xs) => xs[Math.floor(random() * xs.length)];
const bytes = (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(random() * 256)));
const text = (n) => Array.from({ length: n }, () => pick(['a', 'Z', '7', ' ', '$', 'é', 'ß', '漢', '😀'])).join('');

const hex = (b) => Buffer.from(b).toString('hex');
const derived = [];
const add = (why, password, salt, n, r, p, length) =>
  derived.push({
    why,
    password: hex(password),
    salt: hex(salt),
    n,
    r,
    p,
    length,
    key: hex(crypto.scryptSync(password, salt, length, { N: n, r, p, maxmem: 256 * 1024 * 1024 })),
  });

// RFC 7914 section 12, apart from the last (N = 2^20, a gigabyte).
add('RFC 7914: empty', Buffer.alloc(0), Buffer.alloc(0), 16, 1, 1, 64);
add('RFC 7914: password/NaCl', Buffer.from('password'), Buffer.from('NaCl'), 1024, 8, 16, 64);
add('RFC 7914: pleaseletmein/SodiumChloride', Buffer.from('pleaseletmein'), Buffer.from('SodiumChloride'), 16384, 8, 1, 64);

// Small parameters, many shapes: lengths that aren't whole hash blocks, several parallel blocks, odd r.
for (let i = 0; i < 40; i++)
  add('small parameters', bytes(Math.floor(random() * 40)), bytes(Math.floor(random() * 40)), pick([2, 4, 16, 64]), pick([1, 2, 3, 8]), pick([1, 2, 3]), pick([1, 31, 32, 33, 64, 100]));

// What the server does: Node's defaults, a text password, the salt's hex text as the salt, 32 bytes.
for (let i = 0; i < 4; i++) {
  const password = Buffer.from(text(1 + Math.floor(random() * 30)));
  add('the server: defaults', password, Buffer.from(hex(bytes(16))), 16384, 8, 1, 32);
}

// Stored hashes from hashPassword itself, which salts randomly: verifying them is the contract.
const stored = ['club-secret-1', 'northstar-secret-1', 'é漢😀 with spaces', ''].map((password) => ({
  password: hex(Buffer.from(password)),
  stored: hashPassword(password),
}));

const out = path.join(HERE, '../test/fixtures/scrypt_cases.json');
fs.writeFileSync(out, `${JSON.stringify({ derived, stored }, null, 1)}\n`);
console.log(`${derived.length} derived keys and ${stored.length} stored hashes → ${path.relative(process.cwd(), out)}`);
