// M15 — Passport sharing: revocable opaque links.
//
// Tokens are high-entropy, stored ONLY as SHA-256 hashes, expiring and
// revocable. A share can only ever NARROW what a viewer would legitimately
// see — it never bypasses safeguarding, blocks, the agency/minor wall or
// the grassroots radius:
//   * public shares resolve anonymously to the SAFE PUBLIC projection;
//   * recruitment shares resolve ONLY through an authenticated organisation
//     session and re-run the standing orgCanSee gates.
// Unknown, revoked, expired and removed-subject tokens are indistinguishable
// (404 concealment), and the public resolver is rate-limited.
import { isAdult, visibleToOrg } from '../domain.mjs';
import { mintShareSecret, sha256, shareProblem, SHARE_MODES } from './shared.mjs';

export function registerPassportSharing(ctx) {
  const {
    db, app, playerRouter, guardianRouter, orgRouter, adminRouter,
    nextId, persistNow, notify, ledgerAppend, findPlayer, isBlocked, vmetric,
    buildFootballPassport,
  } = ctx;

  const orgCanSee = (org, p) => !!p && visibleToOrg(p, org) && !isBlocked(p.id, org.id);
  const guardianOwnsChild = (g, id) => g.childIds.includes(id);
  const shareView = (s) => ({ id: s.id, mode: s.mode, createdAt: s.createdAt, expiresAt: s.expiresAt, revokedAt: s.revokedAt, views: s.views, createdBy: s.createdBy.kind });

  function createShare(res, player, body, createdBy) {
    const mode = String(body.mode ?? 'public');
    if (!SHARE_MODES.includes(mode)) return res.status(400).json({ error: 'MODE_INVALID', allowed: SHARE_MODES });
    const days = Math.min(Math.max(Number(body.expiresDays) || 30, 1), 90);
    const secret = mintShareSecret();
    const share = {
      id: nextId('pshr'), playerId: player.id, mode, tokenHash: sha256(secret),
      createdBy, createdAt: Date.now(), expiresAt: Date.now() + days * 86_400_000,
      revokedAt: null, revokedBy: null, views: 0,
    };
    db.passportShares.push(share);
    ledgerAppend({ type: 'passport_share_created', playerId: player.id, orgId: null, detail: { mode, shareId: share.id } });
    vmetric('share_created');
    notify({ kind: 'player', id: player.id }, 'passport', `A ${mode} Football Passport share link was created${createdBy.kind === 'guardian' ? ' by your guardian' : ''}. It expires in ${days} days and can be revoked any time.`, share.id);
    persistNow();
    // The secret exists ONLY in this response — QR codes should encode
    // exactly this URL and nothing else.
    return res.status(201).json({
      share: shareView(share),
      url: mode === 'public' ? `/passport/shared/${secret}` : `/org/passport/shared/${secret}`,
      note: mode === 'public'
        ? 'Anyone with the link sees the SAFE PUBLIC projection only.'
        : 'The link opens only inside an authenticated club session, and every standing visibility rule still applies — a share never widens access.',
    });
  }

  // Adults manage their own shares; a minor's shares are guardian-managed
  // (existing DOB/country adult check — no new age system).
  playerRouter.post('/football-passport/shares', (req, res) => {
    if (!isAdult(req.player)) return res.status(403).json({ error: 'GUARDIAN_MANAGED', message: 'Your parent or guardian manages Passport sharing.' });
    createShare(res, req.player, req.body ?? {}, { kind: 'player', id: req.player.id });
  });
  guardianRouter.post('/children/:id/football-passport/shares', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    createShare(res, child, req.body ?? {}, { kind: 'guardian', id: req.guardian.id });
  });

  playerRouter.get('/football-passport/shares', (req, res) => {
    res.json({ items: db.passportShares.filter((s) => s.playerId === req.player.id).map(shareView) });
  });
  guardianRouter.get('/children/:id/football-passport/shares', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    res.json({ items: db.passportShares.filter((s) => s.playerId === req.params.id).map(shareView) });
  });

  function revoke(res, share, by) {
    if (!share) return res.status(404).json({ error: 'SHARE_NOT_FOUND' });
    if (share.revokedAt) return res.status(409).json({ error: 'ALREADY_REVOKED' });
    share.revokedAt = Date.now();
    share.revokedBy = by;
    ledgerAppend({ type: 'passport_share_revoked', playerId: share.playerId, orgId: null, detail: { shareId: share.id, by: by.kind } });
    vmetric('share_revoked');
    persistNow();
    res.json({ share: shareView(share), note: 'Revocation is immediate — the next request with this link fails.' });
  }
  playerRouter.post('/football-passport/shares/:id/revoke', (req, res) => {
    if (!isAdult(req.player)) return res.status(403).json({ error: 'GUARDIAN_MANAGED' });
    revoke(res, db.passportShares.find((s) => s.id === req.params.id && s.playerId === req.player.id), { kind: 'player', id: req.player.id });
  });
  guardianRouter.post('/children/:id/football-passport/shares/:sid/revoke', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    revoke(res, db.passportShares.find((s) => s.id === req.params.sid && s.playerId === req.params.id), { kind: 'guardian', id: req.guardian.id });
  });
  adminRouter.post('/passport/shares/:id/revoke', (req, res) => {
    revoke(res, db.passportShares.find((s) => s.id === req.params.id), { kind: 'trust_safety', id: 'admin' });
  });
  adminRouter.get('/passport/shares', (req, res) => {
    res.json({ items: db.passportShares.map((s) => ({ ...shareView(s), playerId: s.playerId })) });
  });

  // --------------------------------------------------- public resolution
  // Rate limiting: deterministic fixed-window counter per client address —
  // enumeration gets 429 long before the keyspace matters (24 random bytes).
  const attempts = new Map();
  const RATE = { windowMs: 60_000, max: 30 };
  function rateLimited(ip) {
    const now = Date.now();
    const row = attempts.get(ip);
    if (!row || row.resetAt < now) { attempts.set(ip, { count: 1, resetAt: now + RATE.windowMs }); return false; }
    row.count += 1;
    return row.count > RATE.max;
  }

  function resolveShare(secret) {
    const share = db.passportShares.find((s) => s.tokenHash === sha256(String(secret ?? '')));
    const player = share ? findPlayer(share.playerId) : null;
    const problem = shareProblem(share, { playerRemoved: !player });
    return { share, player, problem };
  }

  app.get('/passport/shared/:token', (req, res) => {
    res.set('X-Robots-Tag', 'noindex, nofollow'); // never search-indexed
    if (rateLimited(req.ip ?? 'unknown')) return res.status(429).json({ error: 'RATE_LIMITED' });
    const { share, player, problem } = resolveShare(req.params.token);
    // Concealment: unknown, revoked, expired, removed-subject and
    // wrong-mode all look identical from outside.
    if (problem || share.mode !== 'public') return res.status(404).json({ error: 'PASSPORT_NOT_FOUND' });
    share.views += 1;
    vmetric('share_opened_public');
    res.json(buildFootballPassport(player, 'public', { shareMode: 'public' }));
  });

  // Recruitment shares require an authenticated organisation session AND
  // re-run every standing gate — the link locates, it never authorises.
  orgRouter.get('/passport/shared/:token', (req, res) => {
    const { share, player, problem } = resolveShare(req.params.token);
    if (problem || share.mode !== 'recruitment') return res.status(404).json({ error: 'PASSPORT_NOT_FOUND' });
    if (!orgCanSee(req.org, player)) {
      // The share cannot widen: agencies still never reach minors, the
      // grassroots radius still applies, blocks still apply.
      return res.status(403).json({ error: req.org.type === 'agency' && !isAdult(player) ? 'UNDER_18_WALL' : 'NOT_VISIBLE' });
    }
    share.views += 1;
    vmetric('share_opened_recruitment');
    ledgerAppend({ type: 'passport_recruitment_view', playerId: player.id, orgId: req.org.id, orgName: req.org.name, userId: req.orgUser.id, scoutName: req.orgUser.name, detail: { via: 'share' } });
    const viewer = req.org.type === 'agency' ? 'agency' : req.org.level === 'grassroots' ? 'grassroots_club' : 'pro_club';
    res.json(buildFootballPassport(player, viewer, { orgId: req.org.id, shareMode: 'recruitment' }));
  });
}
