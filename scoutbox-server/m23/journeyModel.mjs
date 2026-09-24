/**
 * M23 P8 — the recruitment journey MODEL: pure functions over records that
 * someone else owns.
 *
 * Nothing here reads a database, writes a field or keeps state. The projector
 * (journey.mjs) gathers a case's canonical records and hands them in; this
 * module answers the questions P8 asks of them:
 *
 *   - which canonical STAGE the case is at (a workflow description derived
 *     from the frozen 18-state lifecycle plus the facts around it — never a
 *     nineteenth lifecycle state, never stored)
 *   - which stages have been COMPLETED, and on what basis
 *   - which resource is CURRENT when several exist (one deterministic rule per
 *     kind, so no app re-derives it differently — the P7.1 Agent bug)
 *   - the NEXT ACTION the server derives (clients never manufacture one)
 *   - whether the journey is CANONICAL, LEGACY, PARTIALLY CANONICAL or in an
 *     INTEGRITY ERROR, and why
 *   - which timeline events each audience may see
 *
 * THE DIRECTION OF TRUTH (§2). Evidence informs assessment; assessment informs
 * discussion; discussion informs an explicit human decision; a decision is not
 * an Offer; an Offer is not an acceptance; an acceptance is not a signing; a
 * signing in progress is not `signed`. Every function here reads those
 * boundaries and none of them crosses one: a next action is a suggestion of
 * the ONE thing a person could do now, never an act the server performs.
 *
 * NO SCORE. There is no readiness number, probability or progress percentage.
 */

import { ROOM_STATUSES, TERMINAL_ROOM_STATUSES } from '../m17/shared.mjs';
import { LIFECYCLE_ACTIONS, LIFECYCLE_REOPENABLE } from './lifecycle.mjs';
import { CONTACT_EVIDENCE_STATUSES } from './contact.mjs';
import { deriveWorkflowState } from './trial.mjs';
import { liveRevision, effectiveRevisionStatus, currentRevision as offerCurrentRevision, offerStatus, liveStatus as offerLiveStatus } from '../m28/offer.mjs';
import { effectiveStatus as signingEffectiveStatus, currentRevision as signingCurrentRevision, isLive as signingIsLive } from '../m29/signing.mjs';

export const JOURNEY_POLICY_VERSION = 1;

// ---------------------------------------------------------------- stages

/**
 * The canonical journey vocabulary. `discovery` precedes a case (a player
 * seen in search or matched) and never appears on one; the pipeline stages
 * are the ones a case walks; `paused` and `ended` describe a case that is
 * not walking. This is a DESCRIPTION of where the lifecycle is, mapped from
 * the frozen 18 states; it adds no state to them (§8).
 */
export const JOURNEY_STAGES = Object.freeze([
  'discovery', 'watching', 'review', 'contact', 'trial', 'assessment', 'decision', 'offer', 'acceptance', 'signing', 'signed', 'paused', 'ended',
]);
/** The stages a case COMPLETES, in order. `completedStages` is a subset of these. */
export const PIPELINE_STAGES = Object.freeze(['watching', 'review', 'contact', 'trial', 'assessment', 'decision', 'offer', 'acceptance', 'signing', 'signed']);

const STAGE_OF_STATUS = Object.freeze(Object.assign(Object.create(null), {
  watching: 'watching',
  under_review: 'review', shortlisted: 'review', priority: 'review',
  contact_planned: 'contact', contacted: 'contact',
  trial_requested: 'trial', trial_scheduled: 'trial',
  trial_completed: 'assessment', // refined by the facts: assessed → decision
  offer_consideration: 'offer', offer_made: 'offer', offer_declined: 'offer',
  offer_accepted: 'acceptance',
  signed: 'signed',
  on_hold: 'paused',
  withdrawn: 'ended', archived: 'ended', closed: 'ended',
}));

/**
 * The canonical stage for a lifecycle status, refined by two facts the
 * lifecycle does not carry: after a completed trial the case is at
 * `assessment` until a submitted assessment exists, then at `decision` until
 * a formal decision stands; after an acceptance it is at `signing` once a
 * package was opened. Unknown status → null (corruption, named elsewhere).
 */
export function canonicalStageFor(status, facts = {}) {
  const base = STAGE_OF_STATUS[status];
  if (!base) return null;
  if (status === 'trial_completed') return facts.assessed ? 'decision' : 'assessment';
  if (status === 'offer_accepted') return facts.signingOpened ? 'signing' : 'acceptance';
  return base;
}

// ------------------------------------------------------- deterministic order

/** Newest first: a later instant wins; equal instants fall back to the id, descending, so two reads agree. */
const newestFirst = (atOf) => (a, b) => ((Number(atOf(b)) || 0) - (Number(atOf(a)) || 0)) || String(b?.id ?? '').localeCompare(String(a?.id ?? ''));
const latest = (rows, atOf) => (rows.length ? rows.slice().sort(newestFirst(atOf))[0] : null);

// ------------------------------------------------- current-resource selection

/**
 * THE current Contact of a case (§53/§54). Order of preference, each tier
 * newest first:
 *   1. delivered and awaiting a response (the live conversation)
 *   2. responded or recorded (the last completed approach)
 *   3. a draft (something the club is preparing)
 *   4. failed
 * Cancelled records are never current. Returns null when nothing qualifies.
 */
