/**
 * M18.2 — the organisation audit view.
 *
 * Nothing here is new history. Recruitment Rooms have carried an append-only
 * `history` since M17, Recruitment Briefs since M18, and staff removal has been
 * a Discovery Ledger row since M12. What an organisation's leads could not do
 * was read them together, in order, without opening each record. This route
 * is a read-only projection over those three sources.
 *
 * Three rules, in priority order:
 *
 *   1. Leads and directors only. A scout sees their own Rooms' activity in the
 *      Room; the organisation-wide view is administrative. Players, guardians
 *      and every other organisation get exactly what a route that does not
 *      exist would give them.
 *   2. No content. An entry says WHAT happened and WHO did it. It never carries
 *      a note body, a comment body, a decision note, an assessment or a
 *      player's private field. Reason codes are structured vocabulary the
 *      organisation itself chose, so they are shown; the free text next to
 *      them is not.
 *   3. Bounded. Cursor pagination, at most 50 rows per page, newest first,
 *      stable across reads (time, then id).
 */

import { agentAuditRows } from '../agents/core/audit.mjs';
import { encodeCursor } from './paging.mjs';
import { complianceAuditRows } from '../agents/compliance/audit.mjs';

const PAGE_MAX = 50;
const PAGE_DEFAULT = 25;

/** Room activity types worth an administrator's attention. Chatter is not. */
const ROOM_ACTIONS = new Set([
  'room_created', 'room_status_changed', 'room_reopened', 'room_decision_recorded',
  // M23 P5 — the formal decision: drafted, discarded, finalized, superseded.
  'room_decision_drafted', 'room_decision_draft_discarded', 'room_decision_finalized', 'room_decision_superseded',
  'room_owner_changed', 'room_member_assigned', 'room_priority_changed',
  'room_evidence_requested', 'room_assessment_assigned',
]);
const BRIEF_ACTIONS = new Set([
  'recruitment_brief_created', 'recruitment_brief_updated', 'recruitment_brief_activated',
]);
const WATCHLIST_ACTIONS = new Set(['watchlist_created', 'watchlist_updated', 'watchlist_archived']);
const LEDGER_ACTIONS = new Set(['staff_removed', 'signing', 'released_by_club']);
/**
 * M21 §88: a plan's LIFECYCLE, and nothing else. Every action checkbox and
 * every goal edit belongs in that plan's own history, which is richer and is
 * read by the people working the plan (§89). Flooding an administrator's feed
 * with them would bury the four events an administrator actually needs.
 */
const DEVELOPMENT_ACTIONS = new Set([
  'plan_created', 'plan_archived', 'plan_visibility_changed', 'review_submitted',
]);
/**
 * M23 P3: what happened to a Contact, never what it said. Drafting and
 * editing are the author's business until something leaves; sending,
 * failing, recording, cancelling and the recipient's answer are the
 * administrator's.
 */
const CONTACT_ACTIONS = new Set([
  'contact_sent', 'contact_send_failed', 'contact_external_recorded', 'contact_responded', 'contact_cancelled',
]);

/**
 * M23 P4B: what happened to a Trial — accepted, scheduled, confirmed,
 * declined, attended, cancelled, completed, evidence linked or unlinked.
 * Never the instructions, the venue address, a note or the family's contact.
 */
const TRIAL_ACTIONS = new Set([
  'trial_accepted', 'trial_schedule_proposed', 'trial_rescheduled', 'trial_schedule_confirmed', 'trial_schedule_declined',
  'trial_attendance_recorded', 'trial_cancelled', 'trial_completed', 'trial_evidence_linked', 'trial_evidence_unlinked',
]);

/** The structured, content-free summary of one history detail. */
function safeDetail(action, detail) {
  if (!detail || typeof detail !== 'object') return null;
  const out = {};
  for (const k of ['from', 'to', 'status', 'priority', 'recommendation', 'version', 'criteriaChanged', 'sourceContext', 'kind', 'channel', 'recipientType', 'code',
    // P4B Trial detail: ids, states, counts and flags only.
    'sessionId', 'trialSessionId', 'state', 'source', 'revision', 'sessionCount', 'material', 'requiresConfirmation', 'phase', 'cancelledBy', 'attendedSessions', 'slotId', 'day', 'hadReason',
    // P5 Decision detail: ids and the outcome word only — never the rationale.
    'outcome', 'decisionId', 'supersedes', 'draftId']) {
    if (detail[k] !== undefined) out[k] = detail[k];
  }
  if (Array.isArray(detail.reasonCodes)) out.reasonCodes = detail.reasonCodes.slice(0, 10);
  // `note: true|false` is whether a note was written — never the note.
  if (typeof detail.note === 'boolean') out.hadNote = detail.note;
  return Object.keys(out).length ? out : null;
}

