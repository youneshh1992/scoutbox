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

import { agentAuditRows } from '../m24/audit.mjs';
import { complianceAuditRows } from '../m25/audit.mjs';

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
  const { db, orgRouter, requireLead, findPlayer, orgCanSee } = ctx;

  function entriesFor(org) {
    const rows = [];
    for (const c of db.recruitmentCases ?? []) {
      if (c.orgId !== org.id || !c.room) continue;
      // The player is named only if the organisation may currently see them.
      const p = findPlayer(c.playerId);
      const subject = p && orgCanSee(org, p) ? { playerId: p.id, playerName: p.name } : { playerId: null, playerName: null };
      for (const h of c.history ?? []) {
        if (!ROOM_ACTIONS.has(h.action)) continue;
        rows.push({
          id: h.id, at: h.at, action: h.action, domain: 'recruitment_room',
          actor: h.byKind === 'org' ? { userId: h.byId, name: h.byName } : null,
          target: { type: 'room', id: c.id, ...subject },
          detail: safeDetail(h.action, h.detail),
        });
      }
    }
    for (const b of db.recruitmentBriefs ?? []) {
      if (b.orgId !== org.id) continue;
      for (const h of b.history ?? []) {
        if (!BRIEF_ACTIONS.has(h.action)) continue;
        rows.push({
          id: h.id, at: h.at, action: h.action, domain: 'recruitment_brief',
          actor: h.byKind === 'org' ? { userId: h.byId, name: h.byName } : null,
          target: { type: 'brief', id: b.id, title: b.title },
          detail: safeDetail(h.action, h.detail),
        });
      }
    }
    // M19: watchlist LIFECYCLE only. Which players entered or left belongs in
    // the watchlist's own history, not in an administrator's audit feed.
    for (const w of db.dynamicWatchlists ?? []) {
      if (w.orgId !== org.id) continue;
      for (const h of w.history ?? []) {
        if (!WATCHLIST_ACTIONS.has(h.action)) continue;
        rows.push({
          id: h.id, at: h.at, action: h.action, domain: 'dynamic_watchlist',
          actor: h.byKind === 'org' ? { userId: h.byId, name: h.byName } : null,
          target: { type: 'watchlist', id: w.id, title: w.name },
          detail: safeDetail(h.action, h.detail),
        });
      }
    }
    // M21: development plans this organisation OWNS. A plan a player shared
    // with the club is the player's record, not the club's administrative
    // history, so it is read in the Hub and never mirrored into this feed.
    for (const plan of db.developmentPlans ?? []) {
      if (plan.owner?.kind !== 'org' || plan.owner.orgId !== org.id) continue;
      const p = findPlayer(plan.playerId);
      const subject = p && orgCanSee(org, p) ? { playerId: p.id, playerName: p.name } : { playerId: null, playerName: null };
      for (const h of plan.history ?? []) {
        if (!DEVELOPMENT_ACTIONS.has(h.action)) continue;
        rows.push({
          id: h.id, at: h.at, action: h.action, domain: 'development',
          actor: h.byKind === 'org' ? { userId: h.byId, name: h.byName } : null,
          target: { type: 'development_plan', id: plan.id, title: plan.title, ...subject },
          detail: safeDetail(h.action, h.detail),
        });
      }
    }
    // Review SUBMISSIONS, from the reviews themselves. What the review says —
    // shared summary or internal note — never reaches this feed (§118#44).
    for (const r of db.developmentReviews ?? []) {
      if (r.orgId !== org.id) continue;
      for (const h of r.history ?? []) {
        if (!DEVELOPMENT_ACTIONS.has(h.action)) continue;
        rows.push({
          id: h.id, at: h.at, action: h.action, domain: 'development',
          actor: h.byKind === 'org' ? { userId: h.byId, name: h.byName } : null,
          target: { type: 'development_review', id: r.id },
          detail: safeDetail(h.action, h.detail),
        });
      }
    }
    // M23 P3: Contact lifecycle. The subject is named only if the organisation
    // may currently see the player; the body, the summary and the reply never
    // reach this feed.
    for (const c of db.recruitmentContacts ?? []) {
      if (!c || c.orgId !== org.id) continue;
      const p = findPlayer(c.playerId);
      const subject = p && orgCanSee(org, p) ? { playerId: p.id, playerName: p.name } : { playerId: null, playerName: null };
      for (const h of c.history ?? []) {
        if (!CONTACT_ACTIONS.has(h?.action)) continue;
        rows.push({
          id: h.id, at: h.at, action: h.action, domain: 'recruitment_contact',
          actor: h.by?.kind === 'org' ? { userId: h.by.userId ?? null, name: h.by.name ?? null } : null,
          target: { type: 'contact', id: c.id, roomId: c.caseId, ...subject },
          detail: safeDetail(h.action, h.detail),
        });
      }
    }
    // M23 P4B: Trial history — the operational record of what happened, for
    // the club that ran it. Subject named only where the org may see them.
    for (const t of db.trials ?? []) {
      if (!t || t.orgId !== org.id || !Array.isArray(t.history)) continue;
      const p = findPlayer(t.playerId);
      const subject = p && orgCanSee(org, p) ? { playerId: p.id, playerName: p.name } : { playerId: null, playerName: null };
      for (const h of t.history) {
        if (!TRIAL_ACTIONS.has(h?.action)) continue;
        rows.push({
          id: h.id, at: h.at, action: h.action, domain: 'recruitment_trial',
          actor: h.by?.kind === 'org' ? { userId: h.by.userId ?? null, name: h.by.name ?? null } : null,
          target: { type: 'trial', id: t.id, roomId: t.caseId ?? null, ...subject },
          detail: safeDetail(h.action, h.detail),
        });
      }
    }
    // M23 P5.6B: the Agent domain — profile, affiliation and relationship
    // lifecycle for an agency organisation. Same rules: subject named only
    // where the org may see them; no reference numbers, no reason text.
    if (org.type === 'agency') rows.push(...agentAuditRows(db, org, { findPlayer, orgCanSee }));
    // M23 P5.6C: the compliance domain — contexts, consents and reviews, content-free.
    if (org.type === 'agency') rows.push(...complianceAuditRows(db, org));
    for (const l of db.ledger ?? []) {
      if (l.orgId !== org.id || !LEDGER_ACTIONS.has(l.type)) continue;
      rows.push({
        id: l.id, at: l.ts, action: l.type, domain: 'organisation',
        actor: l.userId ? { userId: l.userId, name: l.scoutName ?? null } : null,
        target: l.playerId ? { type: 'player', id: l.playerId } : { type: 'organisation', id: org.id },
        detail: null,
      });
    }
    // Newest first, id as the tie-break so two rows in the same millisecond
    // keep their order between reads.
    rows.sort((a, b) => (b.at - a.at) || String(b.id).localeCompare(String(a.id)));
    return rows;
  }

  orgRouter.get('/audit', (req, res) => {
    if (!requireLead(req, res)) return;
    const limit = Math.min(PAGE_MAX, Math.max(1, Number(req.query.limit) || PAGE_DEFAULT));
    const all = entriesFor(req.org);
    let start = 0;
    if (req.query.cursor) {
      const idx = all.findIndex((r) => r.id === String(req.query.cursor));
      if (idx < 0) return res.status(400).json({ error: 'AUDIT_CURSOR_INVALID', message: 'That page no longer exists — start again from the first page.' });
      start = idx + 1;
    }
    const page = all.slice(start, start + limit);
    res.json({
      items: page,
      nextCursor: start + limit < all.length ? page[page.length - 1].id : null,
      total: all.length,
      note: 'Operational history only: what happened and who did it. Notes, comments, decision text and assessments are never shown here.',
    });
  });
}