export function currentContactForCase(contacts) {
  const rows = (contacts ?? []).filter((c) => c && c.status !== 'cancelled');
  const tier = (pred, atOf) => latest(rows.filter(pred), atOf);
  return tier((c) => c.status === 'delivered', (c) => c.deliveredAt ?? c.createdAt)
    ?? tier((c) => c.status === 'responded' || c.status === 'recorded', (c) => c.respondedAt ?? c.occurredAt ?? c.recordedAt ?? c.deliveredAt ?? c.createdAt)
    ?? tier((c) => c.status === 'draft', (c) => c.updatedAt ?? c.createdAt)
    ?? tier((c) => c.status === 'failed', (c) => c.failedAt ?? c.createdAt);
}

/**
 * THE current Trial of a case: a live one (accepted or scheduled) over a
 * completed one over a cancelled one over a legacy acceptance, newest first
 * within each tier. A pending invitation has no Trial yet; the projector
 * reports the request separately.
 */
export function currentTrialForCase(trials) {
  const rows = (trials ?? []).filter(Boolean);
  const st = (t) => deriveWorkflowState(t);
  const tier = (pred, atOf) => latest(rows.filter(pred), atOf);
  return tier((t) => ['accepted', 'scheduled'].includes(st(t)), (t) => t.schedule?.confirmedAt ?? t.acceptedAt)
    ?? tier((t) => st(t) === 'completed', (t) => t.completion?.at ?? t.acceptedAt)
    ?? tier((t) => st(t) === 'cancelled', (t) => t.completion?.at ?? t.acceptedAt)
    ?? tier((t) => st(t) === 'legacy_accepted', (t) => t.acceptedAt);
}

/** THE current assessment: the latest submitted one, else the latest draft. */
export function currentAssessmentForCase(assessments) {
  const rows = (assessments ?? []).filter(Boolean);
  return latest(rows.filter((a) => a.state !== 'draft'), (a) => a.submittedAt ?? a.createdAt)
    ?? latest(rows.filter((a) => a.state === 'draft'), (a) => a.updatedAt ?? a.createdAt);
}

/** THE current decision: the formal chain head (nothing supersedes it), else the advisory head. Never a draft. */
export function currentDecisionForCase(decisions) {
  const rows = (decisions ?? []).filter((d) => d && !d.supersededById && d.state !== 'draft');
  const oldestLast = (atOf) => (a, b) => ((Number(atOf(a)) || 0) - (Number(atOf(b)) || 0)) || String(a.id).localeCompare(String(b.id));
  const formal = rows.filter((d) => d.kind === 'formal').sort(oldestLast((d) => d.createdAt));
  if (formal.length) return formal[formal.length - 1];
  const advisory = rows.filter((d) => d.kind !== 'formal').sort(oldestLast((d) => d.createdAt));
  return advisory.length ? advisory[advisory.length - 1] : null;
}

/**
 * THE current Offer of a case, with the revision that matters to the reader:
 *   1. a live Offer (a DRAFT or ISSUED current revision) — the club's working
 *      Offer; at most one exists by the domain's own rule
 *   2. an ACCEPTED Offer, newest first (the one a signing hangs off)
 *   3. the newest Offer of any other status (declined, withdrawn, expired)
 * The `revision` is the LIVE revision (what the recipient was sent) when one
 * exists, else the current (draft) revision.
 */
export function currentOfferForCase(offers, now) {
  const rows = (offers ?? []).filter(Boolean);
  const st = (o) => offerStatus(o, now);
  const tier = (pred) => latest(rows.filter(pred), (o) => o.updatedAt ?? o.createdAt);
  const offer = tier((o) => ['DRAFT', 'ISSUED'].includes(st(o))) ?? tier((o) => st(o) === 'ACCEPTED') ?? tier(() => true);
  if (!offer) return null;
  const live = liveRevision(offer);
  const revision = live ?? offerCurrentRevision(offer);
  return { offer, revision, status: st(offer), liveStatus: offerLiveStatus(offer, now) };
}

/**
 * THE current signing package over an Offer (or over a case): a live package
 * (DRAFT, READY, IN_PROGRESS at `now`) over a COMPLETED one over the newest
 * terminal one. This is the rule the Agent app got wrong in P7.1 (an expired
 * package masked a live one); it now lives in one place.
 */
export function currentSigningForOffer(packages, now) {
  const rows = (packages ?? []).filter(Boolean);
  const tier = (pred) => latest(rows.filter(pred), (p) => p.createdAt);
  return tier((p) => signingIsLive(p, now)) ?? tier((p) => signingEffectiveStatus(p, now) === 'COMPLETED') ?? tier(() => true);
}
export const currentSigningForCase = currentSigningForOffer;

// ------------------------------------------------------- completed stages

const isFiniteAt = (v) => Number.isFinite(Number(v)) && Number(v) > 0;
const firstReach = (history, statuses) => {
  let best = null;
  for (const h of history ?? []) {
    if (!h || (h.action !== 'room_status_changed' && h.action !== 'room_created')) continue;
    const to = h.action === 'room_created' ? h.detail?.status : h.detail?.to;
    if (!statuses.includes(to)) continue;
    if (best === null || (isFiniteAt(h.at) && h.at < best)) best = isFiniteAt(h.at) ? h.at : best;
  }
  return best;
};

