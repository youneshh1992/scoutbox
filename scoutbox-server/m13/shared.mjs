// M13 shared: additive migrations + cross-cutting helpers.
// Same conventions as m12/shared.mjs: nothing existing is renamed, retyped or
// deleted; every helper enforces at the server, never in a client.
import crypto from 'node:crypto';
import { isAdult, ageOn, adultAgeFor, visibleToOrg, haversineKm } from '../domain.mjs';

// ------------------------------------------------------------- migrations
export function migrateM13(db) {
  db.importBatches ??= [];        // F1 — CSV import batches (draft→validated→committed→reversed)
  db.prospects ??= [];            // F1 — org-PRIVATE imported records; never platform accounts
  db.identityReviews ??= [];      // F1 — ambiguous identity matches awaiting review
  db.apiKeys ??= [];              // F1 — scoped org API credentials (hash only)
  db.webhookEndpoints ??= [];     // F1 — outgoing webhook destinations + secrets
  db.webhookDeliveries ??= [];    // F1 — durable delivery attempts (bounded retries)
  db.playerPrefs ??= [];          // F3 — private suitability preferences
  db.transitionCases ??= [];      // F2 — consent-based academy transition cases
  db.representations ??= [];      // F10 — adult representation relationships
  db.exposureEvents ??= [];       // F4 — deduplicated exposure funnel events
  db.calibrationSessions ??= [];  // F5 — scout calibration sessions
  db.evidenceSuggestions ??= [];  // F6 — rule-engine suggestions + statuses
  db.fixtures ??= [];             // F7 — observable fixtures (own records; friendlies/trials join at read)
  db.coveragePlans ??= [];        // F7 — org coverage plans + goals
  db.coverageAssignments ??= [];  // F7 — scout↔fixture assignments → observations
  db.groups ??= [];               // F8 — parent organisations / federations
  db.groupGrants ??= [];          // F8 — explicit, expiring, revocable sharing grants
  db.dispatches ??= [];           // F11 — per-channel delivery records for notifications
  db.deliveryCallbacksSeen ??= [];// F11 — processed provider callback ids (idempotency)
  db.orgInvites ??= [];           // F12 — staff invitations
  db.ssoConfigs ??= [];           // F12 — per-org identity-provider configuration
  db.ssoStates ??= [];            // F12 — in-flight SSO authorisation states (state+nonce)
  db.supportTickets ??= [];       // F12 — support tickets referencing records by id
  db.supportAccessGrants ??= [];  // F12 — explicit, time-limited support access
  db.opsEvents ??= [];            // F12 — persisted operational failures/alerts
  for (const c of db.recruitmentCases ?? []) c.budget ??= null; // F9 — deal scenarios live on the case
  for (const u of db.users ?? []) {
    u.mfa ??= null;               // F12 — { secretB32, enabledAt, recoveryHashes: [] }
    u.deliveryPrefs ??= null;     // F11 — { quietStart, quietEnd, channels: {email: bool} }
  }
  for (const p of db.players ?? []) {
    p.externalIds ??= [];         // F1 — [{provider, externalId, source, at}] provenance kept
  }
}

// ----- TOTP (F12, RFC 6238 / HOTP RFC 4226, SHA-1, 6 digits, 30s step).
// Module-level so the login path in server.mjs can verify codes too.
// Small and fully fixture-tested against the RFC test vectors.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const b32encode = (buf) => {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
};
export const b32decode = (str) => {
  let bits = 0, value = 0; const out = [];
  for (const ch of String(str).toUpperCase().replace(/=+$/, '')) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
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
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};
export function totpValid(secretB32, code, nowMs = Date.now()) {
  // accept the current step ± 1 (clock drift), constant-time compare
  for (const skew of [-1, 0, 1]) {
    if (timingSafeEqStr(totp(secretB32, nowMs + skew * 30_000), String(code))) return true;
  }
  return false;
}

// ----- money (F9): integer minor units only. No floating-point arithmetic
// ever touches an amount; conversion uses a scaled-integer rate.
export const validAmountMinor = (v) => Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;
export const CURRENCIES = ['GBP', 'EUR', 'USD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'BRL'];
/** Convert via an explicit assumption. rate is a decimal STRING (e.g. "1.1732").
 *  Scaled to 1e6 integer math via BigInt; result rounded half-up to minor units. */
export function convertMinor(amountMinor, rateStr) {
  const m = String(rateStr).match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) return null;
  const scaled = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
  const num = BigInt(amountMinor) * scaled;
  const q = num / 1_000_000n, r = num % 1_000_000n;
  const rounded = r * 2n >= 1_000_000n ? q + 1n : q;
  return Number(rounded);
}

