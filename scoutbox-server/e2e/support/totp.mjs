// The code a staff member's authenticator app would show: TOTP (RFC 6238 over HOTP, RFC 4226: SHA-1, 6 digits,
// 30 s step), for batteries that sign in with MFA. It plays the authenticator, not the server, so it is written
// here rather than imported: scripts/testE2ESupport.mjs proves it agrees with the server's own TOTP.
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32decode(str) {
  let bits = 0;
  let value = 0;
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
}

/** The 6-digit code for a base32 secret at `nowMs`. */
export function totp(secretB32, nowMs = Date.now()) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30_000)));
  const h = crypto.createHmac('sha1', b32decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}