/**
 * Which pipeline stages this case has completed, each with the BASIS that
 * proves it: `canonical` (a record in the domain store), `lifecycle` (the
 * case's own history reached the state, with no canonical record behind it —
 * a legacy fact, reported as such and never dressed up), or absent.
 *
 * @param {object} facts  see journey.mjs `journeyFacts` — the canonical
 *   records already scoped to this case, plus the case history.
 */
export function completedStagesFor(facts) {
  const out = [];
  const push = (stage, basis, at, ref) => out.push({ stage, basis, at: isFiniteAt(at) ? Number(at) : null, ...ref });
  const h = facts.history ?? [];
  // watching: the case exists (its room was opened).
  const opened = firstReach(h, ROOM_STATUSES) ?? facts.createdAt ?? null;
  push('watching', 'lifecycle', opened, {});
  // review: any status past watching was ever reached.
  const reviewAt = firstReach(h, ROOM_STATUSES.filter((s) => s !== 'watching' && s !== 'on_hold' && !TERMINAL_ROOM_STATUSES.includes(s)));
  if (reviewAt !== null) push('review', 'lifecycle', reviewAt, {});
  // contact: a canonical evidence-bearing Contact, else the lifecycle reached contacted.
  const evidenceContact = latestBy(facts.contacts, (c) => CONTACT_EVIDENCE_STATUSES.includes(c.status) && !c.cancelledAt, (c) => c.deliveredAt ?? c.occurredAt ?? c.recordedAt);
  if (evidenceContact) push('contact', 'canonical', evidenceContact.deliveredAt ?? evidenceContact.occurredAt ?? evidenceContact.recordedAt, { contactId: evidenceContact.id });
  else { const at = firstReach(h, ['contacted']); if (at !== null) push('contact', 'lifecycle', at, {}); }
  // trial: a completed canonical Trial, else the lifecycle reached trial_completed.
  const doneTrial = latestBy(facts.trials, (t) => deriveWorkflowState(t) === 'completed', (t) => t.completion?.at);
  if (doneTrial) push('trial', 'canonical', doneTrial.completion?.at, { trialId: doneTrial.id });
  else { const at = firstReach(h, ['trial_completed']); if (at !== null) push('trial', 'lifecycle', at, {}); }
  // assessment: a submitted assessment by this club of this player.
  const assessed = latestBy(facts.assessments, (a) => a.state !== 'draft', (a) => a.submittedAt ?? a.createdAt);
  if (assessed) push('assessment', 'canonical', assessed.submittedAt ?? assessed.createdAt, { assessmentId: assessed.id });
  // decision: a finalized formal decision (any outcome) that still stands.
  const decided = (facts.decisions ?? []).filter((d) => d && d.kind === 'formal' && d.state !== 'draft' && !d.supersededById);
  const decision = decided.length ? decided.slice().sort(newestFirst((d) => d.createdAt))[0] : null;
  if (decision) push('decision', 'canonical', decision.createdAt, { decisionId: decision.id });
  else { const at = firstReach(h, ['offer_consideration']); if (at !== null) push('decision', 'lifecycle', at, {}); }
  // offer: an Offer whose live revision was issued (issued, answered, expired or withdrawn after issue all count as "an Offer was made").
  const issued = (facts.offers ?? []).map((o) => ({ o, r: liveRevision(o) })).filter((x) => x.r);
  const firstIssued = issued.length ? issued.slice().sort((a, b) => (Number(a.r.issuedAt) || 0) - (Number(b.r.issuedAt) || 0))[0] : null;
  if (firstIssued) push('offer', 'canonical', firstIssued.r.issuedAt, { offerId: firstIssued.o.id, offerRevisionId: firstIssued.r.id });
  else { const at = firstReach(h, ['offer_made']); if (at !== null) push('offer', 'lifecycle', at, {}); }
  // acceptance: an ACCEPTED live revision.
  const accepted = issued.filter((x) => effectiveRevisionStatus(x.r, facts.now) === 'ACCEPTED').sort((a, b) => (Number(a.r.respondedAt) || 0) - (Number(b.r.respondedAt) || 0))[0] ?? null;
  if (accepted) push('acceptance', 'canonical', accepted.r.respondedAt, { offerId: accepted.o.id, offerRevisionId: accepted.r.id });
  else { const at = firstReach(h, ['offer_accepted']); if (at !== null) push('acceptance', 'lifecycle', at, {}); }
  // signing: a COMPLETED package.
  const completedPkg = latestBy(facts.packages, (p) => signingEffectiveStatus(p, facts.now) === 'COMPLETED', (p) => p.completion?.completedAt);
  if (completedPkg) push('signing', 'canonical', completedPkg.completion?.completedAt, { signingPackageId: completedPkg.id, completedSigningId: completedPkg.completion?.signingId ?? null });
  // signed: the lifecycle is (or was) at signed, proved by a supporting signing row when one exists.
  const signedAt = firstReach(h, ['signed']);
  if (signedAt !== null || facts.status === 'signed') {
    const row = facts.signingRow ?? null;
    push('signed', row ? 'canonical' : 'lifecycle', signedAt ?? row?.ts ?? null, row ? { completedSigningId: row.id } : {});
  }
  return out;
}

