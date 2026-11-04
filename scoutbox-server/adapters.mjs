// Integration adapters. Every external service the platform needs sits behind
// one of these seams, so a real provider slots in without touching any calling
// code. The dev transport is fully functional and is what tests exercise.
//
//   Mailer   → SENDGRID_API_KEY switches to SendGrid (dev: the outbox table)
//   Push     → EXPO_ACCESS_TOKEN switches to Expo   (dev: the push log table)
//   IDV      → dev attestation only: instant approval with an audit reference
//   Billing  → dev ledger only: invoices recorded in db.invoices
//   Storage  → local disk only: files under DATA_DIR/media/
//
// No real IDV, billing or object-storage provider is integrated yet. Each seam
// names what it is; none claims a provider it doesn't call
// (UNIMPLEMENTED_PROVIDER_VARIABLES in domains/platform/capabilities.mjs).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { liveMailConfigured, livePushConfigured } from './domains/platform/capabilities.mjs';

// ------------------------------------------------------------------ passwords
// scrypt with a per-password salt. Stored as `scrypt$<salt>$<hash>` so the
// format can migrate later. Verification is constant-time.
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  if (!stored.startsWith('scrypt$')) {
    // Legacy plain-text record (pre-M7). Verify, and let the caller upgrade it.
    return crypto.timingSafeEqual(Buffer.from(String(password)), Buffer.from(String(stored)))
      ? 'upgrade' : false;
  }
  const [, salt, hash] = stored.split('$');
  const candidate = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(hash));
}

export const newToken = () => crypto.randomBytes(24).toString('hex');

export const randomCode = (length = 6) => {
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => ALPHABET[b % ALPHABET.length]).join('');
};

// --------------------------------------------------------------- rate limiter
// Fixed-window, in-memory, per IP+bucket. Enough to blunt credential stuffing
// and code guessing on a single node; swap for a shared store when scaling out.
export function makeRateLimiter({ windowMs = 60_000, max = 30, bucket = 'default' } = {}) {
  const hits = new Map(); // key -> {count, windowStart}
  return (req, res, next) => {
    const key = `${bucket}:${req.ip ?? req.socket?.remoteAddress ?? '?'}`;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 0, windowStart: now };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (hits.size > 10_000) hits.clear(); // crude memory bound
    if (entry.count > max) {
      return res.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many attempts — wait a minute and try again.',
        retryAfterMs: windowMs - (now - entry.windowStart),
      });
    }
    next();
  };
}

// -------------------------------------------------------------------- mailer
/** What a withheld secret reads as in the persisted outbox record. */
export const OUTBOX_SECRET_PLACEHOLDER = '[code withheld — delivered to the recipient only]';
const DEV_DELIVERY_LIMIT = 500;

/**
 * S7c: the outbox record is a row of the `outbox` table, written through the
 * outbox repository (repositories/outboxPush.mjs) when the server passes one in
 * `stores.outbox`; a tool or a test that hands this adapter a plain `db` with an
 * `outbox` ARRAY keeps the array behaviour (the record pushed, `delivered`
 * mutated on the record). Both store the same literal.
 */
const outboxStore = (db, stores) => (stores?.outbox
  ? { append: (record) => stores.outbox.append(record), markDelivered: (record, ok) => stores.outbox.markDelivered(record.id, ok) }
  : { append: (record) => db.outbox.push(record), markDelivered: () => {} });

export function createMailer(db, nextId, stores = null) {
  const live = liveMailConfigured();
  // S6a (review of e020aba, finding 1): `secrets` are one-time codes embedded in
  // the mail. The outbox record is persisted with every save and copied into
  // every backup, so the record keeps the mail with each secret replaced by
  // OUTBOX_SECRET_PLACEHOLDER — in both transports. Delivery is unchanged: the
  // provider receives the full text; on the dev transport, where the outbox IS
  // the delivery, the full text is kept in this process's memory only (bounded,
  // never saved, gone at restart) and served by the admin outbox view.
  const devDeliveries = new Map();
  const outbox = outboxStore(db, stores);
  return {
    transport: live ? 'sendgrid' : 'dev-outbox',
    async send({ to, subject, text, secrets = [] }) {
      const withheld = secrets.filter((s) => typeof s === 'string' && s.length > 0);
      const stored = withheld.reduce((t, s) => t.split(s).join(OUTBOX_SECRET_PLACEHOLDER), String(text));
      const record = { id: nextId('mail'), ts: Date.now(), to, subject, text: stored, transport: live ? 'sendgrid' : 'dev-outbox', delivered: !live };
      if (!live && withheld.length) {
        devDeliveries.set(record.id, String(text));
        if (devDeliveries.size > DEV_DELIVERY_LIMIT) devDeliveries.delete(devDeliveries.keys().next().value);
      }
      // The record is written BEFORE the provider call (as the array push was) and
      // becomes durable with the next save, exactly as its blob entry did.
      outbox.append(record);
      if (live) {
        let ok = false;
        try {
          const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: { authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: to }] }],
              from: { email: process.env.MAIL_FROM || 'noreply@scoutbox.app' },
              subject,
              content: [{ type: 'text/plain', value: text }],
            }),
          });
          ok = res.ok;
        } catch {
          ok = false; // recorded in the outbox either way
        }
        // The provider's synchronous answer: on the RECORD the caller holds (m23
        // reads `rec.delivered` from the resolved promise) AND on the stored row —
        // the row is a detached copy since S7c, so the update goes through the
        // repository instead of being lost on a mutated local object.
        record.delivered = ok;
        outbox.markDelivered(record, ok);
      }
      return record;
    },
    /** Dev transport only: the full text of a mail whose secrets the persisted record withholds (this process's memory; null otherwise). */
    devDeliveredText: (id) => (live ? null : devDeliveries.get(id) ?? null),
  };
}