// ----- time slots with time zones (F3). A slot is
// {day: 'mon'.., start: 'HH:MM', end: 'HH:MM', tz: IANA string}.
// Comparison converts both slots to minutes-from-week-start in UTC.
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function tzOffsetMinutes(tz, ref = new Date('2026-01-15T12:00:00Z')) {
  // Offset of `tz` from UTC at a fixed reference instant (stable for tests;
  // DST-precise comparison would need per-date evaluation — documented).
  try {
    const s = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(ref).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = s.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!m) return 0;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  } catch { return null; } // unknown tz: caller treats as unknown, not zero
}
export function slotToUtcRange(slot) {
  const day = DAYS.indexOf(String(slot.day ?? '').toLowerCase());
  const [sh, sm] = String(slot.start ?? '').split(':').map(Number);
  const [eh, em] = String(slot.end ?? '').split(':').map(Number);
  const off = tzOffsetMinutes(slot.tz ?? 'UTC');
  if (day < 0 || Number.isNaN(sh) || Number.isNaN(eh) || off === null) return null;
  const WEEK = 7 * 24 * 60;
  const start = ((day * 24 * 60 + sh * 60 + (sm || 0) - off) % WEEK + WEEK) % WEEK;
  const end = start + ((eh * 60 + (em || 0)) - (sh * 60 + (sm || 0)));
  return end > start ? { start, end } : null;
}
export function slotsOverlap(a, b) {
  const ra = slotToUtcRange(a), rb = slotToUtcRange(b);
  if (!ra || !rb) return null; // unknown, not false
  const WEEK = 7 * 24 * 60;
  // compare on the circle (a range may wrap the week boundary via tz shift)
  for (const shift of [-WEEK, 0, WEEK]) {
    if (ra.start < rb.end + shift && rb.start + shift < ra.end) return true;
  }
  return false;
}

// SSRF guard: outgoing webhooks may never reach internal/private
// infrastructure. Loopback is allowed ONLY under ALLOW_LOCAL_WEBHOOKS=1
// (the test receiver) — documented, explicit, off by default.
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.lan)$/i;
const PRIVATE_IP = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i;
export function webhookUrlProblem(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return 'not a valid URL'; }
  if (!/^https?:$/.test(u.protocol)) return 'only http(s) destinations are allowed';
  if (u.username || u.password) return 'credentials in the URL are not allowed';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const isLoopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
  if (isLoopback) {
    return process.env.ALLOW_LOCAL_WEBHOOKS === '1' ? null
      : 'loopback destinations are blocked (set ALLOW_LOCAL_WEBHOOKS=1 only for local receiver tests)';
  }
  if (PRIVATE_HOST.test(host)) return 'internal hostnames are blocked';
  if (PRIVATE_IP.test(host)) return 'private/link-local IP ranges are blocked';
  if (u.protocol === 'http:') return 'external destinations must use https';
  return null;
}

// ---------------------------------------------------------------- helpers
export function buildSharedM13(ctx) {
  const { db, nextId } = ctx;

  // ----- small-group suppression (shared by F4/F8): never show n<3.
  const SUPPRESS_MIN = 3;
  const suppress = (n) => n < SUPPRESS_MIN;

  // ----- webhook/HMAC (F1, F11 callbacks)
  const signBody = (secret, eventId, ts, body) =>
    crypto.createHmac('sha256', secret).update(`${eventId}.${ts}.${body}`).digest('hex');
  const timingSafeEq = timingSafeEqStr;

  // ----- coarse location (F3): clubs see an area label + distance band only.
  const coarseArea = (loc) => loc?.city || 'area withheld';

  // ----- finance-visible roles (F9)
  const canViewFinance = (user) => /head|director|lead|manager|owner|chief|finance|treasurer/i.test(user?.role ?? '');

  // ----- group grant evaluation (F8). THE rule: effective permission is the
  // INTERSECTION of membership ∧ live grant ∧ resource permission ∧ current
  // player eligibility (visibleToOrg for the RECEIVING org) ∧ consent.
  function activeGrant(fromOrgId, toOrgId, resourceKind, resourceId, now = Date.now()) {
    return db.groupGrants.find((g) =>
      g.fromOrgId === fromOrgId && !g.revokedAt && (!g.expiresAt || g.expiresAt > now)
      && g.resourceKind === resourceKind && (g.resourceId === resourceId || g.resourceId === '*')
      && (g.toOrgIds.includes(toOrgId))
      && sameGroupLive(fromOrgId, toOrgId)) ?? null;
  }
  function sameGroupLive(orgA, orgB) {
    return db.groups.some((grp) => grp.memberOrgIds.includes(orgA) && grp.memberOrgIds.includes(orgB));
  }

  // ----- append-only history, same shape m12 records use.
  const histAppend = (record, byKind, byId, byName, action, detail = null) => {
    record.history ??= [];
    record.history.push({ id: nextId('aud'), at: Date.now(), byKind, byId, byName, action, detail });
  };

  // Lead tier — identical rule to m12 (documented role heuristic).
  const isLead = (user) => /head|director|lead|manager|owner|chief/i.test(user?.role ?? '');
  const requireLead = (req, res) => {
    if (isLead(req.orgUser)) return true;
    res.status(403).json({ error: 'LEAD_REQUIRED', message: 'This action needs a recruitment lead (role containing Head/Director/Lead/Manager).' });
    return false;
  };
  const orgCanSee = (org, player) => !!player && visibleToOrg(player, org) && !ctx.isBlocked(player.id, org.id);
  const paginate = (req, list) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    return { total: list.length, limit, offset, items: list.slice(offset, offset + limit) };
  };

  return {
    histAppend, isLead, requireLead, orgCanSee, paginate,
    validAmountMinor, CURRENCIES, convertMinor,
    suppress, SUPPRESS_MIN,
    signBody, timingSafeEq, webhookUrlProblem,
    slotsOverlap, slotToUtcRange, tzOffsetMinutes, coarseArea,
    canViewFinance, activeGrant, sameGroupLive,
    b32encode, b32decode, hotp, totp, totpValid,
    isAdult, ageOn, adultAgeFor, visibleToOrg, haversineKm,
  };
}