function latestBy(rows, pred, atOf) {
  return latest((rows ?? []).filter((r) => r && pred(r)), atOf);
}

// ------------------------------------------------------------ next action

/**
 * Every next-action code the server can derive, with the stage it belongs to,
 * whether it is a CLUB act or something the club is WAITING on, the Room tab
 * it points to and, where the act IS a lifecycle action, that action's name
 * (so the permission rule is the lifecycle's own).
 */
export const NEXT_ACTIONS = Object.freeze(Object.assign(Object.create(null), {
  REVIEW_PLAYER:            { stage: 'watching',   kind: 'club',  tab: 'overview',    lifecycleAction: 'startReview' },
  DECIDE_APPROACH:          { stage: 'review',     kind: 'club',  tab: 'overview',    lifecycleAction: 'planContact' },
  SEND_CONTACT:             { stage: 'contact',    kind: 'club',  tab: 'contact',     permission: 'contact_write' },
  AWAIT_CONTACT_RESPONSE:   { stage: 'contact',    kind: 'await', tab: 'contact' },
  CONTINUE_EVALUATION:      { stage: 'contact',    kind: 'club',  tab: 'overview',    lifecycleAction: 'shortlist' },
  AWAIT_TRIAL_RESPONSE:     { stage: 'trial',      kind: 'await', tab: 'trial' },
  CONDUCT_TRIAL:            { stage: 'trial',      kind: 'club',  tab: 'trial',       permission: 'trial_write' },
  COMPLETE_TRIAL:           { stage: 'trial',      kind: 'club',  tab: 'trial',       permission: 'trial_write' },
  COMPLETE_ASSESSMENT:      { stage: 'assessment', kind: 'club',  tab: 'assessments', permission: 'assess' },
  RECORD_DECISION:          { stage: 'decision',   kind: 'club',  tab: 'decision',    permission: 'decide' },
  PREPARE_OFFER:            { stage: 'offer',      kind: 'club',  tab: 'offer',       permission: 'offer_write' },
  ISSUE_OFFER:              { stage: 'offer',      kind: 'club',  tab: 'offer',       permission: 'offer_write' },
  AWAIT_OFFER_RESPONSE:     { stage: 'offer',      kind: 'await', tab: 'offer' },
  REVISE_OR_WITHDRAW_OFFER: { stage: 'offer',      kind: 'club',  tab: 'offer',       permission: 'offer_write' },
  REVIEW_DECLINED_OFFER:    { stage: 'offer',      kind: 'club',  tab: 'offer',       lifecycleAction: 'considerOffer' },
  START_SIGNING:            { stage: 'acceptance', kind: 'club',  tab: 'signing',     permission: 'signing_manage' },
  PRESENT_SIGNING:          { stage: 'signing',    kind: 'club',  tab: 'signing',     permission: 'signing_manage' },
  SIGN_FOR_CLUB:            { stage: 'signing',    kind: 'club',  tab: 'signing',     permission: 'signing_lead' },
  AWAIT_RECIPIENT_SIGNATURE:{ stage: 'signing',    kind: 'await', tab: 'signing' },
  COMPLETE_SIGNING:         { stage: 'signing',    kind: 'club',  tab: 'signing',     permission: 'signing_lead' },
  RECRUITMENT_COMPLETE:     { stage: 'signed',     kind: 'none',  tab: 'signing' },
  RESUME_CASE:              { stage: 'paused',     kind: 'club',  tab: 'overview',    lifecycleAction: 'resumeCase' },
  CASE_ENDED:               { stage: 'ended',      kind: 'none',  tab: 'overview' },
  STATE_UNKNOWN:            { stage: null,         kind: 'none',  tab: 'overview' },
}));
export const NEXT_ACTION_CODES = Object.freeze(Object.keys(NEXT_ACTIONS));

/** Room-role rank, the same ladder m17/shared.mjs and lifecycle.mjs use. */
const ROLE_RANK = { viewer: 0, contributor: 1, room_lead: 2, recruitment_admin: 3 };
/** The role each non-lifecycle permission needs (the domain routes remain the authority; this only says whether to offer the act). */
const PERMISSION_MIN_ROLE = Object.freeze({ contact_write: 'room_lead', trial_write: 'room_lead', assess: 'contributor', decide: 'room_lead', offer_write: 'room_lead', signing_manage: 'room_lead', signing_lead: 'recruitment_admin' });
const rankOf = (role) => ROLE_RANK[role] ?? -1;

/**
 * THE next action (§7). Derived from the lifecycle status and the current
 * resources; returns the code, the stage, the kind, the Room tab, the
 * resource ids the act concerns and whether THIS viewer may take it. A
 * `blockedBy` list names why an otherwise-due act cannot be taken (a block,
 * a removed subject); it never invents an act to get past them.
 *
 * @param {object} p
 *   status, role, isLead, now, blocked, subjectRemoved,
 *   contact (current), trial (current), trialRequest (pending invitation),
 *   assessed (bool), decision (current formal head), offer ({offer, revision, status, liveStatus} | null),
 *   signing (current package | null), signingRow (db.signings row | null)
 */
