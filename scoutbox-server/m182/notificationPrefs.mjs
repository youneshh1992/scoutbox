/**
 * M18.2 — notification preferences, enforced where notifications are made.
 *
 * Forty notification `type` values had accumulated across four audiences with
 * no way for anyone to turn any of them off. This adds the smallest system
 * that is actually a system: every type maps to one CATEGORY, every person
 * has an on/off per category, and `notify()` consults it before it creates a
 * row — so an "off" category is never created and never pushed, rather than
 * created and then hidden by a client.
 *
 * Two things are deliberately fixed:
 *
 *   security_account is MANDATORY. Verification outcomes, account
 *   transitions and support access are not preferences; the ability to mute
 *   recruitment chatter must never mute "your account changed hands".
 *
 *   Email is not a real channel. There is no SMTP transport in this build —
 *   /capabilities reports `email_transport: local_outbox` — so the only
 *   channel preference offered is `emailIntent`: what the person WOULD want
 *   when a transport exists. It is stored and honoured by the outbox, and
 *   never described as delivery.
 *
 * Unknown category names fail closed to the safest reading: a type nobody
 * classified is delivered (a missing notification is worse than a spare one),
 * and a preference write naming an unknown category is refused.
 */

export const CATEGORIES = Object.freeze({
  mentions: { label: 'Mentions', default: true, mandatory: false },
  assignments: { label: 'Assignments and tasks', default: true, mandatory: false },
  room_changes: { label: 'Recruitment Room changes', default: true, mandatory: false },
  evidence_requests: { label: 'Evidence requests and evidence', default: true, mandatory: false },
  combine: { label: 'Combine requests and results', default: true, mandatory: false },
  trial_updates: { label: 'Trials and trial days', default: true, mandatory: false },
  second_look: { label: 'Second Look', default: true, mandatory: false },
  brief_updates: { label: 'Recruitment Briefs and coverage', default: true, mandatory: false },
  messages: { label: 'Messages and requests', default: true, mandatory: false },
  activity: { label: 'Recruitment outcomes and activity', default: true, mandatory: false },
  // Off by default: nudges nobody asked for and nothing depends on. An
  // outcome, a signing or a report deadline is not in here — those are
  // obligations, and "conservative default" must not mean "muted by surprise".
  discovery_nudges: { label: 'Discovery nudges and badges', default: false, mandatory: false },
  // M19: membership changes on a Dynamic Watchlist. On by default because a
  // watchlist is something the club deliberately asked ScoutBox to maintain —
  // it is a requested alert, not an unsolicited nudge.
  watchlist_changes: { label: 'Dynamic Watchlist changes', default: true, mandatory: false },
  // M21: ONE category for the whole Development Hub, not three. §81 asks for a
  // reasonable count, and the honest trade is stated rather than hidden: a
  // person who mutes this mutes shared goals, due actions and shared reviews
  // together. Splitting it would have produced three switches that are almost
  // always set the same way, which is how a preferences screen stops being read.
  development_updates: { label: 'Development plans, goals and reviews', default: true, mandatory: false },
  // M23 P5.6B: agent relationship requests and their outcomes. On by default
  // because a request is something a person must answer; a player who mutes
  // it is muting solicitations, which is their right.
  representation: { label: 'Agent representation requests and changes', default: true, mandatory: false },
  security_account: { label: 'Security and account', default: true, mandatory: true },
});
export const CATEGORY_NAMES = Object.freeze(Object.keys(CATEGORIES));

/** notification `type` → category. Every type the server emits is listed. */
export const TYPE_CATEGORY = Object.freeze({
  // recruitment rooms
  recruitment_room: 'room_changes',
  case: 'room_changes',
  // mentions and assignments arrive as recruitment_room today; the text is
  // classified by a second pass below so a mention is never muted as chatter.
  second_look: 'second_look',
  coverage: 'brief_updates',
  // A saved-search alert is something the scout ASKED for by saving the
  // search; it is not an unrequested nudge, so it stays on by default.
  saved_search: 'activity',
  // M19 watchlist membership changes.
  watchlist: 'watchlist_changes',
  // M21 Development Hub: one type, one category.
  development: 'development_updates',
  // evidence and combine
  evidence: 'evidence_requests',
  passport: 'evidence_requests',
  combine: 'combine',
  box_cam: 'combine',
  reassessment: 'combine',
  badge: 'discovery_nudges',
  level_up: 'discovery_nudges',
  // trials
  open_trial: 'trial_updates',
  trial_day: 'trial_updates',
  trial_report: 'trial_updates',
  report_due: 'trial_updates',
  matchday: 'trial_updates',
  friendly: 'trial_updates',
  squad_invite: 'trial_updates',
  // messaging and requests
  message: 'messages',
  request: 'messages',
  accepted: 'messages',
  declined: 'messages',
  // M23 P4A-D10: a minor hears that their guardian accepted or declined a
  // request for them. It is the outcome of a request, so it lives with the
  // other request outcomes — on by default, never a discovery nudge.
  guardian_decision: 'messages',
  application: 'messages',
  campaign: 'messages',
  review_queue: 'messages',
  feedback: 'messages',
  vouch: 'messages',
  group: 'messages',
  update: 'discovery_nudges',
  calibration: 'discovery_nudges',
  outcome: 'activity',
  signing: 'activity',
  released: 'activity',
  representation: 'activity',
  // M23 P5.6B Agent core
  representation_request: 'representation',
  representation_confirmed: 'representation',
  representation_rejected: 'representation',
  representation_terminated: 'representation',
  representation_disputed: 'representation',
  representation_expiring: 'representation',
  agent_verification: 'security_account',
  agency_membership: 'security_account',
  transition: 'security_account',
  // security and account — mandatory
  verification: 'security_account',
  aging_up: 'security_account',
  support: 'security_account',
  report_resolved: 'security_account',
});