// ---------------------------------------------------------------------- push
/**
 * S7c: the push record is a row of `push_log` and the tokens rows of
 * `push_tokens`, read and written through the repositories when the server
 * passes them in `stores`; a plain `db` with arrays keeps the array behaviour
 * (the review of 6ca66ba's feasibility check calls this adapter that way). The
 * filter is the same in both: every token registered under exactly this
 * (kind, id), its token string.
 */
const pushStores = (db, stores) => ({
  append: stores?.pushLog ? (record) => stores.pushLog.append(record) : (record) => db.pushLog.push(record),
  tokensFor: stores?.pushTokens ? (audience) => stores.pushTokens.forAudience(audience.kind, audience.id) : (audience) => (db.pushTokens ?? []).filter((t) => t.kind === audience.kind && t.refId === audience.id),
});

export function createPushSender(db, nextId, stores = null) {
  const live = livePushConfigured();
  const push = pushStores(db, stores);
  return {
    transport: live ? 'expo' : 'dev-log',
    async send(audience, title, body) {
      // `nextId` is the server's: it schedules the ordinary debounced save, which
      // is how this record — written AFTER the notification's save committed, by
      // the after-durable effect — reaches the file (review of 6ca66ba, D1: the
      // existing best-effort scheduling, nothing added, no guarantee implied).
      const record = { id: nextId('push'), ts: Date.now(), audience, title, body, transport: live ? 'expo' : 'dev-log' };
      push.append(record);
      if (live) {
        // Expo push needs a device token registered per user; the registration
        // endpoint stores them under the push tokens keyed by the session.
        const tokens = push.tokensFor(audience);
        for (const t of tokens) {
          try {
            await fetch('https://exp.host/--/api/v2/push/send', {
              method: 'POST',
              headers: { authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}`, 'content-type': 'application/json' },
              body: JSON.stringify({ to: t.token, title, body }),
            });
          } catch { /* recorded in pushLog regardless */ }
        }
      }
      return record;
    },
  };
}

// ----------------------------------------------------------------------- IDV
// Guardian identity verification. The dev provider approves instantly but
// leaves a full audit reference; a real document+liveness provider slots in here.
export function createIdvProvider() {
  return {
    provider: 'dev-attestation',
    async verify({ name, documentType, documentRef }) {
      return {
        approved: true,
        provider: 'dev-attestation',
        reference: `idv_${crypto.randomBytes(8).toString('hex')}`,
        checkedAt: Date.now(),
        document: { type: documentType, refLast4: String(documentRef).slice(-4) },
        subject: name,
      };
    },
  };
}

// ------------------------------------------------------------------- billing
// The deck's model: club subscription plans + a success fee when a signing is
// recorded inside the attribution window. Dev provider issues the invoice
// records; Stripe slots in behind the same call.
const SUCCESS_FEE_BY_PLAN = { Pro: 1500, Academy: 500, Agency: 2000 };

export function createBilling(db, nextId) {
  return {
    provider: 'dev-ledger',
    async invoiceForSigning(signing, org) {
      const amount = SUCCESS_FEE_BY_PLAN[org.plan] ?? 1000;
      const invoice = {
        id: nextId('inv'),
        ts: Date.now(),
        orgId: org.id,
        orgName: org.name,
        signingId: signing.id,
        playerName: signing.playerName,
        description: `Success fee — ${signing.playerName} signed inside the attribution window`,
        amount,
        currency: 'EUR',
        status: 'issued',
        provider: 'dev-ledger',
      };
      db.invoices.push(invoice);
      return invoice;
    },
  };
}

// ------------------------------------------------------------- object storage
// Media files live OUTSIDE the database, on the local disk under DATA_DIR. The
// database keeps only ids and content types.
export function createStorage(dataDir) {
  const mediaDir = path.join(dataDir, 'media');
  const extFor = (contentType) => (contentType.includes('webm') ? 'webm' : contentType.includes('mp4') ? 'mp4' : 'bin');

  return {
    provider: 'local-disk',
    /** dataUrl → stored file. Returns {contentType} (the id names the file). */
    saveDataUrl(id, dataUrl) {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl ?? '');
      if (!m) return null;
      const [, contentType, b64] = m;
      fs.mkdirSync(mediaDir, { recursive: true });
      fs.writeFileSync(path.join(mediaDir, `${id}.${extFor(contentType)}`), Buffer.from(b64, 'base64'));
      return { contentType };
    },
    read(id) {
      for (const ext of ['webm', 'mp4', 'bin']) {
        const f = path.join(mediaDir, `${id}.${ext}`);
        if (fs.existsSync(f)) {
          const type = ext === 'webm' ? 'video/webm' : ext === 'mp4' ? 'video/mp4' : 'application/octet-stream';
          return { contentType: type, buffer: fs.readFileSync(f) };
        }
      }
      return null;
    },
    /**
     * Remove the file(s) stored under `id`. Returns how many were removed (0:
     * nothing was there, which the deletion queue treats as done) and THROWS
     * on any error other than "absent", so a permission or I/O problem keeps
     * the queue entry and is retried — never cleared by mistake.
     */
    delete(id) {
      let removed = 0;
      for (const ext of ['webm', 'mp4', 'bin']) {
        try { fs.unlinkSync(path.join(mediaDir, `${id}.${ext}`)); removed += 1; } catch (err) { if (err?.code !== 'ENOENT') throw err; }
      }
      return removed;
    },
  };
}