export function nextActionFor(p) {
  const { status, now = Date.now() } = p;
  const pick = (code, refs = {}) => finish(code, refs, p);
  if (!ROOM_STATUSES.includes(status)) return pick('STATE_UNKNOWN');
  if (TERMINAL_ROOM_STATUSES.includes(status) && status !== 'signed') return pick('CASE_ENDED');
  switch (status) {
    case 'signed': return pick('RECRUITMENT_COMPLETE', { completedSigningId: p.signingRow?.id ?? p.signing?.completion?.signingId ?? null, signingPackageId: p.signing?.id ?? null });
    case 'on_hold': return pick('RESUME_CASE');
    case 'watching': return pick('REVIEW_PLAYER');
    case 'under_review': case 'shortlisted': case 'priority':
      if (p.assessed && !p.decision) return pick('RECORD_DECISION');
      return pick('DECIDE_APPROACH');
    case 'contact_planned': return pick('SEND_CONTACT', { contactId: p.contact?.status === 'draft' ? p.contact.id : null });
    case 'contacted':
      if (p.contact?.status === 'delivered') return pick('AWAIT_CONTACT_RESPONSE', { contactId: p.contact.id });
      return pick('CONTINUE_EVALUATION', { contactId: p.contact?.id ?? null });
    case 'trial_requested': return pick('AWAIT_TRIAL_RESPONSE', { trialRequestId: p.trialRequest?.id ?? null });
    case 'trial_scheduled': {
      const t = p.trial; const sessions = t?.schedule?.sessions ?? [];
      const lastEnd = sessions.reduce((m, s) => Math.max(m, Number(s?.endsAt) || 0), 0);
      return pick(lastEnd && lastEnd <= now ? 'COMPLETE_TRIAL' : 'CONDUCT_TRIAL', { trialId: t?.id ?? null });
    }
    case 'trial_completed':
      if (!p.assessed) return pick('COMPLETE_ASSESSMENT', { trialId: p.trial?.id ?? null });
      if (!p.decision) return pick('RECORD_DECISION', { trialId: p.trial?.id ?? null });
      return pick('RECORD_DECISION', { trialId: p.trial?.id ?? null, decisionId: p.decision.id });
    case 'offer_consideration':
      if (p.offer && p.offer.status === 'DRAFT') return pick('ISSUE_OFFER', { offerId: p.offer.offer.id, offerRevisionId: p.offer.revision?.id ?? null });
      return pick('PREPARE_OFFER', { decisionId: p.decision?.id ?? null });
    case 'offer_made': {
      const o = p.offer;
      if (o && o.liveStatus === 'ISSUED') return pick('AWAIT_OFFER_RESPONSE', { offerId: o.offer.id, offerRevisionId: o.revision?.id ?? null });
      return pick('REVISE_OR_WITHDRAW_OFFER', { offerId: o?.offer.id ?? null, offerRevisionId: o?.revision?.id ?? null });
    }
    case 'offer_declined': return pick('REVIEW_DECLINED_OFFER', { offerId: p.offer?.offer.id ?? null });
    case 'offer_accepted': {
      const s = p.signing; const st = s ? signingEffectiveStatus(s, now) : null;
      const refs = { offerId: p.offer?.offer.id ?? null, offerRevisionId: p.offer?.revision?.id ?? null, signingPackageId: s?.id ?? null };
      if (!s || !signingIsLive(s, now)) return pick('START_SIGNING', { ...refs, signingPackageId: null });
      if (st === 'DRAFT') return pick('PRESENT_SIGNING', refs);
      const rev = signingCurrentRevision(s); const parties = Array.isArray(rev?.requiredParties) ? rev.requiredParties : [];
      const clubPending = parties.some((x) => x?.partyType === 'CLUB_SIGNATORY' && x.status === 'PENDING');
      const othersPending = parties.some((x) => x?.partyType !== 'CLUB_SIGNATORY' && x.status === 'PENDING');
      if (clubPending) return pick('SIGN_FOR_CLUB', refs);
      if (othersPending) return pick('AWAIT_RECIPIENT_SIGNATURE', refs);
      return pick('COMPLETE_SIGNING', refs);
    }
    default: return pick('STATE_UNKNOWN');
  }
}

function finish(code, refs, p) {
  const def = NEXT_ACTIONS[code];
  const blockedBy = [];
  if (def.kind === 'club') {
    if (p.blocked) blockedBy.push('BLOCKED');
    if (p.subjectRemoved) blockedBy.push('SUBJECT_REMOVED');
  }
  let permitted = def.kind !== 'club' ? null : true;
  if (def.kind === 'club') {
    if (def.lifecycleAction) permitted = (LIFECYCLE_ACTIONS[def.lifecycleAction]?.roles ?? []).some((r) => rankOf(p.role) >= rankOf(r));
    else if (def.permission) permitted = rankOf(p.role) >= rankOf(PERMISSION_MIN_ROLE[def.permission]);
  }
  return {
    code, stage: def.stage, kind: def.kind, tab: def.tab,
    lifecycleAction: def.lifecycleAction ?? null,
    permitted, blockedBy,
    resources: Object.fromEntries(Object.entries(refs).filter(([, v]) => v !== undefined)),
  };
}