export function registerAudit(ctx) {
  const { db, recruitmentReads, orgRouter, requireLead, findPlayer, orgCanSee } = ctx;
  if (typeof recruitmentReads?.contacts?.forOrg !== 'function') throw new TypeError('registerAudit needs recruitmentReads (contacts) from the data layer');
  if (typeof ctx.discoveryReads?.briefs?.historyFeed !== 'function') throw new TypeError('registerAudit needs discoveryReads (briefs, watchlists) from the data layer');

  const ROOM_ACTION_LIST = [...ROOM_ACTIONS]; const CONTACT_ACTION_LIST = [...CONTACT_ACTIONS]; const TRIAL_ACTION_LIST = [...TRIAL_ACTIONS];
  /** Newest first, id as the tie-break so two rows in the same millisecond keep their order between reads. */
  const newestFirst = (a, b) => (b.at - a.at) || String(b.id).localeCompare(String(a.id));
  const subjectFor = (org, playerId) => { const p = findPlayer(playerId); return p && orgCanSee(org, p) ? { playerId: p.id, playerName: p.name } : { playerId: null, playerName: null }; };

  /**
   * The recruitment sources, read in SQL a page at a time (§4.3 step 4): the Room, Contact and Trial history entries
   * at or before `atMost`, at least `n` of each source past any at `atMost` itself (repositories/database.mjs
   * `newestHistory`), so the merged page is exact. The player is named only if the organisation may currently see them.
   */
  function recruitmentEntries(org, atMost, n) {
    const rows = [];
    for (const { caseId, playerId, entry: h } of recruitmentReads.cases.roomHistoryFeed(org.id, ROOM_ACTION_LIST, atMost, n)) {
      rows.push({
        id: h.id, at: h.at, action: h.action, domain: 'recruitment_room',
        actor: h.byKind === 'org' ? { userId: h.byId, name: h.byName } : null,
        target: { type: 'room', id: caseId, ...subjectFor(org, playerId) },
        detail: safeDetail(h.action, h.detail),
      });
    }
    // M23 P3: Contact lifecycle. The body, the summary and the reply never reach this feed.
    for (const { contactId, caseId, playerId, entry: h } of recruitmentReads.contacts.historyFeed(org.id, CONTACT_ACTION_LIST, atMost, n)) {
      rows.push({
        id: h.id, at: h.at, action: h.action, domain: 'recruitment_contact',
        actor: h.by?.kind === 'org' ? { userId: h.by.userId ?? null, name: h.by.name ?? null } : null,
        target: { type: 'contact', id: contactId, roomId: caseId, ...subjectFor(org, playerId) },
        detail: safeDetail(h.action, h.detail),
      });
    }
    // M23 P4B: Trial history — the operational record of what happened, for the club that ran it.
    for (const { trialId, caseId, playerId, entry: h } of recruitmentReads.trials.historyFeed(org.id, TRIAL_ACTION_LIST, atMost, n)) {
      rows.push({
        id: h.id, at: h.at, action: h.action, domain: 'recruitment_trial',
        actor: h.by?.kind === 'org' ? { userId: h.by.userId ?? null, name: h.by.name ?? null } : null,
        target: { type: 'trial', id: trialId, roomId: caseId ?? null, ...subjectFor(org, playerId) },
        detail: safeDetail(h.action, h.detail),
      });
    }
    return rows;
  }
  const recruitmentCount = (org) => recruitmentReads.cases.roomHistoryCount(org.id, ROOM_ACTION_LIST)
    + recruitmentReads.contacts.historyCount(org.id, CONTACT_ACTION_LIST) + recruitmentReads.trials.historyCount(org.id, TRIAL_ACTION_LIST);

  /** The sources read whole and merged (briefs, watchlists, development, agents, compliance, the ledger). */
  function memoryEntries(org) {
    const rows = [];
    // S12c: the briefs' and the watchlists' trails come from SQL (discoveryReads), the organisation's own only.
    for (const { entry: h, brief } of ctx.discoveryReads.briefs.historyFeed(org.id, [...BRIEF_ACTIONS])) {
      rows.push({
        id: h.id, at: h.at, action: h.action, domain: 'recruitment_brief',
        actor: h.byKind === 'org' ? { userId: h.byId, name: h.byName } : null,
        target: { type: 'brief', id: brief.id, title: brief.title },
        detail: safeDetail(h.action, h.detail),
      });
    }
    // M19: watchlist LIFECYCLE only. Which players entered or left belongs in
    // the watchlist's own history, not in an administrator's audit feed.
    for (const { entry: h, watchlist } of ctx.discoveryReads.watchlists.historyFeed(org.id, [...WATCHLIST_ACTIONS])) {
      rows.push({
        id: h.id, at: h.at, action: h.action, domain: 'dynamic_watchlist',
        actor: h.byKind === 'org' ? { userId: h.byId, name: h.byName } : null,
        target: { type: 'watchlist', id: watchlist.id, title: watchlist.name },
        detail: safeDetail(h.action, h.detail),
      });
    }
    // M21: development plans this organisation OWNS. A plan a player shared
    // with the club is the player's record, not the club's administrative
    // history, so it is read in the Hub and never mirrored into this feed.
    // S12a: both read through SQL (developmentReads.plans.orgFeed), the plan named only where the org may see its player.
    for (const { entry: h, plan, review } of ctx.developmentReads.plans.orgFeed(org.id, [...DEVELOPMENT_ACTIONS])) {
      let target;
      if (plan) {
        const p = findPlayer(plan.playerId);
        const subject = p && orgCanSee(org, p) ? { playerId: p.id, playerName: p.name } : { playerId: null, playerName: null };
        target = { type: 'development_plan', id: plan.id, title: plan.title, ...subject };
      } else target = { type: 'development_review', id: review.id };
      rows.push({
        id: h.id, at: h.at, action: h.action, domain: 'development',
        actor: h.byKind === 'org' ? { userId: h.byId, name: h.byName } : null,
        target,
        detail: safeDetail(h.action, h.detail),
      });
    }
    // M23 P5.6B: the Agent domain — profile, affiliation and relationship
    // lifecycle for an agency organisation. Same rules: subject named only
    // where the org may see them; no reference numbers, no reason text.
    if (org.type === 'agency') rows.push(...agentAuditRows(ctx.agentReads, org, { findPlayer, orgCanSee }));
    // M23 P5.6C: the compliance domain — contexts, consents and reviews, content-free.
    if (org.type === 'agency') rows.push(...complianceAuditRows(ctx.complianceReads, org));
    for (const l of db.ledger ?? []) {
      if (l.orgId !== org.id || !LEDGER_ACTIONS.has(l.type)) continue;
      rows.push({
        id: l.id, at: l.ts, action: l.type, domain: 'organisation',
        actor: l.userId ? { userId: l.userId, name: l.scoutName ?? null } : null,
        target: l.playerId ? { type: 'player', id: l.playerId } : { type: 'organisation', id: org.id },
        detail: null,
      });
    }
    return rows;
  }

  /** A cursor is the [at, id] of the last row of a page, opaque to clients; anything else is null. */
  const readCursor = (raw) => {
    if (typeof raw !== 'string' || raw.length > 512) return null;
    let key = null;
    try { key = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { return null; }
    return Array.isArray(key) && key.length === 2 && Number.isFinite(key[0]) && typeof key[1] === 'string' ? { at: key[0], id: key[1] } : null;
  };

  orgRouter.get('/audit', (req, res) => {
    if (!requireLead(req, res)) return;
    const limit = Math.min(PAGE_MAX, Math.max(1, Number(req.query.limit) || PAGE_DEFAULT));
    const invalid = () => res.status(400).json({ error: 'AUDIT_CURSOR_INVALID', message: 'That page no longer exists — start again from the first page.' });
    let after = null;
    if (req.query.cursor) { after = readCursor(req.query.cursor); if (!after) return invalid(); }
    const memory = memoryEntries(req.org);
    const pool = [...recruitmentEntries(req.org, after ? after.at : null, limit + 1), ...memory];
    // A cursor names a row of this organisation's feed (a cursor from another organisation's page is not one).
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
