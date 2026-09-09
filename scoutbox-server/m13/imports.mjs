// F1 — Imports, integrations, portable player identity.
// Design decisions that are safety features, not gaps:
//  * Bulk import creates ORG-PRIVATE prospect records, never platform player
//    accounts. A CSV can therefore never mint a discoverable minor.
//  * Identity is provider + externalId. Name similarity alone NEVER merges —
//    it queues an identity review for a human with the right permissions.
//  * Outgoing webhooks are signed, tenant-scoped, retried with bounds, and
//    SSRF-guarded. Connectors report "not configured" until credentialed.
import crypto from 'node:crypto';

const PROSPECT_FIELDS = ['name', 'dob', 'position', 'foot', 'heightCm', 'provider', 'externalId', 'notes'];
const POSITIONS = ['GK', 'CB', 'RB', 'LB', 'RWB', 'LWB', 'CDM', 'CM', 'CAM', 'RW', 'LW', 'ST', 'CF'];
export const EXPORT_CONTRACT_VERSION = '2026-09-01.v1';

// Minimal, quote-aware CSV parser (RFC 4180 subset: quoted fields, "" escape).
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const src = String(text ?? '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

export function registerImports(ctx) {
  const {
    db, orgRouter, adminRouter, app, nextId, persist, persistNow, notify,
    requireLead, isLead, orgCanSee, paginate, histAppend, webhookUrlProblem,
    signBody, timingSafeEq, findPlayer,
  } = ctx;

  // ------------------------------------------------------------- templates
  orgRouter.get('/imports/template', (req, res) => {
    res.set('Content-Type', 'text/csv');
    res.send(`${PROSPECT_FIELDS.join(',')}\nJordan Example,2004-03-12,ST,right,181,statsprovider,SP-1001,left-sided forward\n`);
  });

  // -------------------------------------------------- validation + dry run
  function validateRows(org, header, dataRows, mapping) {
    // mapping: {csvColumnName → prospect field}; identity mapping by default.
    const colFor = {};
    header.forEach((h, i) => {
      const field = mapping?.[h] ?? (PROSPECT_FIELDS.includes(h) ? h : null);
      if (field) colFor[field] = i;
    });
    const missingCols = ['name', 'provider', 'externalId'].filter((f) => colFor[f] === undefined);
    const results = [];
    const seenInBatch = new Set();
    for (let r = 0; r < dataRows.length; r++) {
      const raw = dataRows[r];
      const rec = {};
      for (const f of PROSPECT_FIELDS) if (colFor[f] !== undefined) rec[f] = String(raw[colFor[f]] ?? '').trim();
      const errors = [];
      if (!rec.name) errors.push('name is required');
      if (!rec.provider || !rec.externalId) errors.push('provider and externalId are required — identity is never name-only');
      if (rec.dob && !/^\d{4}-\d{2}-\d{2}$/.test(rec.dob)) errors.push('dob must be YYYY-MM-DD');
      if (rec.dob && (rec.dob < '1940-01-01' || rec.dob > new Date().toISOString().slice(0, 10))) errors.push('dob out of range');
      if (rec.position && !POSITIONS.includes(rec.position)) errors.push(`position must be one of ${POSITIONS.join('/')}`);
      if (rec.heightCm && (!/^\d+$/.test(rec.heightCm) || +rec.heightCm < 100 || +rec.heightCm > 230)) errors.push('heightCm must be 100–230');
      const identKey = `${rec.provider}::${rec.externalId}`;
      let disposition = 'create';
      let matchPlayerId = null;
      if (errors.length) disposition = 'error';
      else if (seenInBatch.has(identKey)) { disposition = 'duplicate_in_file'; }
      else {
        seenInBatch.add(identKey);
        const existingProspect = db.prospects.find((p) => p.orgId === org.id && p.provider === rec.provider && p.externalId === rec.externalId && !p.reversedAt);
        const linkedPlayer = db.players.find((p) => (p.externalIds ?? []).some((e) => e.provider === rec.provider && e.externalId === rec.externalId));
        if (existingProspect) disposition = 'already_imported';
        else if (linkedPlayer) { disposition = 'linked_player_exists'; matchPlayerId = linkedPlayer.id; }
        else if (rec.dob) {
          // Same name + same dob on a platform player the org can already see
          // → AMBIGUOUS. Queued for review, never auto-merged.
          const candidate = db.players.find((p) => p.dob === rec.dob && p.name.toLowerCase() === rec.name.toLowerCase());
          if (candidate && orgCanSee(org, candidate)) { disposition = 'ambiguous_identity'; matchPlayerId = candidate.id; }
        }
      }
      results.push({ row: r + 2, record: rec, errors, disposition, matchPlayerId }); // +2: 1-based + header
    }
    return { missingCols, results };
  }

  orgRouter.post('/imports', (req, res) => {
    if (!requireLead(req, res)) return;
    const { csv, mapping } = req.body ?? {};
    const rows = parseCsv(csv);
    if (rows.length < 2) return res.status(400).json({ error: 'CSV_EMPTY', message: 'Need a header row plus at least one data row.' });
    if (rows.length > 2001) return res.status(400).json({ error: 'CSV_TOO_LARGE', message: 'Max 2000 rows per batch.' });
    const { missingCols, results } = validateRows(req.org, rows[0], rows.slice(1), mapping);
    if (missingCols.length) return res.status(400).json({ error: 'COLUMNS_MISSING', message: `Map these required columns: ${missingCols.join(', ')}`, missingCols });
    const batch = {
      id: nextId('imp'), orgId: req.org.id, kind: 'prospects',
      createdBy: req.orgUser.id, createdByName: req.orgUser.name, createdAt: Date.now(),
      header: rows[0], mapping: mapping ?? null,
      rows: results, status: 'validated',
      summary: {
        total: results.length,
        creatable: results.filter((r) => r.disposition === 'create').length,
        errors: results.filter((r) => r.disposition === 'error').length,
        duplicatesInFile: results.filter((r) => r.disposition === 'duplicate_in_file').length,
        alreadyImported: results.filter((r) => r.disposition === 'already_imported').length,
        linkedExisting: results.filter((r) => r.disposition === 'linked_player_exists').length,
        ambiguous: results.filter((r) => r.disposition === 'ambiguous_identity').length,
      },
      committedAt: null, reversedAt: null, createdProspectIds: [], history: [],
    };
    histAppend(batch, 'org_user', req.orgUser.id, req.orgUser.name, 'validated', batch.summary);
    db.importBatches.push(batch);
    persistNow();
    // This IS the dry run: nothing was written except the batch record.
    res.status(201).json({ batch: { ...batch, rows: batch.rows.slice(0, 200) }, dryRun: true, note: 'Nothing imported yet — review the report, then POST /imports/:id/commit with {confirm:true}.' });
  });

  orgRouter.get('/imports', (req, res) => {
    const mine = db.importBatches.filter((b) => b.orgId === req.org.id).slice().reverse();
    res.json(paginate(req, mine.map(({ rows, ...b }) => ({ ...b, rowCount: rows.length }))));
  });

  orgRouter.get('/imports/:id', (req, res) => {
    const b = db.importBatches.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!b) return res.status(404).json({ error: 'BATCH_NOT_FOUND' });
    res.json({ batch: b });
  });

  orgRouter.post('/imports/:id/commit', (req, res) => {
    if (!requireLead(req, res)) return;
    const b = db.importBatches.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!b) return res.status(404).json({ error: 'BATCH_NOT_FOUND' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'CONFIRM_REQUIRED', message: 'Committing writes records — send {confirm:true} after reviewing the dry run.' });
    if (b.status === 'committed') return res.json({ batch: b, note: 'Already committed (idempotent).' }); // idempotent commit
    if (b.status !== 'validated') return res.status(409).json({ error: 'BATCH_NOT_COMMITTABLE', status: b.status });
    for (const r of b.rows) {
      if (r.disposition === 'create') {
        const pr = {
          id: nextId('prs'), orgId: req.org.id, batchId: b.id,
          ...r.record, heightCm: r.record.heightCm ? +r.record.heightCm : null,
          minor: r.record.dob ? (new Date().getFullYear() - +r.record.dob.slice(0, 4)) < 19 : null, // conservative flag for UI care; real gates use platform DOB when linked
          linkedPlayerId: null, createdAt: Date.now(), modifiedAt: null, reversedAt: null,
        };
        db.prospects.push(pr);
        b.createdProspectIds.push(pr.id);
      } else if (r.disposition === 'ambiguous_identity') {
        db.identityReviews.push({
          id: nextId('idr'), orgId: req.org.id, batchId: b.id, row: r.row,
          record: r.record, candidatePlayerId: r.matchPlayerId,
          status: 'open', resolvedBy: null, resolvedAt: null, resolution: null, createdAt: Date.now(),
        });
      }
    }
    b.status = 'committed';
    b.committedAt = Date.now();
    histAppend(b, 'org_user', req.orgUser.id, req.orgUser.name, 'committed', { created: b.createdProspectIds.length });
    persistNow();
    emitWebhook(req.org.id, 'import.committed', { batchId: b.id, created: b.createdProspectIds.length });
    res.json({ batch: { ...b, rows: undefined }, created: b.createdProspectIds.length, reviewsQueued: b.summary.ambiguous });
  });

  orgRouter.post('/imports/:id/reverse', (req, res) => {
    if (!requireLead(req, res)) return;
    const b = db.importBatches.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!b) return res.status(404).json({ error: 'BATCH_NOT_FOUND' });
    if (b.status !== 'committed') return res.status(409).json({ error: 'NOT_COMMITTED' });
    let removed = 0, kept = [];
    for (const pid of b.createdProspectIds) {
      const pr = db.prospects.find((p) => p.id === pid);
      if (!pr || pr.reversedAt) continue;
      if (pr.modifiedAt || pr.linkedPlayerId) { kept.push({ id: pid, reason: pr.linkedPlayerId ? 'linked to a player since import' : 'edited since import' }); continue; }
      pr.reversedAt = Date.now();
      removed++;
    }
    b.status = 'reversed';
    b.reversedAt = Date.now();
    histAppend(b, 'org_user', req.orgUser.id, req.orgUser.name, 'reversed', { removed, kept: kept.length });
    persistNow();
    res.json({ removed, kept, note: kept.length ? 'Records changed since import were kept — reversal only undoes this batch\'s own untouched changes.' : 'All records from this batch were reversed.' });
  });

  // ------------------------------------------------------------- prospects
  orgRouter.get('/prospects', (req, res) => {
    const mine = db.prospects.filter((p) => p.orgId === req.org.id && !p.reversedAt).slice().reverse();
    res.json(paginate(req, mine));
  });

  // ------------------------------------------------------ identity reviews
  orgRouter.get('/identity-reviews', (req, res) => {
    res.json({ items: db.identityReviews.filter((r) => r.orgId === req.org.id && r.status === 'open') });
  });

  orgRouter.post('/identity-reviews/:id/resolve', (req, res) => {
    if (!requireLead(req, res)) return;
    const r = db.identityReviews.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!r) return res.status(404).json({ error: 'REVIEW_NOT_FOUND' });
    if (r.status !== 'open') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    const action = req.body?.action;
    if (action === 'link') {
      const p = findPlayer(r.candidatePlayerId);
      if (!p || !orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE', message: 'You can only link identities on players currently visible to your organisation.' });
      // Provenance is PRESERVED, never overwritten: external ids accumulate,
      // and player-owned profile fields are untouched by the claim.
      p.externalIds ??= [];
      if (!p.externalIds.some((e) => e.provider === r.record.provider && e.externalId === r.record.externalId)) {
        p.externalIds.push({ provider: r.record.provider, externalId: r.record.externalId, source: `import:${r.batchId}`, by: req.orgUser.name, at: Date.now(), claim: r.record });
      }
      r.resolution = 'linked';
    } else if (action === 'separate') {
      const pr = {
        id: nextId('prs'), orgId: req.org.id, batchId: r.batchId,
        ...r.record, heightCm: r.record.heightCm ? +r.record.heightCm : null,
        linkedPlayerId: null, createdAt: Date.now(), modifiedAt: null, reversedAt: null,
      };
      db.prospects.push(pr);
      r.resolution = 'kept_separate';
    } else {
      return res.status(400).json({ error: 'BAD_ACTION', message: 'action must be "link" or "separate".' });
    }
    r.status = 'resolved';
    r.resolvedBy = req.orgUser.name;
    r.resolvedAt = Date.now();
    persistNow();
    emitWebhook(req.org.id, 'identity.resolved', { reviewId: r.id, resolution: r.resolution });
    res.json({ review: r });
  });

  // ------------------------------------------------------ API credentials
  orgRouter.get('/api-keys', (req, res) => {
    res.json({
      items: db.apiKeys.filter((k) => k.orgId === req.org.id).map(({ keyHash, ...k }) => k),
      contractVersion: EXPORT_CONTRACT_VERSION,
    });
  });

  const API_SCOPES = ['export:prospects', 'export:shortlist'];
  orgRouter.post('/api-keys', (req, res) => {
    if (!requireLead(req, res)) return;
    const scopes = (req.body?.scopes ?? []).filter((s) => API_SCOPES.includes(s));
    if (!scopes.length) return res.status(400).json({ error: 'SCOPES_REQUIRED', message: `Pick at least one of: ${API_SCOPES.join(', ')}` });
    const plaintext = `sbk_${crypto.randomBytes(24).toString('hex')}`;
    const k = {
      id: nextId('key'), orgId: req.org.id, scopes,
      keyHash: crypto.createHash('sha256').update(plaintext).digest('hex'),
      label: String(req.body?.label ?? 'API key').slice(0, 60),
      createdBy: req.orgUser.name, createdAt: Date.now(), revokedAt: null, lastUsedAt: null,
    };
    db.apiKeys.push(k);
    persistNow();
    res.status(201).json({ key: { ...k, keyHash: undefined }, plaintext, note: 'Store this now — the key is shown once and only its hash is kept.' });
  });

  orgRouter.post('/api-keys/:id/revoke', (req, res) => {
    if (!requireLead(req, res)) return;
    const k = db.apiKeys.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!k) return res.status(404).json({ error: 'KEY_NOT_FOUND' });
    k.revokedAt = Date.now();
    persistNow();
    res.json({ ok: true });
  });

  function apiKeyAuth(requiredScope) {
    return (req, res, next) => {
      const header = req.headers.authorization ?? '';
      if (!header.startsWith('ApiKey ')) return res.status(401).json({ error: 'API_KEY_REQUIRED', message: 'Authorization: ApiKey <key>' });
      const hash = crypto.createHash('sha256').update(header.slice(7)).digest('hex');
      const k = db.apiKeys.find((x) => x.keyHash === hash && !x.revokedAt);
      if (!k) return res.status(401).json({ error: 'API_KEY_INVALID' });
      if (!k.scopes.includes(requiredScope)) return res.status(403).json({ error: 'SCOPE_MISSING', required: requiredScope, held: k.scopes });
      k.lastUsedAt = Date.now();
      req.apiOrg = db.orgs.find((o) => o.id === k.orgId);
      if (!req.apiOrg || req.apiOrg.suspended) return res.status(403).json({ error: 'ORG_UNAVAILABLE' });
      next();
    };
  }

  // Versioned export contract. Tenant-scoped: an org exports ITS OWN records.
  app.get('/api/v1/export/prospects', apiKeyAuth('export:prospects'), (req, res) => {
    res.json({
      contract: EXPORT_CONTRACT_VERSION, kind: 'prospects', orgId: req.apiOrg.id,
      items: db.prospects.filter((p) => p.orgId === req.apiOrg.id && !p.reversedAt)
        .map((p) => ({ id: p.id, name: p.name, dob: p.dob || null, position: p.position || null, provider: p.provider, externalId: p.externalId, linkedPlayerId: p.linkedPlayerId })),
    });
  });

  app.get('/api/v1/export/shortlist', apiKeyAuth('export:shortlist'), (req, res) => {
    // Live visibility re-check on every export row — revoked access exports nothing.
    const ids = db.ledger.filter((l) => l.type === 'shortlist' && l.orgId === req.apiOrg.id).map((l) => l.playerId);
    const players = [...new Set(ids)].map(findPlayer).filter((p) => p && orgCanSee(req.apiOrg, p));
    res.json({
      contract: EXPORT_CONTRACT_VERSION, kind: 'shortlist', orgId: req.apiOrg.id,
      items: players.map((p) => ({ id: p.id, name: p.name, position: p.position, level: p.level, externalIds: (p.externalIds ?? []).map(({ provider, externalId }) => ({ provider, externalId })) })),
    });
  });

  // ------------------------------------------------------------- webhooks
  orgRouter.get('/webhooks', (req, res) => {
    res.json({
      items: db.webhookEndpoints.filter((w) => w.orgId === req.org.id).map(({ secret, secretPrev, ...w }) => w),
      guidance: 'Verify X-ScoutBox-Signature = HMAC-SHA256(secret, "<eventId>.<timestamp>.<rawBody>"). Reject timestamps older than 5 minutes and event ids you have already processed (replay protection).',
    });
  });

  const WEBHOOK_EVENTS = ['import.committed', 'identity.resolved', 'transition.granted', 'transition.revoked', 'delivery.failed'];
  orgRouter.post('/webhooks', (req, res) => {
    if (!requireLead(req, res)) return;
    const { url, events } = req.body ?? {};
    const problem = webhookUrlProblem(url);
    if (problem) return res.status(400).json({ error: 'WEBHOOK_URL_REJECTED', message: problem });
    const evs = (events ?? []).filter((e) => WEBHOOK_EVENTS.includes(e));
    if (!evs.length) return res.status(400).json({ error: 'EVENTS_REQUIRED', message: `Subscribe to at least one of: ${WEBHOOK_EVENTS.join(', ')}` });
    const w = {
      id: nextId('whk'), orgId: req.org.id, url: String(url), events: evs,
      secret: `whsec_${crypto.randomBytes(24).toString('hex')}`, secretPrev: null, secretPrevValidUntil: null,
      active: true, createdBy: req.orgUser.name, createdAt: Date.now(),
    };
    db.webhookEndpoints.push(w);
    persistNow();
    res.status(201).json({ endpoint: { ...w, secretPrev: undefined }, note: 'The signing secret is shown here and on rotation only.' });
  });

  orgRouter.post('/webhooks/:id/rotate', (req, res) => {
    if (!requireLead(req, res)) return;
    const w = db.webhookEndpoints.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!w) return res.status(404).json({ error: 'WEBHOOK_NOT_FOUND' });
    w.secretPrev = w.secret;
    w.secretPrevValidUntil = Date.now() + 24 * 3600_000; // old signatures verify for 24h
    w.secret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
    persistNow();
    res.json({ endpoint: { ...w, secretPrev: undefined }, note: 'Old secret stays valid for signature verification for 24 hours.' });
  });

  orgRouter.post('/webhooks/:id/deactivate', (req, res) => {
    if (!requireLead(req, res)) return;
    const w = db.webhookEndpoints.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!w) return res.status(404).json({ error: 'WEBHOOK_NOT_FOUND' });
    w.active = false;
    persistNow();
    res.json({ ok: true });
  });

  orgRouter.get('/webhooks/:id/deliveries', (req, res) => {
    const w = db.webhookEndpoints.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!w) return res.status(404).json({ error: 'WEBHOOK_NOT_FOUND' });
    res.json({ items: db.webhookDeliveries.filter((d) => d.endpointId === w.id).slice(-100).reverse() });
  });

  // Tenant-scoped emission: only endpoints belonging to `orgId` ever see the event.
  function emitWebhook(orgId, type, data) {
    for (const w of db.webhookEndpoints.filter((x) => x.orgId === orgId && x.active && x.events.includes(type))) {
      db.webhookDeliveries.push({
        id: nextId('dlv'), endpointId: w.id, orgId,
        eventId: `evt_${crypto.randomBytes(12).toString('hex')}`, type, data,
        status: 'queued', attempts: [], nextAt: Date.now(), createdAt: Date.now(),
      });
    }
    persist();
  }
  ctx.emitWebhook = emitWebhook;

  // Bounded retry ladder. M13_FAST_RETRY compresses it for the test suite —
  // the LOGIC under test is identical, only the waits shrink.
  const RETRY_MS = process.env.M13_FAST_RETRY === '1'
    ? [0, 300, 600, 900, 1200]
    : [0, 60_000, 300_000, 1_800_000, 7_200_000];
  const MAX_ATTEMPTS = RETRY_MS.length;

  async function deliverOne(d) {
    const w = db.webhookEndpoints.find((x) => x.id === d.endpointId);
    if (!w || !w.active) { d.status = 'abandoned'; return; }
    const problem = webhookUrlProblem(w.url);
    if (problem) { d.status = 'failed'; d.attempts.push({ at: Date.now(), error: `destination rejected: ${problem}` }); return; }
    const body = JSON.stringify({ eventId: d.eventId, type: d.type, createdAt: d.createdAt, data: d.data });
    const ts = Date.now();
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(w.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ScoutBox-Event-Id': d.eventId,
          'X-ScoutBox-Timestamp': String(ts),
          'X-ScoutBox-Signature': signBody(w.secret, d.eventId, ts, body),
        },
        body, signal: ctrl.signal,
      });
      clearTimeout(t);
      d.attempts.push({ at: ts, status: resp.status });
      if (resp.status >= 200 && resp.status < 300) { d.status = 'delivered'; d.deliveredAt = Date.now(); return; }
    } catch (err) {
      d.attempts.push({ at: ts, error: String(err?.cause?.code ?? err.message).slice(0, 120) });
    }
    if (d.attempts.length >= MAX_ATTEMPTS) {
      d.status = 'failed';
      db.opsEvents.push({ id: nextId('ops'), at: Date.now(), kind: 'webhook_failed', detail: { deliveryId: d.id, endpointId: d.endpointId } });
    } else {
      d.status = 'retrying';
      d.nextAt = Date.now() + RETRY_MS[d.attempts.length];
    }
  }

  async function webhookSweep() {
    const due = db.webhookDeliveries.filter((d) => ['queued', 'retrying'].includes(d.status) && d.nextAt <= Date.now());
    for (const d of due) await deliverOne(d);
    if (due.length) persistNow();
    return due.length;
  }
  ctx.webhookSweep = webhookSweep;

  // ----------------------------------------------------------- connectors
  // Registry of documented provider interfaces. NOTHING here activates
  // without real credentials + an authorised interface — and none exist in
  // this environment, so every connector honestly reports not_configured.
  const CONNECTORS = [
    { id: 'stats-feed', name: 'Match statistics feed', kind: 'inbound', envKey: 'CONNECTOR_STATS_KEY' },
    { id: 'fed-registry', name: 'Federation registration lookup', kind: 'inbound', envKey: 'CONNECTOR_FED_KEY' },
    { id: 'video-host', name: 'Licensed video platform', kind: 'inbound', envKey: 'CONNECTOR_VIDEO_KEY' },
  ];
  orgRouter.get('/connectors', (req, res) => {
    res.json({
      items: CONNECTORS.map((c) => ({
        id: c.id, name: c.name, kind: c.kind,
        status: process.env[c.envKey] ? 'configured' : 'not_configured',
        note: process.env[c.envKey] ? null : 'No provider credentials — this connector performs no requests and imports nothing until an authorised integration is configured.',
      })),
    });
  });

  adminRouter.get('/imports', (_req, res) => {
    res.json({ items: db.importBatches.slice(-50).reverse().map(({ rows, ...b }) => b) });
  });
}
