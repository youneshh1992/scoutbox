// F11 — Post-signing outcomes with restart-safe follow-up jobs ·
// F12 — Practical access: resumable uploads, captions, honest benchmarks,
// football-context fields · plus the persistent sweep that also powers
// application reminders, trial-feedback escalation and upload cleanup.
//
// Every scheduled behaviour is a PERSISTED record examined by an idempotent
// sweep (on boot + every 60 s). Restarts lose nothing and re-send nothing:
// the marker that a reminder went out lives in the database, not in a timer.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isAdult, visibleToOrg } from '../domain.mjs';

const MILESTONES = { '3m': 91, '6m': 182, '12m': 365 };

export function registerOperations(ctx) {
  const {
    db, nextId, persist, persistNow, notify, ledgerAppend, broadcast, findPlayer,
    orgRouter, playerRouter, guardianRouter, adminRouter,
    paginate, guardianOwnsChild, orgCanSee, moderateOrRefuse,
    storage, sessionFor, isBlocked, DATA_DIR,
  } = ctx;

  const usersOf = (orgId) => db.users.filter((u) => u.orgId === orgId && !u.removedAt);

  // ================================================================== F11
  function scheduleFollowUps(signing) {
    let added = 0;
    for (const [milestone, days] of Object.entries(MILESTONES)) {
      if (db.followUps.some((f) => f.signingId === signing.id && f.milestone === milestone)) continue; // idempotent
      db.followUps.push({
        id: nextId('fup'), signingId: signing.id, playerId: signing.playerId, orgId: signing.orgId,
        milestone, dueAt: (signing.signedAt ?? signing.ts ?? Date.now()) + days * 86_400_000,
        status: 'scheduled', notifiedAt: null, createdAt: Date.now(),
      });
      added++;
    }
    return added;
  }

  function followUpView(f) {
    const report = db.outcomeReports.find((r) => r.followUpId === f.id) ?? null;
    const p = findPlayer(f.playerId);
    const org = db.orgs.find((o) => o.id === f.orgId);
    return {
      ...f, playerName: p?.name ?? 'departed player', orgName: org?.name ?? f.orgId,
      report,
      outcomeState: !report ? (f.status === 'due' ? 'unknown_pending' : 'not_due')
        : report.confirmations.some((c) => !c.agree) ? 'disputed'
        : report.confirmations.some((c) => c.agree) ? 'confirmed' : 'reported',
    };
  }

  orgRouter.get('/followups', (req, res) => {
    res.json(paginate(req, db.followUps.filter((f) => f.orgId === req.org.id).map(followUpView).sort((a, b) => a.dueAt - b.dueAt)));
  });

  orgRouter.post('/followups/:id/report', (req, res) => {
    const f = db.followUps.find((x) => x.id === req.params.id && x.orgId === req.org.id);
    if (!f) return res.status(404).json({ error: 'FOLLOWUP_NOT_FOUND' });
    if (db.outcomeReports.some((r) => r.followUpId === f.id)) return res.status(409).json({ error: 'ALREADY_REPORTED' });
    const { registrationStatus, matchesPlayed, progression, endReason, note } = req.body ?? {};
    if (!['registered', 'released', 'left', 'unknown'].includes(registrationStatus)) {
      return res.status(400).json({ error: 'REGISTRATION_STATUS_INVALID', allowed: ['registered', 'released', 'left', 'unknown'] });
    }
    if (note && !moderateOrRefuse(res, note, { kind: 'outcome_report', playerId: f.playerId, orgId: req.org.id })) return;
    const report = {
      id: nextId('out'), followUpId: f.id, signingId: f.signingId, playerId: f.playerId, orgId: f.orgId,
      by: { kind: 'org', id: req.orgUser.id, name: req.orgUser.name },
      registrationStatus,
      matchesPlayed: typeof matchesPlayed === 'number' ? matchesPlayed : null, // evidence-based where it exists, null otherwise
      progression: progression ? String(progression).slice(0, 200) : null,
      endReason: endReason ? String(endReason).slice(0, 200) : null,
      note: note ? String(note).slice(0, 300) : null,
      status: 'reported', confirmations: [], at: Date.now(),
    };
    db.outcomeReports.push(report);
    f.status = 'complete';
    const p = findPlayer(f.playerId);
    const text = `📊 ${req.org.name} filed the ${f.milestone} follow-up on the signing — please confirm or dispute it.`;
    if (p && !isAdult(p) && p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'outcome', text, f.id);
    else if (p) notify({ kind: 'player', id: p.id }, 'outcome', text, f.id);
    persistNow();
    res.status(201).json({ followUp: followUpView(f) });
  });

  function respondOutcome(req, res, playerIds, actor) {
    const f = db.followUps.find((x) => x.id === req.params.id && playerIds.includes(x.playerId));
    const report = f && db.outcomeReports.find((r) => r.followUpId === f.id);
    if (!report) return res.status(404).json({ error: 'REPORT_NOT_FOUND' });
    if (report.confirmations.some((c) => c.by.id === actor.id)) return res.status(409).json({ error: 'ALREADY_RESPONDED' });
    const { agree, note, experienceRating } = req.body ?? {};
    if (typeof agree !== 'boolean') return res.status(400).json({ error: 'AGREE_REQUIRED' });
    if (note && !moderateOrRefuse(res, note, { kind: 'outcome_response', playerId: f.playerId })) return;
    report.confirmations.push({
      by: actor, agree, note: note ? String(note).slice(0, 300) : null,
      experienceRating: [1, 2, 3, 4, 5].includes(experienceRating) ? experienceRating : null,
      at: Date.now(),
    });
    report.status = agree ? 'confirmed' : 'disputed';
    persistNow();
    res.json({ followUp: followUpView(f) });
  }

  playerRouter.get('/followups', (req, res) => {
    res.json(db.followUps.filter((f) => f.playerId === req.player.id).map(followUpView));
  });
  playerRouter.post('/followups/:id/respond', (req, res) => {
    if (req.playerIsMinor) return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Your parent/guardian confirms placement outcomes.' });
    respondOutcome(req, res, [req.player.id], { kind: 'player', id: req.player.id, name: req.player.name });
  });
  guardianRouter.get('/followups', (req, res) => {
    res.json(db.followUps.filter((f) => req.guardian.childIds.includes(f.playerId)).map(followUpView));
  });
  guardianRouter.post('/followups/:id/respond', (req, res) =>
    respondOutcome(req, res, req.guardian.childIds, { kind: 'guardian', id: req.guardian.id, name: req.guardian.name }));

  // Admin aggregates: defined denominators, missing data named, and groups
  // under 3 records suppressed so no individual answer is inferable.
  adminRouter.get('/outcomes', (_req, res) => {
    const rows = [];
    for (const org of db.orgs) {
      const signings = db.signings.filter((s) => s.orgId === org.id);
      if (!signings.length) continue;
      const fups = db.followUps.filter((f) => f.orgId === org.id);
      const reports = db.outcomeReports.filter((r) => r.orgId === org.id);
      if (signings.length < 3) {
        rows.push({ orgId: org.id, orgName: org.name, suppressed: true, note: 'Fewer than 3 signings — details suppressed to protect individual responses.' });
        continue;
      }
      const due = fups.filter((f) => f.status !== 'scheduled');
      rows.push({
        orgId: org.id, orgName: org.name, suppressed: false,
        signings: signings.length,
        followUpsDue: due.length,
        reported: reports.length,
        confirmed: reports.filter((r) => r.status === 'confirmed').length,
        disputed: reports.filter((r) => r.status === 'disputed').length,
        unknown: due.length - reports.length,
        retained: reports.filter((r) => r.registrationStatus === 'registered').length,
        denominator: `retention counts confirmed+reported registrations over ${due.length} due follow-ups (${due.length - reports.length} unknown)`,
      });
    }
    res.json({ rows, note: 'Missing data is counted as unknown, never as failure or success.' });
  });

  // ================================================================== F12A
  // Resumable uploads: a persistent session, integrity-checked chunks, an
  // explicit finalisation step. Nothing reports success early; abandoned
  // sessions are swept. Data URLs remain the small-file fast path.
  const UPLOAD_DIR = path.join(DATA_DIR, 'upload-tmp');
  const MAX_UPLOAD = 40 * 1024 * 1024;
  const CHUNK = 512 * 1024; // base64 chunks stay well under the JSON body cap
  const MIME_OK = /^(video\/(webm|mp4|quicktime)|image\/(jpeg|png|webp))$/;

  const chunkDir = (id) => path.join(UPLOAD_DIR, id);

  playerRouter.post('/uploads', (req, res) => {
    const { size, mime, title, sha256 } = req.body ?? {};
    if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ error: 'SIZE_REQUIRED' });
    if (size > MAX_UPLOAD) return res.status(413).json({ error: 'FILE_TOO_LARGE', maxBytes: MAX_UPLOAD, message: 'Uploads are capped at 40MB on this platform — trim the clip before uploading.' });
    if (!MIME_OK.test(String(mime))) return res.status(400).json({ error: 'TYPE_NOT_ALLOWED', allowed: 'webm/mp4/mov video or jpeg/png/webp image' });
    if (!title) return res.status(400).json({ error: 'TITLE_REQUIRED' });
    if (!moderateOrRefuse(res, title, { kind: 'media_title', playerId: req.player.id })) return;
    const up = {
      id: nextId('upl'), playerId: req.player.id, size: Number(size), mime: String(mime),
      title: String(title).slice(0, 120), sha256: sha256 ? String(sha256).slice(0, 64) : null,
      chunkSize: CHUNK, totalChunks: Math.ceil(size / CHUNK),
      received: [], status: 'open', createdAt: Date.now(), finalisedMediaId: null,
    };
    db.uploadSessions.push(up);
    persistNow();
    res.status(201).json({ upload: up });
  });

  function ownUpload(req, res) {
    const up = db.uploadSessions.find((u) => u.id === req.params.id && u.playerId === req.player.id);
    if (!up) { res.status(404).json({ error: 'UPLOAD_NOT_FOUND' }); return null; }
    return up;
  }

  playerRouter.put('/uploads/:id/chunks/:index', (req, res) => {
    const up = ownUpload(req, res);
    if (!up) return;
    if (up.status !== 'open') return res.status(409).json({ error: 'UPLOAD_NOT_OPEN', status: up.status });
    const idx = Number(req.params.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= up.totalChunks) return res.status(400).json({ error: 'CHUNK_INDEX_INVALID' });
    const data = req.body?.data;
    if (typeof data !== 'string' || !data) return res.status(400).json({ error: 'CHUNK_DATA_REQUIRED' });
    const buf = Buffer.from(data, 'base64');
    const expected = idx === up.totalChunks - 1 ? up.size - idx * up.chunkSize : up.chunkSize;
    if (buf.length !== expected) return res.status(400).json({ error: 'CHUNK_SIZE_MISMATCH', expected, got: buf.length });
    fs.mkdirSync(chunkDir(up.id), { recursive: true });
    fs.writeFileSync(path.join(chunkDir(up.id), String(idx)), buf); // idempotent: same index overwrites with identical content
    if (!up.received.includes(idx)) up.received.push(idx);
    persist();
    res.json({ received: up.received.length, totalChunks: up.totalChunks, complete: up.received.length === up.totalChunks });
  });

  playerRouter.get('/uploads/:id', (req, res) => {
    const up = ownUpload(req, res);
    if (up) res.json({ upload: up });
  });

  playerRouter.post('/uploads/:id/finalise', (req, res) => {
    const up = ownUpload(req, res);
    if (!up) return;
    if (up.status === 'finalised') return res.json({ upload: up, media: req.player.media.find((m) => m.id === up.finalisedMediaId) }); // idempotent retry
    if (up.status !== 'open') return res.status(409).json({ error: 'UPLOAD_NOT_OPEN', status: up.status });
    const missing = [];
    for (let i = 0; i < up.totalChunks; i++) if (!fs.existsSync(path.join(chunkDir(up.id), String(i)))) missing.push(i);
    if (missing.length) return res.status(409).json({ error: 'CHUNKS_MISSING', missing: missing.slice(0, 20), message: 'Upload the missing chunks, then finalise again — nothing was lost.' });
    const buf = Buffer.concat(Array.from({ length: up.totalChunks }, (_, i) => fs.readFileSync(path.join(chunkDir(up.id), String(i)))));
    if (buf.length !== up.size) return res.status(409).json({ error: 'SIZE_MISMATCH', expected: up.size, got: buf.length });
    if (up.sha256) {
      const digest = crypto.createHash('sha256').update(buf).digest('hex');
      if (digest !== up.sha256.toLowerCase()) return res.status(409).json({ error: 'INTEGRITY_FAILED', message: 'The assembled file does not match the checksum you declared — re-upload the damaged chunks.' });
    }
    const item = { id: nextId('media'), title: up.title, kind: up.mime.startsWith('video') ? 'video' : 'image', uploadedAt: new Date().toISOString(), url: null, views: 0, tags: {}, verifiedClip: null, captions: null, sizeBytes: up.size };
    storage.saveDataUrl(item.id, `data:${up.mime};base64,${buf.toString('base64')}`);
    item.url = `/media/${item.id}`;
    req.player.media.push(item);
    up.status = 'finalised';
    up.finalisedMediaId = item.id;
    fs.rmSync(chunkDir(up.id), { recursive: true, force: true });
    ctx.recordActivity(req.player);
    persistNow();
    broadcast('players', { playerId: req.player.id });
    res.status(201).json({ upload: up, media: item });
  });

  playerRouter.post('/uploads/:id/abort', (req, res) => {
    const up = ownUpload(req, res);
    if (!up) return;
    if (up.status === 'finalised') return res.status(409).json({ error: 'ALREADY_FINALISED' });
    up.status = 'aborted';
    fs.rmSync(chunkDir(up.id), { recursive: true, force: true });
    persistNow();
    res.json({ upload: up });
  });

  // ================================================================= F12B/E
  // Captions for prerecorded video (upload + serve), size info on media,
  // and honest labelling of what has no captions. Serving uses the same
  // live entitlement rule as the media bytes themselves.
  playerRouter.post('/media/:id/captions', (req, res) => {
    const m = req.player.media.find((x) => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });
    const vtt = String(req.body?.vtt ?? '');
    if (!vtt.trim().startsWith('WEBVTT')) return res.status(400).json({ error: 'VTT_REQUIRED', message: 'Captions are a WebVTT track (starts with "WEBVTT").' });
    if (vtt.length > 200_000) return res.status(413).json({ error: 'CAPTIONS_TOO_LARGE' });
    m.captions = vtt;
    persistNow();
    broadcast('players', { playerId: req.player.id });
    res.json({ media: { id: m.id, captions: true } });
  });

  ctx.app.get('/media/:id/captions', (req, res) => {
    const owner = db.players.find((p) => p.media.some((m) => m.id === req.params.id));
    const m = owner?.media.find((x) => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });
    const session = sessionFor(req);
    const entitled = session && (
      (session.kind === 'player' && owner.id === session.refId) ||
      (session.kind === 'guardian' && owner.guardianId === session.refId) ||
      (session.kind === 'org' && (() => { const org = db.orgs.find((o) => o.id === session.refId); return org && !org.suspended && visibleToOrg(owner, org) && !isBlocked(owner.id, org.id); })())
    );
    if (!entitled) return res.status(401).json({ error: 'MEDIA_AUTH_REQUIRED' });
    if (!m.captions) return res.status(404).json({ error: 'NO_CAPTIONS', message: 'This video has no caption track yet.' });
    res.set('Content-Type', 'text/vtt').send(m.captions);
  });

  // ================================================================= F12F
  // Football context: competition category on the player's own profile.
  playerRouter.post('/football-category', (req, res) => {
    const c = req.body?.category;
    if (!['mens', 'womens', 'boys', 'girls', 'mixed', null].includes(c)) return res.status(400).json({ error: 'CATEGORY_INVALID' });
    req.player.footballCategory = c;
    persistNow();
    res.json({ footballCategory: c });
  });

  // ================================================================ sweep
  // One idempotent pass over every persisted schedule. Runs at boot (catches
  // anything that came due while the process was down) and every minute.
  function sweep() {
    let changed = false;
    const now = Date.now();

    // F11: backfill follow-ups for every signing (covers pre-M12 signings
    // and new ones without touching the signing endpoint), then mark due.
    for (const s of db.signings) { if (scheduleFollowUps(s) > 0) changed = true; }
    for (const f of db.followUps) {
      if (f.status === 'scheduled' && f.dueAt <= now) {
        f.status = 'due';
        changed = true;
      }
      if (f.status === 'due' && !f.notifiedAt) {
        f.notifiedAt = now; // persisted BEFORE anything else → restart cannot double-send
        const org = db.orgs.find((o) => o.id === f.orgId);
        const p = findPlayer(f.playerId);
        const lead = usersOf(f.orgId)[0];
        if (lead) notify({ kind: 'org_user', id: lead.id }, 'outcome', `⏰ ${f.milestone} follow-up due for ${p?.name ?? 'a signed player'} — file the outcome report.`, f.id);
        if (p && !isAdult(p) && p.guardianId) notify({ kind: 'guardian', id: p.guardianId }, 'outcome', `How is ${p.name} getting on at ${org?.name}? A ${f.milestone} check-in is due — you can confirm or dispute the club's report.`, f.id);
        else if (p) notify({ kind: 'player', id: p.id }, 'outcome', `How is it going at ${org?.name}? Your ${f.milestone} check-in is due.`, f.id);
        changed = true;
      }
    }

    // F5: outstanding application outcomes nag once after 7 days.
    for (const a of db.applications) {
      if (a.status === 'submitted' && !a.remindedAt && now - a.createdAt > 7 * 86_400_000) {
        a.remindedAt = now;
        const lead = usersOf(a.orgId)[0];
        if (lead) notify({ kind: 'org_user', id: lead.id }, 'application', `⏳ ${a.playerName}'s application has waited a week — every applicant gets an answer.`, a.id);
        changed = true;
      }
    }

    // F9: overdue trial feedback escalates once — to the club AND into the
    // existing no-ghosting culture (admin can see it in reports volume).
    for (const t of db.trials) {
      // P4A-D1/D14: a null deadline is "unknown", not "now"; a tombstoned
      // trial has nobody to file for, so it never escalates.
      if (Number.isFinite(t.reportDueAt) && t.reportDueAt < now && !t.report && !t.feedbackEscalatedAt && !t.subjectRemovedAt) {
        t.feedbackEscalatedAt = now;
        const lead = usersOf(t.orgId)[0];
        if (lead) notify({ kind: 'org_user', id: lead.id }, 'trial_day', `🚨 Trial feedback for ${t.playerName} is overdue — the mandatory report blocks new trials until filed.`, t.id);
        changed = true;
      }
    }

    // F12A: abandoned upload sessions cleaned after 24 h.
    for (const u of db.uploadSessions) {
      if (u.status === 'open' && now - u.createdAt > 24 * 3600_000) {
        u.status = 'abandoned';
        fs.rmSync(chunkDir(u.id), { recursive: true, force: true });
        changed = true;
      }
    }

    if (changed) persistNow();
  }

  // T&S ops tools: run the scheduler now, and adjust a follow-up's due date
  // (e.g. aligning a check-in to season end). Both are ordinary authenticated
  // admin actions, not backdoors — they change WHEN, never WHAT.
  adminRouter.post('/sweep', (_req, res) => { sweep(); res.json({ ok: true }); });
  adminRouter.post('/followups/:id', (req, res) => {
    const f = db.followUps.find((x) => x.id === req.params.id);
    if (!f) return res.status(404).json({ error: 'FOLLOWUP_NOT_FOUND' });
    if (!Number.isFinite(Number(req.body?.dueAt))) return res.status(400).json({ error: 'DUE_AT_REQUIRED' });
    f.dueAt = Number(req.body.dueAt);
    persistNow();
    res.json({ followUp: followUpView(f) });
  });

  sweep(); // boot pass — catches everything that came due while down
  const timer = setInterval(sweep, 60_000);
  timer.unref?.(); // never keeps a test process alive
}
