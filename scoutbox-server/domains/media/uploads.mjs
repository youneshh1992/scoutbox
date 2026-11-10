// Nothing reports success before finalisation. server.mjs registers this before the operations module, whose sweep
// calls `sweepUploads`. Chunk bytes live under DATA_DIR/upload-tmp/<id>/ and are removed only after the write that
// ends the session commits.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { OPERATIONS_LIMITS, UPLOAD_MIMES, isSha256 } from '../../repositories/operations.mjs';

const MAX_UPLOAD = OPERATIONS_LIMITS.maxUploadBytes;
const CHUNK = 512 * 1024; // base64 chunks stay well under the JSON body cap

const chunkDirOf = (dataDir, id) => path.join(dataDir, 'upload-tmp', id);
export function removeUploadChunks(dataDir, ids) {
  for (const id of ids) fs.rmSync(chunkDirOf(dataDir, id), { recursive: true, force: true });
}

const uploadView = (u) => ({
  id: u.id,
  playerId: u.playerId,
  size: u.size,
  mime: u.mime,
  title: u.title,
  sha256: u.sha256,
  chunkSize: u.chunkSize,
  totalChunks: u.totalChunks,
  received: [...u.received],
  status: u.status,
  createdAt: u.createdAt,
  finalisedMediaId: u.finalisedMediaId,
});

