// Passport sharing. Tokens are stored only as SHA-256 hashes. A share can only narrow what a viewer would see: a
// public share resolves to the public projection, a recruitment share only inside an authenticated organisation
// session that re-runs the standing gates.
import { isAdult, visibleToOrg } from '../../../domain.mjs';
import { mintShareSecret, sha256, shareProblem, SHARE_MODES } from './shared.mjs';
import { PASSPORT_LIMITS } from '../../../repositories/passport.mjs';
import { readPage, sendPageError, pageOf } from '../../platform/paging.mjs';

const DAYS = PASSPORT_LIMITS.shareDays;

export function registerPassportSharing(ctx) {
  const {
    app,
    playerRouter,
    guardianRouter,
    orgRouter,
    adminRouter,
    nextId,
    notify,
    ledgerAppend,
    findPlayer,
    isBlocked,
    vmetric,
    buildFootballPassport,
    passport,
    unit,
  } = ctx;
  const shares = ctx.verificationReads.shares;

  const orgCanSee = (org, p) => !!p && visibleToOrg(p, org) && !isBlocked(p.id, org.id);
  const guardianOwnsChild = (g, id) => g.childIds.includes(id);
  const shareView = (s) => ({
    id: s.id,
    mode: s.mode,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    revokedAt: s.revokedAt,
    views: s.views,
    createdBy: s.createdBy.kind,
  });

  function createShare(res, player, body, createdBy) {
    const mode = String(body.mode ?? 'public');
    if (!SHARE_MODES.includes(mode)) return res.status(400).json({ error: 'MODE_INVALID', allowed: SHARE_MODES });
    // Refused, not clamped.
    const days = body.expiresDays === undefined || body.expiresDays === null ? DAYS.default : body.expiresDays;
    if (!Number.isInteger(days) || days < DAYS.min || days > DAYS.max)
      return res.status(400).json({
        error: 'FIELD_INVALID',
        field: 'expiresDays',
        message: `A whole number of days from ${DAYS.min} to ${DAYS.max}.`,
      });
    const secret = mintShareSecret();
    const now = Date.now();
    const share = unit(() => {
      const created = passport.shares.create({
        id: nextId('pshr'),
        playerId: player.id,
        mode,
        tokenHash: sha256(secret),
        createdBy,
        createdAt: now,
        expiresAt: now + days * 86_400_000,
        revokedAt: null,
        revokedBy: null,
        views: 0,
      });
      ledgerAppend({
        type: 'passport_share_created',
        playerId: player.id,
        orgId: null,
        detail: { mode, shareId: created.id },
      });
      notify(
        { kind: 'player', id: player.id },
        'passport',
        `A ${mode} Football Passport share link was created${createdBy.kind === 'guardian' ? ' by your guardian' : ''}. It expires in ${days} days and can be revoked any time.`,
        created.id,
      );
      return created;
    });
    vmetric('share_created');
    // The secret exists only in this response; a QR code should encode exactly this URL.
    return res.status(201).json({
      share: shareView(share),
      url: mode === 'public' ? `/passport/shared/${secret}` : `/org/passport/shared/${secret}`,
      note:
        mode === 'public'
          ? 'Anyone with the link sees the SAFE PUBLIC projection only.'
          : 'The link opens only inside an authenticated club session, and every standing visibility rule still applies — a share never widens access.',
    });
  }

  // A minor's shares are guardian-managed.
  playerRouter.post('/football-passport/shares', (req, res) => {
    if (!isAdult(req.player))
      return res
        .status(403)
        .json({ error: 'GUARDIAN_MANAGED', message: 'Your parent or guardian manages Passport sharing.' });
    createShare(res, req.player, req.body ?? {}, { kind: 'player', id: req.player.id });
  });
  guardianRouter.post('/children/:id/football-passport/shares', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(403).json({ error: 'NOT_YOUR_CHILD' });
    const child = findPlayer(req.params.id);
    if (!child) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    createShare(res, child, req.body ?? {}, { kind: 'guardian', id: req.guardian.id });
  });

  playerRouter.get('/football-passport/shares', (req, res) => {
    res.json({ items: shares.forPlayer(req.player.id).map(shareView) });
  });
  guardianRouter.get('/children/:id/football-passport/shares', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    res.json({ items: shares.forPlayer(req.params.id).map(shareView) });
  });

  function revoke(res, share, by) {
    if (!share) return res.status(404).json({ error: 'SHARE_NOT_FOUND' });
    if (share.revokedAt) return res.status(409).json({ error: 'ALREADY_REVOKED' });
    const revoked = unit(() => {
      const r = passport.shares.update(share.id, (d) => {
        d.revokedAt = Date.now();
        d.revokedBy = by;
      });
      ledgerAppend({
        type: 'passport_share_revoked',
        playerId: share.playerId,
        orgId: null,
        detail: { shareId: share.id, by: by.kind },
      });
      return r;
    });
    vmetric('share_revoked');
    res.json({ share: shareView(revoked), note: 'Revocation is immediate — the next request with this link fails.' });
  }
  playerRouter.post('/football-passport/shares/:id/revoke', (req, res) => {
    if (!isAdult(req.player)) return res.status(403).json({ error: 'GUARDIAN_MANAGED' });
    const s = shares.byId(req.params.id);
    revoke(res, s?.playerId === req.player.id ? s : null, { kind: 'player', id: req.player.id });
  });
  guardianRouter.post('/children/:id/football-passport/shares/:sid/revoke', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const s = shares.byId(req.params.sid);
    revoke(res, s?.playerId === req.params.id ? s : null, { kind: 'guardian', id: req.guardian.id });
  });
  adminRouter.post('/passport/shares/:id/revoke', (req, res) => {
    revoke(res, shares.byId(req.params.id), { kind: 'trust_safety', id: 'admin' });
  });
  adminRouter.get('/passport/shares', (req, res) => {
    let page;
    try {
      page = readPage(req.query, ['number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const { items, nextCursor } = pageOf(shares.page(page).rows, page.limit, (r) => r.key);
    res.json({ items: items.map(({ record: s }) => ({ ...shareView(s), playerId: s.playerId })), nextCursor });
  });

  // --------------------------------------------------- public resolution
  // Enumeration hits 429 long before the keyspace (24 random bytes) matters.
  const attempts = new Map();
  const RATE = { windowMs: 60_000, max: 30 };
  function rateLimited(ip) {
    const now = Date.now();
    const row = attempts.get(ip);
    if (!row || row.resetAt < now) {
      attempts.set(ip, { count: 1, resetAt: now + RATE.windowMs });
      return false;
    }
    row.count += 1;
    return row.count > RATE.max;
  }

  function resolveShare(secret) {
    const share = shares.byHash(sha256(String(secret ?? '')));
    const player = share ? findPlayer(share.playerId) : null;
    const problem = shareProblem(share, { playerRemoved: !player });
    return { share, player, problem };
  }

  app.get('/passport/shared/:token', (req, res) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    if (rateLimited(req.ip ?? 'unknown')) return res.status(429).json({ error: 'RATE_LIMITED' });
    const { share, player, problem } = resolveShare(req.params.token);
    // Unknown, revoked, expired, removed-subject and wrong-mode all look identical from outside.
    if (problem || share.mode !== 'public') return res.status(404).json({ error: 'PASSPORT_NOT_FOUND' });
    passport.shares.recordView(share.id);
    vmetric('share_opened_public');
    res.json(buildFootballPassport(player, 'public', { shareMode: 'public' }));
  });

  // The link locates, it never authorises.
  orgRouter.get('/passport/shared/:token', (req, res) => {
    const { share, player, problem } = resolveShare(req.params.token);
    if (problem || share.mode !== 'recruitment') return res.status(404).json({ error: 'PASSPORT_NOT_FOUND' });
    if (!orgCanSee(req.org, player)) {
      return res
        .status(403)
        .json({ error: req.org.type === 'agency' && !isAdult(player) ? 'UNDER_18_WALL' : 'NOT_VISIBLE' });
    }
    passport.shares.recordView(share.id);
    vmetric('share_opened_recruitment');
    ledgerAppend({
      type: 'passport_recruitment_view',
      playerId: player.id,
      orgId: req.org.id,
      orgName: req.org.name,
      userId: req.orgUser.id,
      scoutName: req.orgUser.name,
      detail: { via: 'share' },
    });
    const viewer =
      req.org.type === 'agency' ? 'agency' : req.org.level === 'grassroots' ? 'grassroots_club' : 'pro_club';
    res.json(buildFootballPassport(player, viewer, { orgId: req.org.id, shareMode: 'recruitment' }));
  });
}
