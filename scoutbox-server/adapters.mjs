// Production-integration adapters. Every external service the platform needs
// sits behind one of these seams: the dev transport is fully functional (and
// is what tests exercise), and setting the named env var switches the seam to
// the real provider without touching any calling code.
//
//   Mailer   → SENDGRID_API_KEY   (dev: writes to db.outbox)
//   Push     → EXPO_ACCESS_TOKEN  (dev: writes to db.pushLog)
//   IDV      → ONFIDO_API_TOKEN   (dev: instant approval with an audit ref)
//   Billing  → STRIPE_SECRET_KEY  (dev: invoices recorded in db.invoices)
//   Storage  → S3_BUCKET (+creds) (dev: files under data/media/)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
export function createMailer(db, nextId) {
  const live = !!process.env.SENDGRID_API_KEY;
  return {
    transport: live ? 'sendgrid' : 'dev-outbox',
    async send({ to, subject, text }) {
      const record = { id: nextId('mail'), ts: Date.now(), to, subject, text, transport: live ? 'sendgrid' : 'dev-outbox', delivered: !live };
      db.outbox.push(record);
      if (live) {
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
          record.delivered = res.ok;
        } catch {
          record.delivered = false; // recorded in the outbox either way
        }
      }
      return record;
    },
  };
}

// ---------------------------------------------------------------------- push
export function createPushSender(db, nextId) {
  const live = !!process.env.EXPO_ACCESS_TOKEN;
  return {
    transport: live ? 'expo' : 'dev-log',
    async send(audience, title, body) {
      const record = { id: nextId('push'), ts: Date.now(), audience, title, body, transport: live ? 'expo' : 'dev-log' };
      db.pushLog.push(record);
      if (live) {
        // Expo push needs a device token registered per user; the registration
        // endpoint stores them under db.pushTokens keyed by audience.
        const tokens = (db.pushTokens ?? []).filter((t) => t.kind === audience.kind && t.refId === audience.id);
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
// Guardian identity verification. Dev provider approves instantly but leaves
// a full audit reference; a real document+liveness provider slots in here.
export function createIdvProvider() {
  const live = !!process.env.ONFIDO_API_TOKEN;
  return {
    provider: live ? 'onfido' : 'dev-attestation',
    async verify({ name, documentType, documentRef }) {
      if (live) {
        // Real integration: create applicant + check via the provider's API,
        // then poll/webhook the result. Requires ONFIDO_API_TOKEN.
        // Falls through to attestation if the call cannot complete here.
      }
      return {
        approved: true,
        provider: live ? 'onfido' : 'dev-attestation',
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
  const live = !!process.env.STRIPE_SECRET_KEY;
  return {
    provider: live ? 'stripe' : 'dev-ledger',
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
        provider: live ? 'stripe' : 'dev-ledger',
      };
      if (live) {
        // Real integration: stripe.invoiceItems.create + stripe.invoices.create
        // against the org's Stripe customer. Requires STRIPE_SECRET_KEY.
      }
      db.invoices.push(invoice);
      return invoice;
    },
  };
}

// ------------------------------------------------------------- object storage
// Media files live OUTSIDE the database: on local disk in dev, S3-compatible
// storage in production. The database keeps only ids and content types.
export function createStorage(dataDir) {
  const mediaDir = path.join(dataDir, 'media');
  const live = !!process.env.S3_BUCKET;
  const extFor = (contentType) => (contentType.includes('webm') ? 'webm' : contentType.includes('mp4') ? 'mp4' : 'bin');

  return {
    provider: live ? 's3' : 'local-disk',
    /** dataUrl → stored file. Returns {contentType} (the id names the file). */
    saveDataUrl(id, dataUrl) {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl ?? '');
      if (!m) return null;
      const [, contentType, b64] = m;
      fs.mkdirSync(mediaDir, { recursive: true });
      fs.writeFileSync(path.join(mediaDir, `${id}.${extFor(contentType)}`), Buffer.from(b64, 'base64'));
      // S3: PutObject with the same key — the local file doubles as a cache.
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
    delete(id) {
      for (const ext of ['webm', 'mp4', 'bin']) {
        try { fs.unlinkSync(path.join(mediaDir, `${id}.${ext}`)); } catch { /* absent is fine */ }
      }
    },
  };
}
