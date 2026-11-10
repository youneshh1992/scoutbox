// TOTP (RFC 6238 over HOTP, RFC 4226: SHA-1, 6 digits, 30 s step) for staff MFA, and a constant-time string compare.
// Fixture-tested against the RFC test vectors.
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const b32encode = (buf) => {
  let bits = 0,
    value = 0,
    out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
};
export const b32decode = (str) => {
  let bits = 0,
    value = 0;
  const out = [];
  for (const ch of String(str).toUpperCase().replace(/=+$/, '')) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};
export function hotp(keyBuf, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', keyBuf).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}
export function totp(secretB32, nowMs = Date.now(), stepS = 30) {
  return hotp(b32decode(secretB32), Math.floor(nowMs / 1000 / stepS));
}
export const timingSafeEqStr = (a, b) => {
  const ba = Buffer.from(String(a)),
    bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};
export function totpValid(secretB32, code, nowMs = Date.now()) {
  // accept the current step ± 1 (clock drift), constant-time compare
  for (const skew of [-1, 0, 1]) {
    if (timingSafeEqStr(totp(secretB32, nowMs + skew * 30_000), String(code))) return true;
  }
  return false;
}