/**
 * The category a notification belongs to. Mentions and assignments share the
 * `recruitment_room` type with ordinary room changes, so they are recognised
 * from the wording the server itself wrote — never from user text.
 */
export function categoryOf(type, text = '') {
  if (type === 'recruitment_room') {
    if (/mentioned you/i.test(text)) return 'mentions';
    if (/assigned you/i.test(text)) return 'assignments';
  }
  return TYPE_CATEGORY[type] ?? null;
}

export function defaultPrefs() {
  const categories = {};
  for (const [k, v] of Object.entries(CATEGORIES)) categories[k] = v.default;
  return { categories, emailIntent: false };
}

export function registerNotificationPrefs(ctx) {
  const { db, orgRouter, playerRouter, guardianRouter, persist } = ctx;
  db.notificationPrefs ??= [];

  const find = (kind, id) => db.notificationPrefs.find((p) => p.audienceKind === kind && p.audienceId === id) ?? null;

  /** Effective preferences: stored over defaults, mandatory always on. */
  function effective(kind, id) {
    const stored = find(kind, id);
    const out = defaultPrefs();
    if (stored) {
      // Own keys only: `'constructor' in CATEGORIES` is true through the
      // prototype, and a stored prototype name must never become a category.
      for (const [k, v] of Object.entries(stored.categories ?? {})) if (Object.hasOwn(CATEGORIES, k)) out.categories[k] = !!v;
      out.emailIntent = !!stored.emailIntent;
    }
    for (const [k, v] of Object.entries(CATEGORIES)) if (v.mandatory) out.categories[k] = true;
    return out;
  }

  /**
   * The enforcement point. True when a notification of this type may be
   * created for this audience. An unknown type is delivered — a missing
   * notification is the worse failure — and the fact is counted so the
   * registry gap is visible.
   */
  const unknownTypes = new Map();
  function allows(audience, type, text) {
    const cat = categoryOf(type, text);
    if (!cat) { unknownTypes.set(type, (unknownTypes.get(type) ?? 0) + 1); return true; }
    if (CATEGORIES[cat].mandatory) return true;
    return effective(audience.kind, audience.id).categories[cat] !== false;
  }

  function view(kind, id) {
    const eff = effective(kind, id);
    return {
      categories: CATEGORY_NAMES.map((k) => ({
        id: k, label: CATEGORIES[k].label, enabled: eff.categories[k], mandatory: CATEGORIES[k].mandatory,
      })),
      emailIntent: eff.emailIntent,
      channels: {
        inApp: 'always',
        email: 'local_outbox',
        note: 'In-app delivery always keeps the record. There is no external email transport in this build; the email preference records what you would want when one exists.',
      },
    };
  }

  function update(kind, id, body, res) {
    const incoming = body?.categories;
    if (incoming !== undefined && (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming))) {
      return res.status(400).json({ error: 'PREFS_INVALID', message: 'categories must be an object of category → boolean.' });
    }
    for (const k of Object.keys(incoming ?? {})) {
      // Own keys only — `__proto__`, `constructor`, `toString` are not categories.
      if (!Object.hasOwn(CATEGORIES, k)) return res.status(400).json({ error: 'PREF_CATEGORY_UNKNOWN', category: k, message: 'That is not a notification category.' });
      if (CATEGORIES[k].mandatory && incoming[k] === false) {
        return res.status(400).json({ error: 'PREF_CATEGORY_MANDATORY', category: k, message: 'Security and account notices cannot be turned off.' });
      }
    }
    let row = find(kind, id);
    if (!row) { row = { audienceKind: kind, audienceId: id, categories: {}, emailIntent: false, updatedAt: null }; db.notificationPrefs.push(row); }
    for (const [k, v] of Object.entries(incoming ?? {})) row.categories[k] = !!v;
    if (body?.emailIntent !== undefined) row.emailIntent = !!body.emailIntent;
    row.updatedAt = Date.now();
    persist();
    res.json({ preferences: view(kind, id) });
  }

  orgRouter.get('/notification-preferences', (req, res) => res.json({ preferences: view('org_user', req.orgUser.id) }));
  orgRouter.put('/notification-preferences', (req, res) => update('org_user', req.orgUser.id, req.body, res));
  playerRouter.get('/notification-preferences', (req, res) => res.json({ preferences: view('player', req.player.id) }));
  playerRouter.put('/notification-preferences', (req, res) => update('player', req.player.id, req.body, res));
  guardianRouter.get('/notification-preferences', (req, res) => res.json({ preferences: view('guardian', req.guardian.id) }));
  guardianRouter.put('/notification-preferences', (req, res) => update('guardian', req.guardian.id, req.body, res));

  ctx.notificationAllows = allows;
  ctx.notificationCategoryOf = categoryOf;
  ctx.notificationUnknownTypes = () => Object.fromEntries(unknownTypes);
  return { allows, effective, categoryOf };
}