export function registerUploads(ctx) {
  const { nextId, broadcast, playerRouter, moderateOrRefuse, storage, DATA_DIR, players, unit, operations } = ctx;
  if (typeof operations?.uploads?.open !== 'function')
    throw new TypeError('registerUploads needs the operations repository');
  const uploads = operations.uploads;
  const chunkDir = (id) => chunkDirOf(DATA_DIR, id);
  const invalid = (res, field, message) => res.status(400).json({ error: 'FIELD_INVALID', field, message });
  /** A write that refuses when another request ended the session first (a race) answers 409, as the check before it would. */
  const unlessEnded = (res, id, write) => {
    try {
      return write();
    } catch (e) {
      if (e?.code !== 'UPLOAD_NOT_OPEN') throw e;
      res.status(409).json({ error: 'UPLOAD_NOT_OPEN', status: uploads.byId(id)?.status ?? null });
      return null;
    }
  };

  playerRouter.post('/uploads', (req, res) => {
    const { size, mime, title, sha256 } = req.body ?? {};
    if (size === undefined || size === null) return res.status(400).json({ error: 'SIZE_REQUIRED' });
    if (!Number.isSafeInteger(size) || size <= 0) return invalid(res, 'size', 'size is a whole number of bytes.');
    if (size > MAX_UPLOAD)
      return res.status(413).json({
        error: 'FILE_TOO_LARGE',
        maxBytes: MAX_UPLOAD,
        message: 'Uploads are capped at 40MB on this platform — trim the clip before uploading.',
      });
    if (!UPLOAD_MIMES.includes(mime))
      return res.status(400).json({ error: 'TYPE_NOT_ALLOWED', allowed: 'webm/mp4/mov video or jpeg/png/webp image' });
    if (title === undefined || title === null || title === '') return res.status(400).json({ error: 'TITLE_REQUIRED' });
    if (typeof title !== 'string' || !title.trim()) return invalid(res, 'title', 'title must be text.');
    if (sha256 !== undefined && sha256 !== null && sha256 !== '' && !isSha256(sha256))
      return invalid(res, 'sha256', "sha256 is the file's SHA-256 digest: 64 hexadecimal characters.");
    if (!moderateOrRefuse(res, title, { kind: 'media_title', playerId: req.player.id })) return;
    const up = uploads.open({
      id: nextId('upl'),
      playerId: req.player.id,
      size,
      mime,
      title: title.slice(0, OPERATIONS_LIMITS.uploadTitle),
      sha256: sha256 || null,
      chunkSize: CHUNK,
      totalChunks: Math.ceil(size / CHUNK),
      status: 'open',
      createdAt: Date.now(),
      finalisedMediaId: null,
    });
    res.status(201).json({ upload: uploadView(up) });
  });

  function ownUpload(req, res) {
    const up = uploads.forPlayerById(req.player.id, req.params.id);
    if (!up) {
      res.status(404).json({ error: 'UPLOAD_NOT_FOUND' });
      return null;
    }
    return up;
  }

  playerRouter.put('/uploads/:id/chunks/:index', (req, res) => {
    const up = ownUpload(req, res);
    if (!up) return;
    if (up.status !== 'open') return res.status(409).json({ error: 'UPLOAD_NOT_OPEN', status: up.status });
    const idx = Number(req.params.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= up.totalChunks)
      return res.status(400).json({ error: 'CHUNK_INDEX_INVALID' });
    const data = req.body?.data;
    if (typeof data !== 'string' || !data) return res.status(400).json({ error: 'CHUNK_DATA_REQUIRED' });
    const buf = Buffer.from(data, 'base64');
    const expected = idx === up.totalChunks - 1 ? up.size - idx * up.chunkSize : up.chunkSize;
    if (buf.length !== expected)
      return res.status(400).json({ error: 'CHUNK_SIZE_MISMATCH', expected, got: buf.length });
    fs.mkdirSync(chunkDir(up.id), { recursive: true });
    fs.writeFileSync(path.join(chunkDir(up.id), String(idx)), buf); // idempotent: same index overwrites with identical content
    const fresh = unlessEnded(res, up.id, () => uploads.receiveChunk(up.id, idx));
    if (!fresh) return;
    res.json({
      received: fresh.received.length,
      totalChunks: fresh.totalChunks,
      complete: fresh.received.length === fresh.totalChunks,
    });
  });

  playerRouter.get('/uploads/:id', (req, res) => {
    const up = ownUpload(req, res);
    if (up) res.json({ upload: uploadView(up) });
  });

  playerRouter.post('/uploads/:id/finalise', (req, res) => {
    const up = ownUpload(req, res);
    if (!up) return;
    if (up.status === 'finalised')
      return res.json({ upload: uploadView(up), media: req.player.media.find((m) => m.id === up.finalisedMediaId) }); // idempotent retry
    if (up.status !== 'open') return res.status(409).json({ error: 'UPLOAD_NOT_OPEN', status: up.status });
    const missing = [];
    for (let i = 0; i < up.totalChunks; i++) if (!fs.existsSync(path.join(chunkDir(up.id), String(i)))) missing.push(i);
    if (missing.length)
      return res.status(409).json({
        error: 'CHUNKS_MISSING',
        missing: missing.slice(0, 20),
        message: 'Upload the missing chunks, then finalise again — nothing was lost.',
      });
    const buf = Buffer.concat(
      Array.from({ length: up.totalChunks }, (_, i) => fs.readFileSync(path.join(chunkDir(up.id), String(i)))),
    );
    if (buf.length !== up.size)
      return res.status(409).json({ error: 'SIZE_MISMATCH', expected: up.size, got: buf.length });
    if (up.sha256) {
      const digest = crypto.createHash('sha256').update(buf).digest('hex');
      if (digest !== up.sha256.toLowerCase())
        return res.status(409).json({
          error: 'INTEGRITY_FAILED',
          message: 'The assembled file does not match the checksum you declared — re-upload the damaged chunks.',
        });
    }
    const item = {
      id: nextId('media'),
      title: up.title,
      kind: up.mime.startsWith('video') ? 'video' : 'image',
      uploadedAt: new Date().toISOString(),
      url: null,
      views: 0,
      tags: {},
      verifiedClip: null,
      captions: null,
      sizeBytes: up.size,
    };
    storage.saveDataUrl(item.id, `data:${up.mime};base64,${buf.toString('base64')}`);
    item.url = `/media/${item.id}`;
    // The chunks are removed after the commit.
    const done = unlessEnded(res, up.id, () =>
      unit(() => {
        players.addItem(req.player.id, 'media', item);
        const fresh = uploads.finalise(up.id, item.id);
        ctx.recordActivity(req.player);
        broadcast('players', { playerId: req.player.id });
        return fresh;
      }),
    );
    if (!done) return;
    removeUploadChunks(DATA_DIR, [up.id]);
    res.status(201).json({ upload: uploadView(done), media: item });
  });

  playerRouter.post('/uploads/:id/abort', (req, res) => {
    const up = ownUpload(req, res);
    if (!up) return;
    if (up.status === 'finalised') return res.status(409).json({ error: 'ALREADY_FINALISED' });
    // Aborting twice changes nothing.
    const fresh = up.status === 'open' ? unlessEnded(res, up.id, () => uploads.abort(up.id)) : up;
    if (!fresh) return;
    removeUploadChunks(DATA_DIR, [up.id]);
    res.json({ upload: uploadView(fresh) });
  });

  function sweepUploads(now) {
    const gone = uploads.abandonOpenBefore(now - 24 * 3600_000);
    removeUploadChunks(DATA_DIR, gone);
    return gone.length > 0;
  }
  return { sweepUploads };
}
