// The feed always keeps the record; quiet hours and the minors' school-hours mute only hold back the push.
import { NOTIFICATION_LIMITS, feedItem } from '../../repositories/notifications.mjs';
import { validateIanaZone, localParts } from '../../temporal.mjs';
import { isAdult } from '../../domain.mjs';
import { minimizePayload } from '../platform/eventRegistry.mjs';

// Quiet hours are wall-clock rules for the person: their own zone when their preferences carry one, otherwise the
// platform's home zone, never the server process's.
const PLATFORM_HOME_ZONE = 'Europe/London';

/**
 * `notify` writes inside the caller's unit when one is open; the push and the live event wait for its commit. The
 * feed decorates each row at read time with the current resource its refId points to.
 */
export function createNotifier({ notifications, prefs, store, pushSender, byId, publishEvent, eventPayloadDrops }) {
  if (typeof prefs?.allows !== 'function') throw new TypeError('createNotifier needs the preference gate (createNotificationPrefs)');
  let suppressed = 0;

  function pushDeferred(audience, now = new Date()) {
    let personPrefs = null;
    let minor = false;
    if (audience.kind === 'player') {
      const p = byId.player(audience.id);
      personPrefs = p?.notificationPrefs;
      minor = p ? !isAdult(p) : false;
    } else if (audience.kind === 'guardian') {
      personPrefs = byId.guardian(audience.id)?.notificationPrefs;
    }
    const zone = validateIanaZone(personPrefs?.timezone).ok ? personPrefs.timezone : PLATFORM_HOME_ZONE;
    const wall = localParts(now.getTime(), zone);
    const minutes = Number(wall.hour) * 60 + Number(wall.minute);
    const schoolMute = personPrefs?.schoolHoursMute ?? minor; // minors are muted in school hours by default
    const day = new Date(Date.UTC(Number(wall.year), Number(wall.month) - 1, Number(wall.day))).getUTCDay();
    if (schoolMute && day >= 1 && day <= 5 && minutes >= 8 * 60 + 30 && minutes <= 15 * 60 + 30) return true;
    if (personPrefs?.quietStart && personPrefs?.quietEnd) {
      const [qsH, qsM] = personPrefs.quietStart.split(':').map(Number);
      const [qeH, qeM] = personPrefs.quietEnd.split(':').map(Number);
      const qs = qsH * 60 + (qsM || 0);
      const qe = qeH * 60 + (qeM || 0);
      const inQuiet = qs <= qe ? minutes >= qs && minutes < qe : minutes >= qs || minutes < qe;
      if (inQuiet) return true;
    }
    return false;
  }

  function notify(audience, type, text, refId = null, { actionRequired = null } = {}) {
    // The mandatory security category cannot be turned off.
    if (!prefs.allows(audience, type, text)) {
      suppressed += 1;
      return null;
    }
    // Cut at a character boundary: never half of an emoji's surrogate pair.
    const cut = (t, n) => { let s = t.slice(0, n); if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1); return s; };
    const body = typeof text === 'string' && text.length > NOTIFICATION_LIMITS.text ? `${cut(text, NOTIFICATION_LIMITS.text - 1)}…` : text;
    const at = Date.now();
    // Minimised now, so a bad call site fails inside its unit; delivered after the commit.
    const announce = () => {
      const { payload, dropped, unregistered } = minimizePayload('notify', { audienceKind: audience.kind, audienceId: audience.id });
      if (unregistered || dropped.length) { eventPayloadDrops.count += 1; eventPayloadDrops.lastEvent = 'notify'; throw new Error(`notify: the 'notify' event ${unregistered ? 'is not in the event registry' : `carried unregistered payload keys: ${dropped.join(', ')}`}`); }
      store.afterCommit(() => publishEvent('notify', payload));
    };
    // The same sentence about the same record, still unread, is refreshed and counted rather than pushed twice.
    const existing = notifications.findCoalescible({ audience, type, text: body, refId, at });
    if (existing) {
      const c = notifications.coalesce(existing.id, { at, actionRequired });
      announce();
      return c;
    }
    const n = notifications.create({
      audience, type, text: body, refId, at, actionRequired,
      category: prefs.categoryOf(type, body) ?? null,
      deferredPush: pushDeferred(audience),
    });
    // The promise is returned to the store, so a failed delivery is counted, never mistaken for a rollback.
    if (!n.deferredPush) store.afterCommit(() => pushSender.send(audience, 'ScoutBox', body));
    announce();
    return n;
  }

  const feedFor = (kind, id, targetFor = null) => notifications.forAudience(kind, id)
    .map((n) => (targetFor ? { ...feedItem(n), target: targetFor(n, { kind, id }) } : feedItem(n)));

  return { notify, feedFor, suppressedCount: () => suppressed };
}

