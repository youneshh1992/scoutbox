// Bulk import creates org-private prospect records, never platform player accounts, so a CSV can never mint a
// discoverable minor. Identity is provider + externalId: name similarity alone never merges; it queues a review for a
// human with the right permissions.
import crypto from 'node:crypto';
import { parseDobStrict } from '../../temporal.mjs';
import { signBody, webhookUrlProblem } from './webhooks.mjs';
import { readPage, sendPageError } from '../platform/paging.mjs';
import { PROSPECT_FIELDS, PROSPECT_POSITIONS as POSITIONS, API_SCOPES, WEBHOOK_EVENTS, INTEGRATIONS_LIMITS as L } from '../../repositories/integrations.mjs';

export const EXPORT_CONTRACT_VERSION = '2026-09-01.v1';

// Quote-aware CSV parser (RFC 4180 subset: quoted fields, "" escape).
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
    byId, orgRouter, adminRouter, app, nextId,
    requireLead, orgCanSee,
    findPlayer, players, unit, safetyAudit, integrations,
  } = ctx;
  if (!integrations?.batches) throw new TypeError('registerImports needs the integrations repository (ctx.integrations)');
  const { batches, prospects, reviews, apiKeys, endpoints, deliveries } = integrations;
  const opsEvent = (row) => safetyAudit.opsEvents.record(row);
  const fieldInvalid = (res, field, message) => res.status(400).json({ error: 'FIELD_INVALID', field, message });
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  /** A refusal the route can answer (a live duplicate, a stale dry run); anything else is a defect. */
  const refused = (res, e) => {
    if (e?.code === 'IMPORT_IDENTITY_TAKEN') return res.status(409).json({ error: 'ALREADY_IMPORTED', message: `${e.provider} ${e.externalId} is already one of your live prospects. Validate the file again for a fresh report.` });
    throw e;
  };

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
      const errors = [];
      for (const f of PROSPECT_FIELDS) {
        if (colFor[f] === undefined) continue;
        rec[f] = String(raw[colFor[f]] ?? '').trim();
        // An over-long cell is a row error (kept cut to the limit), never stored whole.
        if (rec[f].length > L.record[f]) { errors.push(`${f} exceeds ${L.record[f]} characters`); rec[f] = rec[f].slice(0, L.record[f]); }
      }
      if (!rec.name) errors.push('name is required');
      if (!rec.provider || !rec.externalId) errors.push('provider and externalId are required — identity is never name-only');
      // The platform DOB rule, then the import's own floor.
      if (rec.dob) {
        const d = parseDobStrict(rec.dob, Date.now());
        if (!d.ok) errors.push(d.why === 'wrong shape' || d.why === 'not text' ? 'dob must be YYYY-MM-DD' : `dob out of range (${d.why})`);
        else if (rec.dob < '1940-01-01') errors.push('dob out of range');
      }
      if (rec.position && !POSITIONS.includes(rec.position)) errors.push(`position must be one of ${POSITIONS.join('/')}`);
      if (rec.heightCm && (!/^\d+$/.test(rec.heightCm) || +rec.heightCm < 100 || +rec.heightCm > 230)) errors.push('heightCm must be 100–230');
      const identKey = `${rec.provider}::${rec.externalId}`;
      let disposition = 'create';
      let matchPlayerId = null;
      if (errors.length) disposition = 'error';
      else if (seenInBatch.has(identKey)) { disposition = 'duplicate_in_file'; }
      else {
        seenInBatch.add(identKey);
        const linkedPlayer = players.byExternalId(rec.provider, rec.externalId);
        if (prospects.liveKeyTaken(org.id, rec.provider, rec.externalId)) disposition = 'already_imported';
        else if (linkedPlayer) { disposition = 'linked_player_exists'; matchPlayerId = linkedPlayer.id; }
        else if (rec.dob) {
          // Same name and dob as a platform player the org can see is ambiguous: queued for review, never auto-merged.
          const candidate = players.byNameAndDob(rec.name, rec.dob);
          if (candidate && orgCanSee(org, candidate)) { disposition = 'ambiguous_identity'; matchPlayerId = candidate.id; }
        }
      }
      results.push({ row: r + 2, record: rec, errors, disposition, matchPlayerId }); // +2: 1-based + header
    }
    return { missingCols, results };
  }

  const summaryOf = (results) => ({
    total: results.length,
    creatable: results.filter((r) => r.disposition === 'create').length,
    errors: results.filter((r) => r.disposition === 'error').length,
    duplicatesInFile: results.filter((r) => r.disposition === 'duplicate_in_file').length,
    alreadyImported: results.filter((r) => r.disposition === 'already_imported').length,
    linkedExisting: results.filter((r) => r.disposition === 'linked_player_exists').length,
    ambiguous: results.filter((r) => r.disposition === 'ambiguous_identity').length,
  });

  orgRouter.post('/imports', (req, res) => {
    if (!requireLead(req, res)) return;
    const { csv, mapping } = req.body ?? {};
    if (csv !== undefined && csv !== null && typeof csv !== 'string') return fieldInvalid(res, 'csv', 'csv is the text of the CSV file.');
    const rows = parseCsv(csv);
    if (rows.length < 2) return res.status(400).json({ error: 'CSV_EMPTY', message: 'Need a header row plus at least one data row.' });
    if (rows.length > L.rows + 1) return res.status(400).json({ error: 'CSV_TOO_LARGE', message: `Max ${L.rows} rows per batch.` });
    const header = rows[0];
    if (header.length > L.columns || header.some((h) => h.length > L.header)) return fieldInvalid(res, 'csv', `The header row holds at most ${L.columns} column names of at most ${L.header} characters each.`);
    // A mapping the import cannot honour is refused rather than ignored.
    if (mapping !== undefined && mapping !== null) {
      if (!isObject(mapping)) return fieldInvalid(res, 'mapping', 'mapping is an object from CSV column name to prospect field.');
      for (const [col, field] of Object.entries(mapping)) {
        if (!header.includes(col)) return fieldInvalid(res, 'mapping', `mapping names a column the CSV does not have (${col.slice(0, 40)}).`);
        if (field !== null && !PROSPECT_FIELDS.includes(field)) return fieldInvalid(res, `mapping.${col.slice(0, 40)}`, `Map a column to one of ${PROSPECT_FIELDS.join(', ')} (or null).`);
      }
    }
    const { missingCols, results } = validateRows(req.org, header, rows.slice(1), mapping);
    if (missingCols.length) return res.status(400).json({ error: 'COLUMNS_MISSING', message: `Map these required columns: ${missingCols.join(', ')}`, missingCols });
    const at = Date.now();
    const summary = summaryOf(results);
    const batch = batches.create({
      id: nextId('imp'), orgId: req.org.id, kind: 'prospects',
      createdBy: req.orgUser.id, createdByName: req.orgUser.name, createdAt: at,
      header, mapping: mapping ?? null, rows: results, status: 'validated', summary,
      committedAt: null, reversedAt: null, createdProspectIds: [],
      history: [{ id: nextId('aud'), at, byKind: 'org_user', byId: req.orgUser.id, byName: req.orgUser.name, action: 'validated', detail: summary }],
    });
    // The dry run writes only the batch record.
    res.status(201).json({ batch: { ...batch, rows: batch.rows.slice(0, 200) }, dryRun: true, note: 'Nothing imported yet — review the report, then POST /imports/:id/commit with {confirm:true}.' });
  });

  orgRouter.get('/imports', (req, res) => {
    let page;
    try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
    res.json(batches.page(req.org.id, page));
  });

  orgRouter.get('/imports/:id', (req, res) => {
    const b = batches.forOrgById(req.org.id, req.params.id);
    if (!b) return res.status(404).json({ error: 'BATCH_NOT_FOUND' });
    res.json({ batch: b });
  });

  orgRouter.post('/imports/:id/commit', (req, res) => {
    if (!requireLead(req, res)) return;
    const b = batches.forOrgById(req.org.id, req.params.id);
    if (!b) return res.status(404).json({ error: 'BATCH_NOT_FOUND' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'CONFIRM_REQUIRED', message: 'Committing writes records — send {confirm:true} after reviewing the dry run.' });
    if (b.status === 'committed') return res.json({ batch: b, note: 'Already committed (idempotent).' });
    if (b.status !== 'validated') return res.status(409).json({ error: 'BATCH_NOT_COMMITTABLE', status: b.status });
    const at = Date.now();
    const created = b.rows.filter((r) => r.disposition === 'create').map((r) => prospectFrom(r.record, { batchId: b.id, orgId: req.org.id, at }));
    const queued = b.rows.filter((r) => r.disposition === 'ambiguous_identity').map((r) => ({
      id: nextId('idr'), orgId: req.org.id, batchId: b.id, row: r.row, candidatePlayerId: r.matchPlayerId,
      status: 'open', resolvedBy: null, resolvedAt: null, resolution: null, createdAt: at,
    }));
    let committed;
    try {
      unit(() => {
        committed = batches.commit(b.id, { at, by: { id: req.orgUser.id, name: req.orgUser.name }, prospects: created, reviews: queued, historyId: nextId('aud') });
        emitWebhook(req.org.id, 'import.committed', { batchId: b.id, created: created.length });
      });
    } catch (e) { return refused(res, e); }
    res.json({ batch: { ...committed, rows: undefined }, created: created.length, reviewsQueued: committed.summary.ambiguous });
  });

  orgRouter.post('/imports/:id/reverse', (req, res) => {
    if (!requireLead(req, res)) return;
    const b = batches.forOrgById(req.org.id, req.params.id);
    if (!b) return res.status(404).json({ error: 'BATCH_NOT_FOUND' });
    if (b.status !== 'committed') return res.status(409).json({ error: 'NOT_COMMITTED' });
    // Nothing edits a prospect after its import, so none is kept back.
    const { removed } = batches.reverse(b.id, { at: Date.now(), by: { id: req.orgUser.id, name: req.orgUser.name }, historyId: nextId('aud') });
    res.json({ removed, kept: [], note: 'All records from this batch were reversed.' });
  });

  /** An empty optional cell is absent (null). */
  function prospectFrom(rec, { batchId, orgId, at }) {
    return {
      id: nextId('prs'), orgId, batchId,
      name: rec.name, dob: rec.dob || null, position: rec.position || null, foot: rec.foot || null,
      heightCm: rec.heightCm ? +rec.heightCm : null, provider: rec.provider, externalId: rec.externalId, notes: rec.notes || null,
      minor: rec.dob ? (new Date(at).getFullYear() - +rec.dob.slice(0, 4)) < 19 : null, // conservative flag for UI care; real gates use platform DOB when linked
      createdAt: at, reversedAt: null,
    };
  }

  // ------------------------------------------------------------- prospects
  orgRouter.get('/prospects', (req, res) => {
    let page;
    try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
    res.json(prospects.page(req.org.id, page));
  });

  // ------------------------------------------------------ identity reviews
  orgRouter.get('/identity-reviews', (req, res) => {
    res.json({ items: reviews.openForOrg(req.org.id) });
  });

  orgRouter.post('/identity-reviews/:id/resolve', (req, res) => {
    if (!requireLead(req, res)) return;
    const r = reviews.forOrgById(req.org.id, req.params.id);
    if (!r) return res.status(404).json({ error: 'REVIEW_NOT_FOUND' });
    if (r.status !== 'open') return res.status(409).json({ error: 'ALREADY_RESOLVED' });
    const action = req.body?.action;
    const at = Date.now();
    let resolved;
    if (action === 'link') {
      const p = findPlayer(r.candidatePlayerId);
      if (!p || !orgCanSee(req.org, p)) return res.status(403).json({ error: 'NOT_VISIBLE', message: 'You can only link identities on players currently visible to your organisation.' });
      // Provenance is preserved: external ids accumulate, and player-owned profile fields are untouched by the claim.
      unit(() => {
        if (!(p.externalIds ?? []).some((e) => e.provider === r.record.provider && e.externalId === r.record.externalId)) {
          players.addItem(p.id, 'externalIds', { provider: r.record.provider, externalId: r.record.externalId, source: `import:${r.batchId}`, by: req.orgUser.name, at, reviewId: r.id });
        }
        resolved = reviews.resolve(r.id, { resolution: 'linked', by: req.orgUser.name, at });
        emitWebhook(req.org.id, 'identity.resolved', { reviewId: r.id, resolution: 'linked' });
      });
    } else if (action === 'separate') {
      // One live prospect per provider and external id, as on import.
      if (prospects.liveKeyTaken(req.org.id, r.record.provider, r.record.externalId)) return res.status(409).json({ error: 'ALREADY_IMPORTED', message: `${r.record.provider} ${r.record.externalId} is already one of your live prospects.` });
      try {
        unit(() => {
          prospects.keepSeparate(prospectFrom(r.record, { batchId: r.batchId, orgId: req.org.id, at }));
          resolved = reviews.resolve(r.id, { resolution: 'kept_separate', by: req.orgUser.name, at });
          emitWebhook(req.org.id, 'identity.resolved', { reviewId: r.id, resolution: 'kept_separate' });
        });
      } catch (e) { return refused(res, e); }
    } else {
      return res.status(400).json({ error: 'BAD_ACTION', message: 'action must be "link" or "separate".' });
    }
    res.json({ review: resolved });
  });

  // ------------------------------------------------------ API credentials
  const keyView = ({ keyHash, ...k }) => k;
  orgRouter.get('/api-keys', (req, res) => {
    res.json({ items: apiKeys.forOrg(req.org.id).map(keyView), contractVersion: EXPORT_CONTRACT_VERSION });
  });

  orgRouter.post('/api-keys', (req, res) => {
    if (!requireLead(req, res)) return;
    const { scopes, label } = req.body ?? {};
    if (scopes === undefined || scopes === null || (Array.isArray(scopes) && !scopes.length)) return res.status(400).json({ error: 'SCOPES_REQUIRED', message: `Pick at least one of: ${API_SCOPES.join(', ')}` });
    // An unknown or repeated scope is refused, not dropped.
    if (!Array.isArray(scopes)) return fieldInvalid(res, 'scopes', `scopes is a list of: ${API_SCOPES.join(', ')}`);
    const wrong = scopes.findIndex((s) => !API_SCOPES.includes(s));
    if (wrong >= 0) return fieldInvalid(res, `scopes[${wrong}]`, `Pick from: ${API_SCOPES.join(', ')}`);
    if (new Set(scopes).size !== scopes.length) return fieldInvalid(res, 'scopes', 'scopes names a scope twice.');
    if (label !== undefined && label !== null && typeof label !== 'string') return fieldInvalid(res, 'label', 'label is text.');
    const plaintext = `sbk_${crypto.randomBytes(24).toString('hex')}`;
    const k = apiKeys.create({
      id: nextId('key'), orgId: req.org.id, scopes: [...scopes],
      keyHash: crypto.createHash('sha256').update(plaintext).digest('hex'),
      label: String(label ?? 'API key').slice(0, L.label),
      createdBy: req.orgUser.name, createdAt: Date.now(), revokedAt: null, lastUsedAt: null,
    });
    res.status(201).json({ key: keyView(k), plaintext, note: 'Store this now — the key is shown once and only its hash is kept.' });
  });

  orgRouter.post('/api-keys/:id/revoke', (req, res) => {
    if (!requireLead(req, res)) return;
    const k = apiKeys.forOrgById(req.org.id, req.params.id);
    if (!k) return res.status(404).json({ error: 'KEY_NOT_FOUND' });
    apiKeys.revoke(k.id, Date.now());
    res.json({ ok: true });
  });

  function apiKeyAuth(requiredScope) {
    return (req, res, next) => {
      const header = req.headers.authorization ?? '';
      if (!header.startsWith('ApiKey ')) return res.status(401).json({ error: 'API_KEY_REQUIRED', message: 'Authorization: ApiKey <key>' });
      const hash = crypto.createHash('sha256').update(header.slice(7)).digest('hex');
      const k = apiKeys.liveByHash(hash);
      if (!k) return res.status(401).json({ error: 'API_KEY_INVALID' });
      if (!k.scopes.includes(requiredScope)) return res.status(403).json({ error: 'SCOPE_MISSING', required: requiredScope, held: k.scopes });
      apiKeys.touch(k.id, Date.now());
      req.apiOrg = byId.org(k.orgId);
      if (!req.apiOrg || req.apiOrg.suspended) return res.status(403).json({ error: 'ORG_UNAVAILABLE' });
      next();
    };
  }

  // Versioned export contract; an org exports only its own records.
  app.get('/api/v1/export/prospects', apiKeyAuth('export:prospects'), (req, res) => {
    res.json({
      contract: EXPORT_CONTRACT_VERSION, kind: 'prospects', orgId: req.apiOrg.id,
      // linkedPlayerId stays in the export contract, always null: nothing links a prospect to a player.
      items: prospects.liveForOrg(req.apiOrg.id)
        .map((p) => ({ id: p.id, name: p.name, dob: p.dob, position: p.position, provider: p.provider, externalId: p.externalId, linkedPlayerId: null })),
    });
  });

  app.get('/api/v1/export/shortlist', apiKeyAuth('export:shortlist'), (req, res) => {
    // Visibility is re-checked on every row: revoked access exports nothing.
    const ids = safetyAudit.ledger.playersListedBy(req.apiOrg.id);
    const visible = ids.map(findPlayer).filter((p) => p && orgCanSee(req.apiOrg, p));
    res.json({
      contract: EXPORT_CONTRACT_VERSION, kind: 'shortlist', orgId: req.apiOrg.id,
      items: visible.map((p) => ({ id: p.id, name: p.name, position: p.position, level: p.level, externalIds: (p.externalIds ?? []).map(({ provider, externalId }) => ({ provider, externalId })) })),
    });
  });

  // ------------------------------------------------------------- webhooks
  const endpointView = ({ secret, secretPrev, ...w }) => w;
  orgRouter.get('/webhooks', (req, res) => {
    res.json({
      items: endpoints.forOrg(req.org.id).map(endpointView),
      guidance: 'Verify X-ScoutBox-Signature = HMAC-SHA256(secret, "<eventId>.<timestamp>.<rawBody>"). Reject timestamps older than 5 minutes and event ids you have already processed (replay protection).',
    });
  });

  orgRouter.post('/webhooks', (req, res) => {
    if (!requireLead(req, res)) return;
    const { url, events } = req.body ?? {};
    if (typeof url === 'string' && url.length > L.url) return fieldInvalid(res, 'url', `url is at most ${L.url} characters.`);
    const problem = webhookUrlProblem(url);
    if (problem) return res.status(400).json({ error: 'WEBHOOK_URL_REJECTED', message: problem });
    if (events === undefined || events === null || (Array.isArray(events) && !events.length)) return res.status(400).json({ error: 'EVENTS_REQUIRED', message: `Subscribe to at least one of: ${WEBHOOK_EVENTS.join(', ')}` });
    // An unknown or repeated event is refused, not dropped.
    if (!Array.isArray(events)) return fieldInvalid(res, 'events', `events is a list of: ${WEBHOOK_EVENTS.join(', ')}`);
    const wrong = events.findIndex((e) => !WEBHOOK_EVENTS.includes(e));
    if (wrong >= 0) return fieldInvalid(res, `events[${wrong}]`, `Subscribe to: ${WEBHOOK_EVENTS.join(', ')}`);
    if (new Set(events).size !== events.length) return fieldInvalid(res, 'events', 'events names an event twice.');
    const w = endpoints.create({
      id: nextId('whk'), orgId: req.org.id, url: String(url), events: [...events],
      secret: `whsec_${crypto.randomBytes(24).toString('hex')}`, secretPrev: null, secretPrevValidUntil: null,
      active: true, createdBy: req.orgUser.name, createdAt: Date.now(),
    });
    res.status(201).json({ endpoint: { ...w, secretPrev: undefined }, note: 'The signing secret is shown here and on rotation only.' });
  });

  orgRouter.post('/webhooks/:id/rotate', (req, res) => {
    if (!requireLead(req, res)) return;
    const w = endpoints.forOrgById(req.org.id, req.params.id);
    if (!w) return res.status(404).json({ error: 'WEBHOOK_NOT_FOUND' });
    const rotated = endpoints.rotate(w.id, { secret: `whsec_${crypto.randomBytes(24).toString('hex')}`, prevValidUntil: Date.now() + 24 * 3600_000 }); // old signatures verify for 24h
    res.json({ endpoint: { ...rotated, secretPrev: undefined }, note: 'Old secret stays valid for signature verification for 24 hours.' });
  });

  orgRouter.post('/webhooks/:id/deactivate', (req, res) => {
    if (!requireLead(req, res)) return;
    const w = endpoints.forOrgById(req.org.id, req.params.id);
    if (!w) return res.status(404).json({ error: 'WEBHOOK_NOT_FOUND' });
    endpoints.deactivate(w.id);
    res.json({ ok: true });
  });

  orgRouter.get('/webhooks/:id/deliveries', (req, res) => {
    const w = endpoints.forOrgById(req.org.id, req.params.id);
    if (!w) return res.status(404).json({ error: 'WEBHOOK_NOT_FOUND' });
    res.json({ items: deliveries.recentForEndpoint(w.id, 100) });
  });

  // Only endpoints of `orgId` see the event. Each delivery row joins the caller's unit when one is open, so it commits
  // with the change it announces.
  function emitWebhook(orgId, type, data) {
    if (!orgId) return;
    const at = Date.now();
    for (const w of endpoints.subscribed(orgId, type)) {
      deliveries.create({
        id: nextId('dlv'), endpointId: w.id, orgId,
        eventId: `evt_${crypto.randomBytes(12).toString('hex')}`, type, data,
        status: 'queued', attempts: [], nextAt: at, createdAt: at,
      });
    }
  }

  // SCOUTBOX_FAST_SWEEPS shrinks the waits for the test suite; the logic is the same.
  const RETRY_MS = process.env.SCOUTBOX_FAST_SWEEPS === '1'
    ? [0, 300, 600, 900, 1200]
    : [0, 60_000, 300_000, 1_800_000, 7_200_000];
  const MAX_ATTEMPTS = RETRY_MS.length;
  // A sweep that starts while an earlier one awaits the receiver skips these, so two sweeps never send one delivery at
  // once.
  const inFlight = new Set();

  /** Returns true when it recorded an ops event. */
  async function deliverOne(d) {
    const w = endpoints.byId(d.endpointId);
    if (!w || !w.active) { deliveries.abandon(d.id); return false; }
    const problem = webhookUrlProblem(w.url);
    if (problem) { deliveries.recordAttempt(d.id, { at: Date.now(), error: `destination rejected: ${problem}`.slice(0, L.attemptError) }, { status: 'failed' }); return false; }
    const body = JSON.stringify({ eventId: d.eventId, type: d.type, createdAt: d.createdAt, data: d.data });
    const ts = Date.now();
    let attempt;
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
      attempt = { at: ts, status: resp.status };
      if (resp.status >= 200 && resp.status < 300) { deliveries.recordAttempt(d.id, attempt, { status: 'delivered', deliveredAt: Date.now() }); return false; }
    } catch (err) {
      attempt = { at: ts, error: String(err?.cause?.code ?? err.message).slice(0, 120) || 'request failed' };
    }
    const sent = d.attempts.length + 1;
    if (sent >= MAX_ATTEMPTS) {
      deliveries.recordAttempt(d.id, attempt, { status: 'failed' });
      opsEvent({ id: nextId('ops'), at: Date.now(), kind: 'webhook_failed', detail: { deliveryId: d.id, endpointId: d.endpointId } });
      return true;
    }
    deliveries.recordAttempt(d.id, attempt, { status: 'retrying', nextAt: Date.now() + RETRY_MS[sent] });
    return false;
  }

  async function webhookSweep() {
    const due = deliveries.due(Date.now()).filter((d) => !inFlight.has(d.id));
    for (const d of due) {
      inFlight.add(d.id);
      try { await deliverOne(d); } finally { inFlight.delete(d.id); }
    }
    return due.length;
  }

  // ----------------------------------------------------------- connectors
  // Nothing activates without real credentials and an authorised interface, and none exist here, so every connector
  // reports not_configured.
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
    res.json({ items: batches.recent(50) });
  });

  return { emitWebhook, webhookSweep };
}