/**
 * The PLAYER's (or guardian's) next action across the records that reached
 * them. Only things they themselves can answer: a contact, a trial
 * invitation, a proposed schedule, an issued Offer, a signature. Nothing
 * about the club's process.
 */
export const PLAYER_NEXT_ACTIONS = Object.freeze(['RESPOND_TO_CONTACT', 'RESPOND_TO_TRIAL_INVITATION', 'CONFIRM_TRIAL_SCHEDULE', 'RESPOND_TO_OFFER', 'SIGN', 'NONE']);
export function playerNextActionFor({ pendingContactRequest = null, pendingTrialRequest = null, trialAwaitingConfirmation = null, issuedOffer = null, signingPending = null }) {
  if (signingPending) return { code: 'SIGN', resources: { signingPackageId: signingPending.id } };
  if (issuedOffer) return { code: 'RESPOND_TO_OFFER', resources: { offerId: issuedOffer.offer.id, offerRevisionId: issuedOffer.revision?.id ?? null } };
  if (trialAwaitingConfirmation) return { code: 'CONFIRM_TRIAL_SCHEDULE', resources: { trialId: trialAwaitingConfirmation.id } };
  if (pendingTrialRequest) return { code: 'RESPOND_TO_TRIAL_INVITATION', resources: { requestId: pendingTrialRequest.id } };
  if (pendingContactRequest) return { code: 'RESPOND_TO_CONTACT', resources: { requestId: pendingContactRequest.id } };
  return { code: 'NONE', resources: {} };
}

/**
 * The player-facing STAGE word: only stages that involve the player, derived
 * from records that reached them. Never "watching", "review", "priority" or
 * anything about the club's internal pipeline (§16, §58).
 */
export const PLAYER_STAGES = Object.freeze(['contacted', 'trial_invited', 'trial_scheduled', 'trial_completed', 'offer_received', 'offer_accepted', 'offer_declined', 'signing', 'signed', 'none']);
export function playerStageFor({ contacts = [], trialRequests = [], trials = [], offer = null, signing = null, signingRow = null, now = Date.now() }) {
  if (signingRow || (signing && signingEffectiveStatus(signing, now) === 'COMPLETED')) return 'signed';
  if (signing && signingIsLive(signing, now) && ['READY', 'IN_PROGRESS'].includes(signingEffectiveStatus(signing, now))) return 'signing';
  if (offer) {
    const st = offer.liveStatus ?? null;
    if (st === 'ACCEPTED') return 'offer_accepted';
    if (st === 'DECLINED') return 'offer_declined';
    if (st === 'ISSUED') return 'offer_received';
  }
  const trial = currentTrialForCase(trials);
  if (trial) {
    const st = deriveWorkflowState(trial);
    if (st === 'completed') return 'trial_completed';
    if (st === 'scheduled' || st === 'accepted' || st === 'legacy_accepted') return 'trial_scheduled';
  }
  if (trialRequests.some((r) => r && r.status === 'pending')) return 'trial_invited';
  if (contacts.length) return 'contacted';
  return 'none';
}

// --------------------------------------------------------------- validation

export const JOURNEY_CLASSIFICATIONS = Object.freeze(['canonical', 'legacy', 'partially_canonical', 'integrity_error']);

/** Journey-level integrity codes. The domain codes (offer/signing consistency) are folded in as they are. */
export const JOURNEY_INTEGRITY_CODES = Object.freeze([
  'LIFECYCLE_STATE_UNKNOWN', 'PLAYER_MISMATCH', 'CLUB_MISMATCH', 'CASE_MISMATCH',
  'STALE_POINTER', 'LIFECYCLE_AHEAD_OF_EVIDENCE', 'LIFECYCLE_BEHIND_TERMINAL_EVIDENCE', 'HISTORY_MALFORMED', 'TEMPORAL_ORDER',
]);

/**
 * validateRecruitmentJourney (§10). Detects — and never repairs — a
 * lifecycle/resource combination that cannot both be true, a history entry
 * naming a record that no longer exists, a record that names another
 * player/club/case, a lifecycle ahead of its evidence, a lifecycle behind a
 * terminal record, and malformed time. Returns the problems and the
 * classification (§11):
 *
 *   canonical            every evidence-bearing state the case reached is
 *                        backed by a canonical record
 *   legacy               the case reached evidence-bearing states through
 *                        the pre-P3/P7 status route and no canonical record
 *                        exists for any of them — history from before the
 *                        records existed, reported as such
 *   partially_canonical  some backed, some not
 *   integrity_error      a problem in the list above
 *
 * A history entry that CLAIMS a canonical record (it carries a contactId,
 * trialId, decisionId, offerId or signingPackageId, or a `trigger` from a
 * domain) is the line between legacy and error: a claimed record that is
 * missing is an error; a state reached with no claim is legacy.
 */
