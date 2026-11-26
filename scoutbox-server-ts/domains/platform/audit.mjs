/**
 * The organisation audit feed, for leads only: a read-only merge of other
 * domains' histories. Entries say what happened and who did it, never content.
 * Reason codes are the organisation's own structured vocabulary, so they are
 * shown; the free text beside them is not.
 */

import * as v from 'valibot';
import { encodeCursor } from './paging.mjs';
import { inputOrRefuse, text, wholeNumberText } from './schemas.mjs';

const PAGE_MAX = 50;
const PAGE_DEFAULT = 25;
const CURSOR_MAX = 512;
const AUDIT_QUERY = v.strictObject({
  limit: v.optional(wholeNumberText({ min: 1, max: PAGE_MAX })),
  cursor: v.optional(text(CURSOR_MAX)),
});

/** Room activity types worth an administrator's attention. Chatter is not. */
const ROOM_ACTIONS = new Set([
  'room_created',
  'room_status_changed',
  'room_reopened',
  'room_decision_recorded',
  'room_decision_drafted',
  'room_decision_draft_discarded',
  'room_decision_finalized',
  'room_decision_superseded',
  'room_owner_changed',
  'room_member_assigned',
  'room_priority_changed',
  'room_evidence_requested',
  'room_assessment_assigned',
]);
const BRIEF_ACTIONS = new Set([
  'recruitment_brief_created',
  'recruitment_brief_updated',
  'recruitment_brief_activated',
]);
const WATCHLIST_ACTIONS = new Set(['watchlist_created', 'watchlist_updated', 'watchlist_archived']);
const LEDGER_ACTIONS = new Set(['staff_removed', 'signing', 'released_by_club']);
/** Lifecycle only; goal and action edits stay in the plan's own history. */
const DEVELOPMENT_ACTIONS = new Set(['plan_created', 'plan_archived', 'plan_visibility_changed', 'review_submitted']);
/** Drafting is the author's business until something is sent. */
const CONTACT_ACTIONS = new Set([
  'contact_sent',
  'contact_send_failed',
  'contact_external_recorded',
  'contact_responded',
  'contact_cancelled',
]);

const TRIAL_ACTIONS = new Set([
  'trial_accepted',
  'trial_schedule_proposed',
  'trial_rescheduled',
  'trial_schedule_confirmed',
  'trial_schedule_declined',
  'trial_attendance_recorded',
  'trial_cancelled',
  'trial_completed',
  'trial_evidence_linked',
  'trial_evidence_unlinked',
]);

/** An allowlist of structured, content-free detail keys. */
function safeDetail(action, detail) {
  if (!detail || typeof detail !== 'object') return null;
  const out = {};
  for (const k of [
    'from',
    'to',
    'status',
    'priority',
    'recommendation',
    'version',
    'criteriaChanged',
    'sourceContext',
    'kind',
    'channel',
    'recipientType',
    'code',
    'sessionId',
    'trialSessionId',
    'state',
    'source',
    'revision',
    'sessionCount',
    'material',
    'requiresConfirmation',
    'phase',
    'cancelledBy',
    'attendedSessions',
    'slotId',
    'day',
    'hadReason',
    // Decision detail: never the rationale.
    'outcome',
    'decisionId',
    'supersedes',
    'draftId',
  ]) {
    if (detail[k] !== undefined) out[k] = detail[k];
  }
  if (Array.isArray(detail.reasonCodes)) out.reasonCodes = detail.reasonCodes.slice(0, 10);
  if (typeof detail.note === 'boolean') out.hadNote = detail.note;
  return Object.keys(out).length ? out : null;
}

/**
 * `agencySources` are the agent domains' own audit rows, each `(org, { findPlayer, orgCanSee }) => rows`, read for an
 * agency only. They are handed in so this feed knows their rows' shape and not the agent domains.
 */
