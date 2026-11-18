// A password in the stored form a server under test accepts (`scrypt$<salt>$<hash>`: scrypt with N = 16384, r = 8,
// p = 1 and a 32-byte key, over the salt's hex text), for fixtures that plant a password-protected account. It is
// written here rather than imported: scripts/testE2ESupport.mjs proves the server verifies it.
import crypto from 'node:crypto';

/** `password`'s stored form, with a fresh random salt. */
export function storedPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