export function validateRecruitmentJourney(facts) {
  const problems = new Set();
  const { kase, status, now } = facts;
  if (!ROOM_STATUSES.includes(status)) problems.add('LIFECYCLE_STATE_UNKNOWN');
  if (facts.historyMalformed) problems.add('HISTORY_MALFORMED');
  const ids = {
    contact: new Set((facts.contacts ?? []).map((c) => c.id)),
    trial: new Set((facts.trials ?? []).map((t) => t.id)),
    request: new Set((facts.trialRequests ?? []).map((r) => r.id)),
    decision: new Set((facts.decisions ?? []).map((d) => d.id)),
    offer: new Set((facts.offers ?? []).map((o) => o.id)),
    package: new Set((facts.packages ?? []).map((p) => p.id)),
  };
  // Foreign references among the records that name this case.
  for (const r of facts.foreign ?? []) problems.add(r);
  // Claimed pointers on the history.
  const reached = { contacted: null, trial_requested: null, trial_scheduled: null, trial_completed: null, offer_consideration: null, offer_made: null, offer_accepted: null, offer_declined: null, signed: null };
  for (const h of facts.history ?? []) {
    if (!h || typeof h !== 'object') continue;
    // A malformed instant is corruption. Out-of-order instants are NOT: the
    // history is append-only and the timeline sorts by instant, so a later
    // entry with an earlier instant (a test clock, a clock step) is shown where
    // its instant puts it, never re-ordered into a believable fake sequence.
    if (h.at !== undefined && !isFiniteAt(h.at)) problems.add('TEMPORAL_ORDER');
    if (h.action !== 'room_status_changed') continue;
    const d = h.detail ?? {};
    const to = d.to;
    if (Object.hasOwn(reached, to)) reached[to] = { claimed: claimOf(d), at: h.at };
    if (d.contactId && !ids.contact.has(d.contactId)) problems.add('STALE_POINTER');
    if (d.trialId && !ids.trial.has(d.trialId)) problems.add('STALE_POINTER');
    if (d.requestId && !ids.request.has(d.requestId)) problems.add('STALE_POINTER');
    if (d.decisionId && !ids.decision.has(d.decisionId)) problems.add('STALE_POINTER');
    if (d.offerId && !ids.offer.has(d.offerId)) problems.add('STALE_POINTER');
    if (d.signingPackageId && !ids.package.has(d.signingPackageId)) problems.add('STALE_POINTER');
  }
  // Evidence per reached state.
  const evidence = {
    contacted: (facts.contacts ?? []).some((c) => CONTACT_EVIDENCE_STATUSES.includes(c.status) && !c.cancelledAt),
    trial_requested: (facts.trialRequests ?? []).length > 0 || (facts.trials ?? []).length > 0,
    trial_scheduled: (facts.trials ?? []).some((t) => ['scheduled', 'completed', 'cancelled'].includes(deriveWorkflowState(t)) && t.schedule),
    trial_completed: (facts.trials ?? []).some((t) => deriveWorkflowState(t) === 'completed'),
    offer_consideration: (facts.decisions ?? []).some((d) => d.kind === 'formal' && d.state !== 'draft' && d.outcome === 'progress'),
    offer_made: (facts.offers ?? []).some((o) => liveRevision(o)),
    offer_accepted: (facts.offers ?? []).some((o) => { const r = liveRevision(o); return r && effectiveRevisionStatus(r, now) === 'ACCEPTED'; }),
    offer_declined: (facts.offers ?? []).some((o) => { const r = liveRevision(o); return r && effectiveRevisionStatus(r, now) === 'DECLINED'; }),
    signed: !!facts.signingRow,
  };
  let backed = 0; let unbacked = 0;
  for (const [state, r] of Object.entries(reached)) {
    if (!r) continue;
    if (evidence[state]) { backed += 1; continue; }
    if (r.claimed) problems.add('LIFECYCLE_AHEAD_OF_EVIDENCE'); else unbacked += 1;
  }
  // The CURRENT state must be backed too (a state reached by hand with a claim is caught above; the current state with no history is checked here).
  if (Object.hasOwn(evidence, status) && !evidence[status] && !reached[status]) unbacked += 1;
  // Terminal evidence the lifecycle lags behind.
  const completedPkg = (facts.packages ?? []).some((p) => signingEffectiveStatus(p, now) === 'COMPLETED');
  if ((completedPkg || facts.signingRow) && status !== 'signed' && !TERMINAL_ROOM_STATUSES.includes(status) && status !== 'on_hold') problems.add('LIFECYCLE_BEHIND_TERMINAL_EVIDENCE');
  for (const code of facts.domainProblems ?? []) problems.add(code);
  const list = [...problems].sort();
  let classification = 'canonical';
  if (list.length) classification = 'integrity_error';
  else if (unbacked > 0 && backed === 0) classification = 'legacy';
  else if (unbacked > 0) classification = 'partially_canonical';
  return { ok: list.length === 0, classification, problems: list, backed, unbacked };
}

const claimOf = (d) => !!(d.contactId || d.trialId || d.requestId || d.decisionId || d.offerId || d.signingPackageId
  || (typeof d.trigger === 'string' && /^(contact|trial|offer|signing|decision):/.test(d.trigger)));

// ---------------------------------------------------------------- timeline

/**
 * Which audiences may see each timeline event kind (§14/§15). The club sees
 * everything on its own case; the player, guardian and an authorized agent
 * see only the events that involved them. `trust_safety` sees ids-only
 * milestones for moderation, never rationale (which no event carries).
 */