export function registerNotificationFeed({ orgRouter, playerRouter, guardianRouter, notifications, notifier, notificationTargetFor }) {
  if (typeof notificationTargetFor !== 'function') throw new TypeError('registerNotificationFeed needs the journeys\' notificationTargetFor');
  const feed = (kind, id) => notifier.feedFor(kind, id, notificationTargetFor);
  const read = (kind, id, res) => { notifications.markRead(kind, id); res.json({ ok: true }); };
  orgRouter.get('/notifications', (req, res) => res.json(feed('org_user', req.orgUser.id)));
  orgRouter.post('/notifications/read', (req, res) => read('org_user', req.orgUser.id, res));
  playerRouter.get('/notifications', (req, res) => res.json(feed('player', req.player.id)));
  playerRouter.post('/notifications/read', (req, res) => read('player', req.player.id, res));
  guardianRouter.get('/notifications', (req, res) => res.json(feed('guardian', req.guardian.id)));
  guardianRouter.post('/notifications/read', (req, res) => read('guardian', req.guardian.id, res));
  return { feed };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const quietBound = (v) => (v == null || v === '' ? null : typeof v === 'string' && HHMM.test(v) ? v : undefined);

/** A device token another account registered moves to this one, so a shared phone gets only the latest sign-in's notices. */
export function registerDeliverySettings({ app, playerRouter, guardianRouter, players, guardians, pushTokens, sessionFor }) {
  if (typeof players?.setNotificationPrefs !== 'function' || typeof guardians?.setNotificationPrefs !== 'function') throw new TypeError('registerDeliverySettings needs the players and guardians repositories');
  const note = 'Quiet hours and the school-hours mute apply to push delivery; the in-app feed always keeps the record.';
  const show = (res, person) => res.json({ prefs: person.notificationPrefs ?? null, note });
  const save = (repo, person, req, res) => {
    const { quietStart, quietEnd, schoolHoursMute, timezone } = req.body || {};
    const qs = quietBound(quietStart); const qe = quietBound(quietEnd);
    if (qs === undefined || qe === undefined) return res.status(400).json({ error: 'TIME_INVALID', message: 'Quiet hours are written HH:MM (24-hour).', expected: 'HH:MM' });
    if (timezone != null && timezone !== '' && !validateIanaZone(timezone).ok) return res.status(400).json({ error: 'TIMEZONE_INVALID', message: 'timezone must be an IANA time zone name, for example Europe/London.' });
    if (schoolHoursMute != null && typeof schoolHoursMute !== 'boolean') return res.status(400).json({ error: 'FIELD_INVALID', field: 'schoolHoursMute', message: 'schoolHoursMute must be true or false.' });
    const was = person.notificationPrefs ?? {};
    const prefs = {
      quietStart: quietStart === undefined ? was.quietStart ?? null : qs,
      quietEnd: quietEnd === undefined ? was.quietEnd ?? null : qe,
      schoolHoursMute: schoolHoursMute ?? was.schoolHoursMute ?? null,
      timezone: timezone === undefined ? was.timezone ?? null : (timezone || null),
    };
    const empty = Object.values(prefs).every((v) => v === null);
    show(res, repo.setNotificationPrefs(person.id, empty ? null : prefs));
  };
  playerRouter.get('/prefs', (req, res) => show(res, req.player));
  playerRouter.post('/prefs', (req, res) => save(players, req.player, req, res));
  guardianRouter.get('/prefs', (req, res) => show(res, req.guardian));
  guardianRouter.post('/prefs', (req, res) => save(guardians, req.guardian, req, res));

  // Players and guardians only: club staff are notified in their portal and by e-mail.
  app.post('/push/register', (req, res) => {
    const session = sessionFor(req);
    if (!session) return res.status(401).json({ error: 'AUTH_REQUIRED' });
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'TOKEN_REQUIRED' });
    if (typeof token !== 'string' || token.length > 200) return res.status(400).json({ error: 'TOKEN_INVALID', message: 'A device token is text of at most 200 characters.' });
    if (session.kind !== 'player' && session.kind !== 'guardian') return res.status(403).json({ error: 'PUSH_NOT_AVAILABLE', message: 'Push notifications go to the Player app\'s players and guardians.' });
    const { moved } = pushTokens.register({ kind: session.kind, refId: session.refId, token, ts: Date.now() });
    res.status(201).json({ registered: true, moved });
  });
}