export function registerAudit(ctx) {
  const { recruitmentReads, orgRouter, requireLead, findPlayer, orgCanSee, agencySources } = ctx;
  if (!Array.isArray(agencySources) || agencySources.some((f) => typeof f !== 'function'))
    throw new TypeError('registerAudit needs the agency audit sources');
  if (typeof recruitmentReads?.contacts?.forOrg !== 'function')
    throw new TypeError('registerAudit needs recruitmentReads (contacts) from the data layer');
  if (typeof ctx.discoveryReads?.briefs?.historyFeed !== 'function')
    throw new TypeError('registerAudit needs discoveryReads (briefs, watchlists) from the data layer');

  const ROOM_ACTION_LIST = [...ROOM_ACTIONS];
  const CONTACT_ACTION_LIST = [...CONTACT_ACTIONS];
  const TRIAL_ACTION_LIST = [...TRIAL_ACTIONS];
  /** Id breaks ties so rows in the same millisecond keep their order between reads. */
  const newestFirst = (a, b) => b.at - a.at || String(b.id).localeCompare(String(a.id));
  const subjectFor = (org, playerId) => {
    const p = findPlayer(playerId);
    return p && orgCanSee(org, p) ? { playerId: p.id, playerName: p.name } : { playerId: null, playerName: null };
  };

  /**
   * Read a page at a time in SQL: at least `n` entries of each source at or before `atMost`, so the merged page
   * is exact. The player is named only if the organisation may currently see them.
   */
  function recruitmentEntries(org, atMost, n) {
    const rows = [];
    for (const { caseId, playerId, entry: h } of recruitmentReads.cases.roomHistoryFeed(
      org.id,
      ROOM_ACTION_LIST,
      atMost,
      n,
    )) {
      rows.push({
        id: h.id,
        at: h.at,
        action: h.action,
        domain: 'recruitment_room',
        actor: h.byKind === 'org' ? { userId: h.byId, name: h.byName } : null,
        target: { type: 'room', id: caseId, ...subjectFor(org, playerId) },
        detail: safeDetail(h.action, h.detail),
      });
    }
    for (const { contactId, caseId, playerId, entry: h } of recruitmentReads.contacts.historyFeed(
      org.id,
      CONTACT_ACTION_LIST,
      atMost,
      n,
    )) {
      rows.push({
        id: h.id,
        at: h.at,
        action: h.action,
        domain: 'recruitment_contact',
        actor: h.by?.kind === 'org' ? { userId: h.by.userId ?? null, name: h.by.name ?? null } : null,
        target: { type: 'contact', id: contactId, roomId: caseId, ...subjectFor(org, playerId) },
        detail: safeDetail(h.action, h.detail),
      });
    }
    for (const { trialId, caseId, playerId, entry: h } of recruitmentReads.trials.historyFeed(
      org.id,
      TRIAL_ACTION_LIST,
      atMost,
      n,
    )) {
      rows.push({
        id: h.id,
        at: h.at,
        action: h.action,
        domain: 'recruitment_trial',
        actor: h.by?.kind === 'org' ? { userId: h.by.userId ?? null, name: h.by.name ?? null } : null,
        target: { type: 'trial', id: trialId, roomId: caseId ?? null, ...subjectFor(org, playerId) },
        detail: safeDetail(h.action, h.detail),
      });
    }
    return rows;
  }
  const recruitmentCount = (org) =>
    recruitmentReads.cases.roomHistoryCount(org.id, ROOM_ACTION_LIST) +
    recruitmentReads.contacts.historyCount(org.id, CONTACT_ACTION_LIST) +
    recruitmentReads.trials.historyCount(org.id, TRIAL_ACTION_LIST);

  /** The sources read whole rather than paged in SQL. */
  function memoryEntries(org) {
    const rows = [];
    for (const { entry: h, brief } of ctx.discoveryReads.briefs.historyFeed(org.id, [...BRIEF_ACTIONS])) {
      rows.push({
        id: h.id,
        at: h.at,
        action: h.action,
        domain: 'recruitment_brief',
        actor: h.byKind === 'org' ? { userId: h.byId, name: h.byName } : null,
        target: { type: 'brief', id: brief.id, title: brief.title },
        detail: safeDetail(h.action, h.detail),
      });
    }
    // Lifecycle only: membership changes stay in the watchlist's own history.
    for (const { entry: h, watchlist } of ctx.discoveryReads.watchlists.historyFeed(org.id, [...WATCHLIST_ACTIONS])) {
      rows.push({
        id: h.id,
        at: h.at,
        action: h.action,
        domain: 'dynamic_watchlist',
        actor: h.byKind === 'org' ? { userId: h.byId, name: h.byName } : null,
        target: { type: 'watchlist', id: watchlist.id, title: watchlist.name },
        detail: safeDetail(h.action, h.detail),
      });
    }
    // Only plans the organisation owns: a plan a player shared is the player's record.
    for (const { entry: h, plan, review } of ctx.developmentReads.plans.orgFeed(org.id, [...DEVELOPMENT_ACTIONS])) {
      let target;
      if (plan) {
        const p = findPlayer(plan.playerId);
        const subject =
          p && orgCanSee(org, p) ? { playerId: p.id, playerName: p.name } : { playerId: null, playerName: null };
        target = { type: 'development_plan', id: plan.id, title: plan.title, ...subject };
      } else target = { type: 'development_review', id: review.id };
      rows.push({
        id: h.id,
        at: h.at,
        action: h.action,
        domain: 'development',
        actor: h.byKind === 'org' ? { userId: h.byId, name: h.byName } : null,
        target,
        detail: safeDetail(h.action, h.detail),
      });
    }
    if (org.type === 'agency') for (const source of agencySources) rows.push(...source(org, { findPlayer, orgCanSee }));
    for (const l of ctx.safetyReads.ledger.forOrg(org.id, [...LEDGER_ACTIONS])) {
      rows.push({
        id: l.id,
        at: l.ts,
        action: l.type,
        domain: 'organisation',
        actor: l.userId ? { userId: l.userId, name: l.scoutName ?? null } : null,
        target: l.playerId ? { type: 'player', id: l.playerId } : { type: 'organisation', id: org.id },
        detail: null,
      });
    }
    return rows;
  }

  /** The [at, id] of a page's last row, or null. */
  const readCursor = (raw) => {
    if (typeof raw !== 'string' || raw.length > 512) return null;
    let key = null;
    try {
      key = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    return Array.isArray(key) && key.length === 2 && Number.isFinite(key[0]) && typeof key[1] === 'string'
      ? { at: key[0], id: key[1] }
      : null;
  };

  orgRouter.get('/audit', (req, res) => {
    if (!requireLead(req, res)) return;
    const query = inputOrRefuse(res, AUDIT_QUERY, req.query, {
      root: 'query',
      fieldCodes: { limit: 'PAGE_LIMIT_INVALID' },
    });
    if (!query) return;
    const limit = query.limit ? Number(query.limit) : PAGE_DEFAULT;
    const invalid = () =>
      res.status(400).json({
        error: 'AUDIT_CURSOR_INVALID',
        message: 'That page no longer exists — start again from the first page.',
      });
    let after = null;
    if (query.cursor) {
      after = readCursor(query.cursor);
      if (!after) return invalid();
    }
    const memory = memoryEntries(req.org);
    const pool = [...recruitmentEntries(req.org, after ? after.at : null, limit + 1), ...memory];
    // A cursor from another organisation's feed is invalid here.
    if (after && !pool.some((r) => r.at === after.at && r.id === after.id)) return invalid();
    const rest = (after ? pool.filter((r) => newestFirst(r, after) > 0) : pool).sort(newestFirst);
    const page = rest.slice(0, limit);
    const last = page[page.length - 1];
    res.json({
      items: page,
      nextCursor: rest.length > limit ? encodeCursor([last.at, last.id]) : null,
      total: memory.length + recruitmentCount(req.org),
      note: 'Operational history only: what happened and who did it. Notes, comments, decision text and assessments are never shown here.',
    });
  });
}
