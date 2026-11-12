/**
 * Notification preferences, checked by `notify()` before a row is created, so
 * a muted category is never created rather than hidden by a client.
 *
 * There is no email transport, so `emailIntent` records what the person would
 * want once one exists; it is never described as delivery.
 *
 * An unclassified type is delivered (a missing notification is worse than a
 * spare one); a preference write naming an unknown category is refused.
 */

import * as v from 'valibot';
import { flag, parseInput } from './schemas.mjs';

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
  // Off by default: unrequested nudges. Outcomes, signings and deadlines are not in here.
  discovery_nudges: { label: 'Discovery nudges and badges', default: false, mandatory: false },
  // On by default: the club asked ScoutBox to maintain the watchlist.
  watchlist_changes: { label: 'Dynamic Watchlist changes', default: true, mandatory: false },
  // One category for the whole Hub: muting it mutes goals, actions and reviews together, since three switches
  // would almost always be set the same way.
  development_updates: { label: 'Development plans, goals and reviews', default: true, mandatory: false },
  representation: { label: 'Agent representation requests and changes', default: true, mandatory: false },
  // Mandatory: muting it would mute a regulatory obligation.
  compliance: { label: 'Regulatory review, consent and verification', default: true, mandatory: true },
  // Not mandatory: a transaction's compliance notices go to `compliance` instead.
  transaction_updates: { label: 'Transaction workspace activity', default: true, mandatory: false },
  // Not mandatory: a club is never owed a channel to a player.
  offer_updates: { label: 'Offers and Offer answers', default: true, mandatory: false },
  // Not mandatory, for the same reason as Offers.
  signing_updates: { label: 'Signing workflow', default: true, mandatory: false },
  security_account: { label: 'Security and account', default: true, mandatory: true },
});

// Each category is named once and set to true or false; a name that is not a category is PREF_CATEGORY_UNKNOWN.
const PREFS_INPUT = v.strictObject({
  categories: v.optional(v.strictObject(Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, v.optional(flag)])))),
  emailIntent: v.optional(flag),
});
export const CATEGORY_NAMES = Object.freeze(Object.keys(CATEGORIES));

/** notification `type` → category. Every type the server emits is listed. */
export const TYPE_CATEGORY = Object.freeze({
  // recruitment rooms
  recruitment_room: 'room_changes',
  case: 'room_changes',
  // Mentions and assignments arrive as recruitment_room; categoryOf tells them apart.
  second_look: 'second_look',
  coverage: 'brief_updates',
  // The scout asked for it by saving the search, so it is not a nudge.
  saved_search: 'activity',
  watchlist: 'watchlist_changes',
  development: 'development_updates',
  // evidence and combine
  evidence: 'evidence_requests',
  // A club asking a player (or their guardian) for more evidence.
  evidence_request: 'evidence_requests',
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
  // A minor hears their guardian's answer to a request: a request outcome, not a nudge.
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
  // Agent core
  representation_request: 'representation',
  representation_confirmed: 'representation',
  representation_rejected: 'representation',
  representation_terminated: 'representation',
  representation_disputed: 'representation',
  representation_expiring: 'representation',
  representation_disclosure: 'representation',
  representation_contact: 'representation',
  // A real opportunity, so it sits with messages rather than relationship admin.
  representation_opportunity: 'messages',
  representation_transaction: 'transaction_updates',
  agent_verification: 'security_account',
  agency_membership: 'security_account',
  // Conflict & Compliance Engine
  regulatory_review_required: 'compliance',
  regulatory_review_completed: 'compliance',
  regulatory_consent_requested: 'compliance',
  regulatory_consent_granted: 'compliance',
  regulatory_consent_declined: 'compliance',
  regulatory_consent_revoked: 'compliance',
  agent_verification_stale: 'compliance',
  // Agent Transaction Workspace; its compliance changes go to the mandatory category.
  agent_transaction: 'transaction_updates',
  recruitment_offer: 'offer_updates',
  recruitment_signing: 'signing_updates',
  agent_transaction_action: 'transaction_updates',
  agent_transaction_compliance: 'compliance',
  transition: 'security_account',
  // security and account — mandatory
  verification: 'security_account',
  aging_up: 'security_account',
  support: 'security_account',
  report_resolved: 'security_account',
});