export const TIMELINE_VISIBILITY = Object.freeze({
  room_created: ['club', 'trust_safety'],
  room_status_changed: ['club', 'trust_safety'],
  room_reopened: ['club', 'trust_safety'],
  case_created: ['club'], case_stage_changed: ['club'],
  room_decision_recorded: ['club'], decision: ['club'], decision_recorded: ['club'], decision_superseded: ['club'],
  transaction_handoff_invited: ['club'], transaction_handoff_withdrawn: ['club'],
  contact_initiated: ['club', 'player', 'guardian', 'agent', 'trust_safety'],
  contact_response_received: ['club', 'player', 'guardian', 'agent', 'trust_safety'],
  trial_invited: ['club', 'player', 'guardian', 'agent', 'trust_safety'],
  trial_declined: ['club', 'player', 'guardian', 'agent', 'trust_safety'],
  trial_accepted: ['club', 'player', 'guardian', 'agent', 'trust_safety'],
  trial_schedule_proposed: ['club', 'player', 'guardian', 'agent'],
  trial_rescheduled: ['club', 'player', 'guardian', 'agent'],
  trial_schedule_confirmed: ['club', 'player', 'guardian', 'agent', 'trust_safety'],
  trial_schedule_declined: ['club', 'player', 'guardian', 'agent'],
  trial_attendance_recorded: ['club', 'player', 'guardian'],
  trial_cancelled: ['club', 'player', 'guardian', 'agent', 'trust_safety'],
  trial_completed: ['club', 'player', 'guardian', 'agent', 'trust_safety'],
  trial_evidence_linked: ['club'],
  trial_assessment_recorded: ['club'],
  offer_draft_created: ['club'],
  offer_issued: ['club', 'player', 'guardian', 'agent', 'trust_safety'],
  offer_superseded: ['club', 'player', 'guardian', 'agent'],
  offer_withdrawn: ['club', 'player', 'guardian', 'agent', 'trust_safety'],
  offer_accepted: ['club', 'player', 'guardian', 'agent', 'trust_safety'],
  offer_declined: ['club', 'player', 'guardian', 'agent', 'trust_safety'],
  offer_expired: ['club', 'player', 'guardian', 'agent'],
  signing_created: ['club'],
  signing_ready: ['club', 'player', 'guardian', 'agent', 'trust_safety'],
  signing_party_completed: ['club', 'player', 'guardian', 'agent'],
  signing_completed: ['club', 'player', 'guardian', 'agent', 'trust_safety'],
  signing_cancelled: ['club', 'player', 'guardian', 'agent', 'trust_safety'],
  signing_voided: ['club', 'player', 'guardian', 'agent', 'trust_safety'],
  signing_superseded: ['club', 'player', 'guardian', 'agent'],
});
export const TIMELINE_AUDIENCES = Object.freeze(['club', 'player', 'guardian', 'agent', 'trust_safety']);
export const timelineVisibleTo = (kind, audience) => (TIMELINE_VISIBILITY[kind] ?? []).includes(audience);

/** The Offer history actions that are journey milestones (drafts and views are not). */
export const OFFER_TIMELINE_ACTIONS = Object.freeze(['offer_draft_created', 'offer_issued', 'offer_superseded', 'offer_withdrawn', 'offer_accepted', 'offer_declined']);
/** The signing history actions that are journey milestones (document attachments carry a digest and are not). */
export const SIGNING_TIMELINE_ACTIONS = Object.freeze(['signing_created', 'signing_ready', 'signing_party_completed', 'signing_completed', 'signing_cancelled', 'signing_voided', 'signing_superseded']);

/** A history entry stripped to ids, words and an instant — never a digest, a term, a note or a name of the other side. */
export function offerTimelineEntry(offer, h) {
  if (!OFFER_TIMELINE_ACTIONS.includes(h?.action)) return null;
  const d = h.detail ?? {};
  return { _k: `${h.action}:${offer.id}:${h.id ?? ''}`, kind: h.action, at: h.at, by: h.by?.kind === 'org' ? (h.by.name ?? null) : null, byKind: h.by?.kind ?? null, offerId: offer.id, ...(d.revisionId ? { offerRevisionId: d.revisionId } : {}), ...(Number.isInteger(d.revisionNumber) ? { revisionNumber: d.revisionNumber } : {}) };
}
export function signingTimelineEntry(pkg, h) {
  if (!SIGNING_TIMELINE_ACTIONS.includes(h?.action)) return null;
  const d = h.detail ?? {};
  return { _k: `${h.action}:${pkg.id}:${h.id ?? ''}`, kind: h.action, at: h.at, by: h.by?.kind === 'org' ? (h.by.name ?? null) : null, byKind: h.by?.kind ?? null, signingPackageId: pkg.id, ...(d.revisionId ? { signingRevisionId: d.revisionId } : {}), ...(d.partyType ? { partyType: d.partyType } : {}), ...(d.signingId ? { completedSigningId: d.signingId } : {}) };
}

/** `signed` is the only lifecycle state whose label the player may read as their own; everything else is club vocabulary. */
export const LIFECYCLE_STATES_PLAYER_MAY_SEE = Object.freeze(['signed']);

export { LIFECYCLE_REOPENABLE };
