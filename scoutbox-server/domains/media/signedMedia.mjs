// Every /media path leaving the API is rewritten to a short-lived signed URL bound to the minting session, and the
// serve route re-checks that session's current entitlement (blocks, suspension, radius, level, guardianship) on every
// fetch: possessing a URL is not authority.
import crypto from 'node:crypto';
import { visibleToOrg } from '../../domain.mjs';

// Short on purpose: clients refetch constantly (live-sync ticks), so links are re-minted long before they expire.
const MEDIA_URL_TTL_MS = 15 * 60 * 1000;

/**
 * Production refuses to boot without MEDIA_SECRET. In development an unset key is a fresh random one per process, so
 * links minted before a restart stop verifying and clients re-mint them.
 */
export function installSignedMedia({ app, byId, sessions, mediaDeletions, storage, sessionFor, isBlocked }) {
  if (typeof sessionFor !== 'function' || typeof isBlocked !== 'function' || typeof byId?.mediaOwner !== 'function') throw new TypeError('installSignedMedia needs sessionFor, isBlocked and the media-owner lookup');
  if (typeof sessions?.bySid !== 'function' || typeof mediaDeletions?.isQueued !== 'function' || typeof storage?.read !== 'function') throw new TypeError('installSignedMedia needs the sessions and media-deletions repositories and the storage adapter');
  const secret = process.env.MEDIA_SECRET || crypto.randomBytes(32).toString('base64url');

  const mediaSig = (id, exp, sid) => crypto.createHmac('sha256', secret).update(`${id}.${exp}.${sid}`).digest('base64url').slice(0, 24);

  function signMediaPath(pathStr, sid) {
    const m = /^\/media\/([A-Za-z0-9-]+)$/.exec(pathStr);
    if (!m || !sid) return pathStr; // unauthenticated response: the path stays bare
    const exp = Date.now() + MEDIA_URL_TTL_MS;
    return `/media/${m[1]}?e=${exp}&s=${mediaSig(m[1], exp, sid)}&v=${sid}`;
  }

  // Copy-on-write: never mutates the objects behind a response.
  function signMediaDeep(value, sid) {
    if (typeof value === 'string') return value.startsWith('/media/') ? signMediaPath(value, sid) : value;
    if (Array.isArray(value)) {
      let out = null;
      for (let i = 0; i < value.length; i++) {
        const signed = signMediaDeep(value[i], sid);
        if (signed !== value[i]) { out ??= value.slice(); out[i] = signed; }
      }
      return out ?? value;
    }
    if (value && typeof value === 'object') {
      let out = null;
      for (const key of Object.keys(value)) {
        const signed = signMediaDeep(value[key], sid);
        if (signed !== value[key]) { out ??= { ...value }; out[key] = signed; }
      }
      return out ?? value;
    }
    return value;
  }

  app.use((req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => json(signMediaDeep(body, sessionFor(req)?.sid ?? null));
    next();
  });

  // One rule for signed and bearer fetches alike, against the session's current standing.
  function sessionMayAccessMedia(session, mediaId) {
    if (!session) return false;
    const owner = byId.mediaOwner(mediaId);
    if (!owner) return false;
    if (session.kind === 'player') return owner.id === session.refId;
    if (session.kind === 'guardian') return owner.guardianId === session.refId;
    if (session.kind === 'org') {
      const org = byId.org(session.refId);
      return !!org && !org.suspended && visibleToOrg(owner, org) && !isBlocked(owner.id, org.id);
    }
    return false;
  }

  app.get('/media/:id', (req, res) => {
    const id = req.params.id;
    if (!/^[a-z0-9-]+$/i.test(id)) return res.status(400).json({ error: 'BAD_MEDIA_ID' });
    // The queue entry is the decision: a deleted owner's file is never served, whether or not it is gone yet.
    if (mediaDeletions.isQueued(id)) return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });
    const exp = Number(req.query.e ?? 0);
    const sid = String(req.query.v ?? '');
    let session = null;
    if (sid && exp > Date.now() && String(req.query.s ?? '') === mediaSig(id, exp, sid)) session = sessions.bySid(sid);
    session ??= sessionFor(req);
    if (!sessionMayAccessMedia(session, id)) {
      return res.status(401).json({ error: 'MEDIA_AUTH_REQUIRED', message: 'Media links are short-lived and tied to your login — refetch the profile for a fresh link.' });
    }
    const blob = storage.read(id);
    if (!blob) return res.status(404).json({ error: 'MEDIA_NOT_FOUND' });
    res.set('Content-Type', blob.contentType).send(blob.buffer);
  });
}