/**
 * Mentions and assignments share the `recruitment_room` type, so they are
 * recognised from the server's own wording, never from user text.
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

/** Registers no routes, so the notifier can hold the gate before any module that notifies registers. */
export function createNotificationPrefs({ notifications }) {
  if (!notifications || typeof notifications.prefsFor !== 'function')
    throw new TypeError('createNotificationPrefs needs the notifications repository');

  const find = (kind, id) => notifications.prefsFor(kind, id);

  /** Stored over defaults; mandatory categories always on. */
  function effective(kind, id) {
    const stored = find(kind, id);
    const out = defaultPrefs();
    if (stored) {
      // Own keys only: `'constructor' in CATEGORIES` is true through the prototype.
      for (const [k, v] of Object.entries(stored.categories)) if (Object.hasOwn(CATEGORIES, k)) out.categories[k] = v;
      out.emailIntent = stored.emailIntent;
    }
    for (const [k, v] of Object.entries(CATEGORIES)) if (v.mandatory) out.categories[k] = true;
    return out;
  }

  /** In production an unknown type is delivered and counted, so the registry gap is visible; elsewhere notify refuses it. */
  const unknownTypes = new Map();
  function allows(audience, type, text) {
    const cat = categoryOf(type, text);
    if (!cat) {
      unknownTypes.set(type, (unknownTypes.get(type) ?? 0) + 1);
      return true;
    }
    if (CATEGORIES[cat].mandatory) return true;
    return effective(audience.kind, audience.id).categories[cat] !== false;
  }

  function view(kind, id) {
    const eff = effective(kind, id);
    return {
      categories: CATEGORY_NAMES.map((k) => ({
        id: k,
        label: CATEGORIES[k].label,
        enabled: eff.categories[k],
        mandatory: CATEGORIES[k].mandatory,
      })),
      emailIntent: eff.emailIntent,
      channels: {
        inApp: 'always',
        email: 'local_outbox',
        note: 'In-app delivery always keeps the record. There is no external email transport in this build; the email preference records what you would want when one exists.',
      },
    };
  }

  function update(kind, id, raw, res) {
    const parsed = parseInput(PREFS_INPUT, raw ?? {}, { codes: { FIELD_INVALID: 'PREFS_INVALID' } });
    if (!parsed.ok) {
      const { ok: _ok, ...refusal } = parsed;
      const category = refusal.field.startsWith('categories.') ? refusal.field.slice('categories.'.length) : null;
      const unknown = category && refusal.problem === 'unknown_field';
      return res.status(400).json({
        ...refusal,
        ...(unknown ? { error: 'PREF_CATEGORY_UNKNOWN' } : {}),
        ...(category ? { category } : {}),
      });
    }
    const body = parsed.value;
    const incoming = body.categories;
    for (const [k, on] of Object.entries(incoming ?? {})) {
      if (CATEGORIES[k].mandatory && on === false) {
        return res.status(400).json({
          error: 'PREF_CATEGORY_MANDATORY',
          category: k,
          message: 'Security and account notices cannot be turned off.',
        });
      }
    }
    const patch = { categories: { ...(incoming ?? {}) } };
    if (body.emailIntent !== undefined) patch.emailIntent = body.emailIntent;
    notifications.updatePrefs(kind, id, patch, { at: Date.now() });
    res.json({ preferences: view(kind, id) });
  }

  return { allows, effective, categoryOf, view, update, unknownTypes: () => Object.fromEntries(unknownTypes) };
}

/** `GET` and `PUT /notification-preferences` for club staff, players and guardians. */
export function registerNotificationPrefs({ prefs, orgRouter, playerRouter, guardianRouter }) {
  if (typeof prefs?.view !== 'function')
    throw new TypeError('registerNotificationPrefs needs the preferences from createNotificationPrefs');
  const { view, update } = prefs;
  orgRouter.get('/notification-preferences', (req, res) => res.json({ preferences: view('org_user', req.orgUser.id) }));
  orgRouter.put('/notification-preferences', (req, res) => update('org_user', req.orgUser.id, req.body, res));
  playerRouter.get('/notification-preferences', (req, res) => res.json({ preferences: view('player', req.player.id) }));
  playerRouter.put('/notification-preferences', (req, res) => update('player', req.player.id, req.body, res));
  guardianRouter.get('/notification-preferences', (req, res) =>
    res.json({ preferences: view('guardian', req.guardian.id) }),
  );
  guardianRouter.put('/notification-preferences', (req, res) => update('guardian', req.guardian.id, req.body, res));
}
