// F12A — Resumable uploads (moved from m12/operations.mjs; registered by m12/index.mjs before the operations module,
// whose sweep calls `sweepUploads`).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function registerUploads(ctx) {
  const { db, nextId, persist, persistNow, broadcast, playerRouter, moderateOrRefuse, storage, DATA_DIR, players, unit } = ctx;

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
    // ONE unit of work (S5): the clip row, the upload session's state (a blob)
    // and the activity commit together before the 201; the chunks go after.
    unit(() => {
      players.addItem(req.player.id, 'media', item);
      up.status = 'finalised';
      up.finalisedMediaId = item.id;
      ctx.recordActivity(req.player);
      broadcast('players', { playerId: req.player.id });
    });
    fs.rmSync(chunkDir(up.id), { recursive: true, force: true });
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

  /** Abandons the open sessions older than 24 hours and removes their chunks; true when one changed. */
  function sweepUploads(now) {
    let changed = false;
    for (const u of db.uploadSessions) {
      if (u.status === 'open' && now - u.createdAt > 24 * 3600_000) {
        u.status = 'abandoned';
        fs.rmSync(chunkDir(u.id), { recursive: true, force: true });
        changed = true;
      }
    }
    return changed;
  }
  return { sweepUploads };
}
