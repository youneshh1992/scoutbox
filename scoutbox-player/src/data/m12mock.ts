// Demo mirror of the M12 player/guardian surface (EXPO_PUBLIC_DEMO=1).
// Realistic synthetic fixtures for every feature; in-memory only.
import type {
  PlayerM12, PassportView, FeedbackItem, ObjectiveRec, BoardItem, ApplicationRec,
  CampaignView, FamilyTrial, SafetyPack, SquadInvite, FollowUpView, UploadSession, EvidenceRec, FamilyOffer, FamilyOfferHistory,
} from './m12client';

const NOW = Date.now();
const DAY = 86_400_000;
let n = 500;
const id = (p: string) => `${p}-m${++n}`;
const delay = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), 120));

const EVIDENCE: Record<string, EvidenceRec[]> = {
  'pl-adeyemi': [
    { id: 'evd-1', claimType: 'statistic', label: 'League goals 2025/26', value: 12, units: 'goals', season: '2025/26', verification: { status: 'club_assessed', method: 'corroborated by Eastport FC', reviewerName: 'Maria Keane' }, recordedAt: NOW - 28 * DAY, superseded: false, correctionOf: 'evd-0', freshness: { ageDays: 28, fresh: true } },
    { id: 'evd-0', claimType: 'statistic', label: 'League goals 2025/26', value: 14, units: 'goals', season: '2025/26', verification: { status: 'self_reported', method: 'self_entry', reviewerName: null }, recordedAt: NOW - 40 * DAY, superseded: true, freshness: { ageDays: 40, fresh: true } },
    { id: 'evd-2', claimType: 'attendance', label: 'Sunday league spring block', value: 9, units: 'matches', season: '2025/26', verification: { status: 'coach_confirmed', method: 'confirmed by club-affiliated coach', reviewerName: 'Dee Mensah' }, recordedAt: NOW - 11 * DAY, superseded: false, freshness: { ageDays: 11, fresh: true } },
  ],
  'pl-guni': [
    { id: 'evd-g1', claimType: 'attendance', label: 'U15 spring term', value: 8, units: 'matches', season: '2025/26', verification: { status: 'self_reported', method: 'guardian_entry', reviewerName: null }, recordedAt: NOW - 9 * DAY, superseded: false, freshness: { ageDays: 9, fresh: true } },
  ],
};
const passport = (pid: string): PassportView => {
  const records = EVIDENCE[pid] ?? EVIDENCE['pl-adeyemi'];
  const active = records.filter((r) => !r.superseded);
  return {
    records,
    legacy: pid === 'pl-guni' ? [] : [
      { kind: 'reference', label: 'Reference from Ade Balogun (Team Coach)', tier: 'coach_confirmed', method: 'email_code', caveat: 'Email-code reference: confirms mailbox control, not coach identity.' },
      { kind: 'assessment_result', label: 'Combine sprint-30: 4.32s', tier: 'self_reported', method: 'video_attached', caveat: 'An attached video is not a verified measurement.' },
    ],
    summary: {
      activeRecords: active.length,
      corroborated: active.filter((r) => r.verification.status !== 'self_reported').length,
      insufficient: active.length < 2,
      note: 'Provenance describes how each claim was checked — it is not a rating of football ability, and app usage frequency plays no part in it.',
    },
  };
};

const FEEDBACK: FeedbackItem[] = [
  { id: 'fb-1', orgName: 'Eastport FC', byName: 'Maria Keane', text: 'Loved the movement and finishing. Focus next: pressing triggers — set the press, don’t chase it.', at: NOW - 5 * DAY },
];
const OBJECTIVES: ObjectiveRec[] = [{
  id: 'obj-1', playerId: 'pl-adeyemi', orgId: 'org-eastport',
  reviewer: { name: 'Maria Keane', orgName: 'Eastport FC' },
  objectives: [{ id: 'ox-1', text: 'Set the press on the trigger, not the chase' }],
  progress: [{ at: NOW - 2 * DAY, note: 'Two pressing sessions with Sunday league' }],
  sharing: { orgIds: ['org-eastport'] },
  reassessments: [{ id: 'ras-1', status: 'completed', outcome: { note: 'Pressing triggers much sharper — evidenced in the linked sessions.', byName: 'Maria Keane' } }],
  status: 'active',
}];
const BOARD: BoardItem[] = [
  { id: 'opp-1', type: 'trial', title: 'U23 open trial — attackers', orgName: 'Eastport FC', deadline: new Date(NOW + 18 * DAY).toISOString().slice(0, 10), schedule: 'Sat 09:30', category: 'mens', requirements: ['Bring boots', 'One highlight clip'], distance: '5–15 km', applied: { id: 'apl-1', status: 'accepted' }, description: 'Two-session look at pressing forwards.' },
  { id: 'opp-2', type: 'programme', title: 'Winter development programme', orgName: 'Hackney Marsh Rovers', deadline: new Date(NOW + 30 * DAY).toISOString().slice(0, 10), schedule: 'Wednesdays 18:00', category: 'mixed', requirements: [], distance: 'under 5 km', applied: null, description: 'Eight structured sessions with club coaches.' },
  { id: 'ot-1', via: 'open_trial', type: 'open_day', title: 'Open day at the Marshes', orgName: 'Hackney Marsh Rovers', deadline: new Date(NOW + 9 * DAY).toISOString().slice(0, 10), category: 'mixed', distance: 'under 5 km', applied: null },
];
const APPLICATIONS: ApplicationRec[] = [
  { id: 'apl-1', status: 'accepted', outcome: { decision: 'accepted', note: 'See you Saturday.' }, opportunity: { title: 'U23 open trial — attackers', orgName: 'Eastport FC' } },
];
const CAMPAIGNS: CampaignView[] = [{
  id: 'cmp-1', title: 'Remote sprint assessment', orgName: 'Eastport FC', deadline: new Date(NOW + 12 * DAY).toISOString().slice(0, 10), attemptsAllowed: 2,
  drills: [{ name: '30m sprint', instructions: 'Two cones 30m apart, one run per clip.', recording: { equipment: 'Any phone ≥720p', distance: 'Full run in frame', surface: 'Flat grass', camera: 'Fixed, side-on — no zooming' } }],
  mySubmission: { attempts: [{ id: 'att-1', drillName: '30m sprint', status: 'returned', fileChecks: { passed: true, issues: [] }, review: { reasons: 'Camera moved mid-run — refilm with the phone fixed on a bag or tripod.', kind: 'human_review' } }] },
}];
const TRIALS: FamilyTrial[] = [{
  id: 'trial-1', playerId: 'pl-adeyemi', playerName: 'Kola Adeyemi', orgName: 'Eastport FC',
  proposedDate: new Date(NOW + 6 * DAY).toISOString().slice(0, 10), venue: 'Eastport Training Ground',
  staff: [
    { name: 'Priya Shah', role: 'Safeguarding Lead', check: { kind: 'DBS (England & Wales)', status: 'reviewed' } },
    { name: 'Marcus Cole', role: 'U23 Coach', check: { kind: 'DBS (England & Wales)', status: 'pending' } },
  ],
  arrival: { time: '09:30', address: 'Gate B, Eastport Training Ground', notes: 'Ask for Priya at reception.' },
  consents: [], checkins: [], cancelled: false, statusEvents: [],
  workflow: {
    id: 'trial-1', orgId: 'org-eastport', orgName: 'Eastport FC', playerId: 'pl-adeyemi', workflowState: 'scheduled', workflowLabel: 'Scheduled', legacy: false,
    acceptedAt: NOW - 2 * DAY, proposedDate: new Date(NOW + 6 * DAY).toISOString().slice(0, 10), venue: 'Eastport Training Ground',
    schedule: { legacy: false, timezone: 'Europe/London', revision: 1, confirmedAt: NOW - 2 * DAY, awaitingConfirmation: false, sessions: [
      { id: 'tses-1', kind: 'training', startsAt: NOW + 6 * DAY + 9.5 * 3_600_000, endsAt: NOW + 6 * DAY + 11.5 * 3_600_000, venue: { name: 'Eastport Training Ground', town: 'Eastport', address: 'Gate B, Eastport Training Ground' }, instructions: 'Ask for Priya at reception.', attendance: { state: 'not_recorded', source: null, recordedAt: null } },
    ] },
    awaitingYourConfirmation: false, completion: null, reportStatus: 'awaiting_report', hasReport: false, rev: 1,
  },
}];
const trialWorkflowOf = (tid: string) => { const t = TRIALS.find((x) => x.id === tid); const w = t?.workflow; if (!w || !('schedule' in w)) throw new Error('TRIAL_NOT_FOUND'); return w; };
const INVITES: SquadInvite[] = [
  { id: 'sqi-1', orgName: 'Hackney Marsh Rovers', playerName: 'Kola Adeyemi', note: 'First-team squad list', status: 'pending_player' },
];
const FOLLOWUPS: FollowUpView[] = [
  { id: 'fup-1', playerId: 'pl-adeyemi', orgName: 'Eastport FC', milestone: '3m', dueAt: NOW - DAY, outcomeState: 'reported', report: { registrationStatus: 'registered', matchesPlayed: 4, progression: 'Regular U23 starter' } },
];
const UPLOADS = new Map<string, UploadSession>();

function pack(t: FamilyTrial, forGuardian: boolean): SafetyPack {
  return {
    trial: t,
    pack: {
      headline: 'Who will be there, what has been checked, and what to do if something feels wrong.',
      checksExplained: 'A "reviewed" check means Trust & Safety examined the club’s filed reference for that person. "Pending" means it has NOT been examined yet. We show you the truth rather than a badge.',
      arrival: t.arrival, collection: forGuardian ? { policy: 'Children are released only to the named collecting adult.' } : null,
      emergencySet: t.consents.length > 0, reportRoute: 'Anything concerning: use ⚑ Report in the app — urgent reports suspend club communication immediately.',
      feedbackDue: new Date(NOW + 13 * DAY).toISOString().slice(0, 10), staff: t.staff,
    },
  };
}


// ---- M23 P6 — an issued Offer (demo). The club's exact revision; accepting is not a signing.
const OFFER_LABELS: Record<string, string> = { DRAFT: 'Draft — not issued', ISSUED: 'Issued — awaiting response', ACCEPTED: 'Offer accepted — signing pending', DECLINED: 'Declined by the recipient', WITHDRAWN: 'Withdrawn by the club', EXPIRED: 'Expired', SUPERSEDED: 'Superseded by a later revision' };
const OFFERS: FamilyOffer[] = [{
  id: 'rof-demo-1', playerId: 'pl-adeyemi', playerName: 'Kola Adeyemi', club: { id: 'org-eastport', name: 'Eastport FC' }, type: 'direct_recruitment', status: 'ISSUED', statusLabel: OFFER_LABELS.ISSUED,
  currentRevisionId: 'rofr-demo-1',
  currentRevision: { id: 'rofr-demo-1', revisionNumber: 1, status: 'ISSUED', storedStatus: 'ISSUED', statusLabel: OFFER_LABELS.ISSUED, terms: { offerType: 'direct_recruitment', role: 'Central midfielder', squad: 'Under-23s', startDate: '2027-07-01', endDate: '2029-06-30', conditions: 'Subject to a medical and registration with the league.' }, recipientMessage: 'We would like you to join the U23 group from July. Read the terms and take your time.', documents: [{ id: 'rofd-demo-1', label: 'Outline of the proposal (PDF)' }], expiresAt: NOW + 12 * DAY, issuedAt: NOW - 2 * DAY, createdAt: NOW - 3 * DAY, supersedesRevisionId: null, supersededByRevisionId: null, withdrawnAt: null, respondedAt: null, rev: 2 },
  revisions: [], awaitingYourResponse: true, responses: [], agentShared: false, policyVersion: 1,
  honest: 'Accepting an Offer in ScoutBox tells the club you say yes to exactly these terms. It is not a signature, not a registration and not a contract; nothing is signed here.',
}];
OFFERS[0].revisions = [OFFERS[0].currentRevision!];
const OFFER_HISTORY: FamilyOfferHistory[] = [{ id: 'aud-demo-1', at: NOW - 2 * DAY, action: 'offer_issued', by: { kind: 'org', name: 'Maria Keane' }, revisionId: 'rofr-demo-1' }];
const offerAnswer = (oid: string, revisionId: string, responseType: 'accepted' | 'declined', actorType: 'player' | 'guardian') => {
  const o = OFFERS.find((x) => x.id === oid); if (!o) throw new Error('OFFER_NOT_FOUND');
  const r = o.revisions.find((x) => x.id === revisionId); if (!r) throw new Error('OFFER_NOT_FOUND');
  if (r.status !== 'ISSUED') throw new Error('OFFER_ALREADY_RESPONDED');
  const at = Date.now();
  r.status = responseType === 'accepted' ? 'ACCEPTED' : 'DECLINED'; r.storedStatus = r.status; r.statusLabel = OFFER_LABELS[r.status]; r.respondedAt = at; r.rev += 1;
  o.status = r.status; o.statusLabel = OFFER_LABELS[r.status]; o.awaitingYourResponse = false;
  o.responses.push({ id: id('rofa'), revisionId, responseType, actorType, occurredAt: at });
  OFFER_HISTORY.push({ id: id('aud'), at, action: responseType === 'accepted' ? 'offer_accepted' : 'offer_declined', by: { kind: actorType, name: null }, revisionId });
  return delay({ offer: { ...o }, lifecycle: { applied: true, to: responseType === 'accepted' ? 'offer_accepted' : 'offer_declined' }, signing: { created: false as const, note: 'Accepting an Offer in ScoutBox is not a signing. Nothing was signed and no contract exists.' } });
};

export const m12mock: PlayerM12 = {
  getPassport: (pid) => delay(passport(pid)),
  addEvidence: async (pid, input) => {
    (EVIDENCE[pid] ??= []).unshift({ id: id('evd'), claimType: input.claimType, label: input.label, value: input.value ?? null, units: input.units ?? null, season: input.season ?? null, verification: { status: 'self_reported', method: 'self_entry', reviewerName: null }, recordedAt: Date.now(), superseded: false, freshness: { ageDays: 0, fresh: true } });
    return delay(undefined);
  },
  correctEvidence: async (pid, eid, value, reason) => {
    const list = EVIDENCE[pid] ?? [];
    const orig = list.find((e) => e.id === eid);
    if (orig) {
      orig.superseded = true;
      list.unshift({ ...orig, id: id('evd'), value, superseded: false, correctionOf: orig.id, recordedAt: Date.now(), verification: { status: 'self_reported', method: `correction: ${reason}`, reviewerName: null } });
    }
    return delay(undefined);
  },
  getFeedback: (pid) => delay(pid === 'pl-guni' ? { guardianManaged: true, count: 1, items: [] } : { items: FEEDBACK }),
  getObjectives: (pid) => delay(OBJECTIVES.filter((o) => o.playerId === pid || pid === 'pl-adeyemi')),
  createObjective: async (_pid, _fbId, texts) => {
    OBJECTIVES.push({ id: id('obj'), playerId: 'pl-adeyemi', orgId: 'org-eastport', reviewer: { name: 'Maria Keane', orgName: 'Eastport FC' }, objectives: texts.map((t) => ({ id: id('ox'), text: t })), progress: [], sharing: { orgIds: [] }, reassessments: [], status: 'active' });
    return delay(undefined);
  },
  addObjectiveProgress: async (_pid, oid, note) => {
    OBJECTIVES.find((o) => o.id === oid)?.progress.push({ at: Date.now(), note });
    return delay(undefined);
  },
  shareObjective: async (_pid, oid, orgId, enabled) => {
    const o = OBJECTIVES.find((x) => x.id === oid);
    if (o) o.sharing.orgIds = enabled ? [...new Set([...o.sharing.orgIds, orgId])] : o.sharing.orgIds.filter((x) => x !== orgId);
    return delay(undefined);
  },
  requestReassessment: async (_pid, oid) => {
    const o = OBJECTIVES.find((x) => x.id === oid);
    if (o) {
      if (!o.sharing.orgIds.length) throw new Error('Share progress with the club before asking them to look again.');
      o.reassessments.push({ id: id('ras'), status: 'requested', outcome: null });
    }
    return delay(undefined);
  },
  getBoard: (pid) => delay({ items: BOARD, minor: pid === 'pl-guni', note: pid === 'pl-guni' ? 'Applications for under-18s are made by your parent/guardian.' : null }),
  applyToOpportunity: async (pid, oid, note) => {
    if (pid === 'pl-guni') throw new Error('Your parent or guardian makes applications for you.');
    const b = BOARD.find((x) => x.id === oid);
    if (b?.applied) throw new Error('Already applied.');
    if (b) {
      b.applied = { id: id('apl'), status: 'submitted' };
      APPLICATIONS.push({ id: b.applied.id!, status: 'submitted', outcome: null, opportunity: { title: b.title, orgName: b.orgName } });
    }
    void note;
    return delay(undefined);
  },
  withdrawApplication: async (_pid, aid) => {
    const a = APPLICATIONS.find((x) => x.id === aid);
    if (a) a.status = 'withdrawn';
    const b = BOARD.find((x) => x.applied?.id === aid);
    if (b) b.applied = null;
    return delay(undefined);
  },
  myApplications: () => delay(APPLICATIONS),
  getCampaigns: () => delay(CAMPAIGNS),
  submitCampaignAttempt: async (_pid, cid, mediaId, drillName) => {
    const c = CAMPAIGNS.find((x) => x.id === cid)!;
    const passed = !!mediaId;
    const attempt = { id: id('att'), drillName, status: passed ? 'submitted' : 'failed_checks', fileChecks: { passed, issues: passed ? [] : ['attach the recorded video before submitting'] }, review: null };
    (c.mySubmission ??= { attempts: [] }).attempts.push(attempt);
    return delay({ status: attempt.status, issues: attempt.fileChecks.issues, note: passed ? 'File checks passed. A coach still has to review the drill itself — that is a separate, human step.' : 'Automated file checks failed — fix the issues and resubmit.' });
  },
  getTrials: () => delay(TRIALS),
  confirmTrialSchedule: async (_pid, tid) => { const w = trialWorkflowOf(tid); if (w.schedule && !w.schedule.confirmedAt) { w.schedule.confirmedAt = Date.now(); w.schedule.awaitingConfirmation = false; w.awaitingYourConfirmation = false; w.workflowState = 'scheduled'; w.workflowLabel = 'Scheduled'; w.rev += 1; } return delay({ ...w }); },
  declineTrialSchedule: async (_pid, tid) => { const w = trialWorkflowOf(tid); if (w.schedule) { w.schedule.declinedAt = Date.now(); w.rev += 1; } return delay({ ...w }); },
  cancelTrial: async (_pid, tid, reason) => { const w = trialWorkflowOf(tid); if (!w.completion) { w.completion = { state: 'cancelled', at: Date.now(), byKind: 'player', reason: reason ?? null }; w.workflowState = 'cancelled'; w.workflowLabel = 'Cancelled'; w.rev += 1; const t = TRIALS.find((x) => x.id === tid); if (t) t.cancelled = true; } return delay({ ...w }); },
  giveTrialConsent: async (_pid, tid) => {
    const t = TRIALS.find((x) => x.id === tid);
    if (t && !t.consents.some((c) => c.scope === 'player_event_consent')) t.consents.push({ byKind: 'player', scope: 'player_event_consent' });
    return delay(undefined);
  },
  setEmergencyContact: async () => delay(undefined),
  getSafetyPack: (_pid, tid) => delay(pack(TRIALS.find((x) => x.id === tid) ?? TRIALS[0], false)),
  getSquadInvites: () => delay(INVITES.filter((i) => i.status === 'pending_player')),
  respondSquadInvite: async (_pid, iid, accept) => {
    const i = INVITES.find((x) => x.id === iid);
    if (i) i.status = accept ? 'approved' : 'declined';
    return delay(undefined);
  },
  getFollowUps: () => delay(FOLLOWUPS),
  respondFollowUp: async (_pid, fid, agree) => {
    const f = FOLLOWUPS.find((x) => x.id === fid);
    if (f) f.outcomeState = agree ? 'confirmed' : 'disputed';
    return delay(undefined);
  },
  setFootballCategory: async () => delay(undefined),
  setCaptions: async () => delay(undefined),
  startUpload: async (_pid, input) => {
    const chunkSize = 512 * 1024;
    const up: UploadSession = { id: id('upl'), chunkSize, totalChunks: Math.ceil(input.size / chunkSize), received: [], status: 'open', finalisedMediaId: null };
    UPLOADS.set(up.id, up);
    return delay(up);
  },
  putChunk: async (_pid, uid, index) => {
    const up = UPLOADS.get(uid)!;
    if (!up.received.includes(index)) up.received.push(index);
    return delay({ received: up.received.length, totalChunks: up.totalChunks, complete: up.received.length === up.totalChunks });
  },
  finaliseUpload: async (_pid, uid) => {
    const up = UPLOADS.get(uid)!;
    if (up.received.length < up.totalChunks) throw new Error(`Chunks missing (${up.totalChunks - up.received.length}) — upload them, then finalise again. Nothing was lost.`);
    up.status = 'finalised';
    up.finalisedMediaId = id('media');
    return delay({ mediaId: up.finalisedMediaId });
  },
  abortUpload: async (_pid, uid) => {
    const up = UPLOADS.get(uid);
    if (up) up.status = 'aborted';
    return delay(undefined);
  },

  gPassport: (_gid, cid) => delay(passport(cid === 'pl-guni' ? 'pl-guni' : 'pl-adeyemi')),
  gAddEvidence: async (_gid, cid, input) => {
    (EVIDENCE[cid] ??= []).unshift({ id: id('evd'), claimType: input.claimType, label: input.label, value: input.value ?? null, units: input.units ?? null, season: null, verification: { status: 'self_reported', method: 'guardian_entry', reviewerName: null }, recordedAt: Date.now(), superseded: false, freshness: { ageDays: 0, fresh: true } });
    return delay(undefined);
  },
  gFeedback: () => delay({ items: FEEDBACK }),
  gObjectives: () => delay(OBJECTIVES),
  gCreateObjective: async (_gid, _cid, _fb, texts) => {
    OBJECTIVES.push({ id: id('obj'), playerId: 'pl-guni', orgId: 'org-eastport', reviewer: { name: 'Maria Keane', orgName: 'Eastport FC' }, objectives: texts.map((t) => ({ id: id('ox'), text: t })), progress: [], sharing: { orgIds: [] }, reassessments: [], status: 'active' });
    return delay(undefined);
  },
  gShareObjective: (gid, oid, orgId, enabled) => m12mock.shareObjective(gid, oid, orgId, enabled),
  gRequestReassessment: (gid, oid) => m12mock.requestReassessment(gid, oid),
  gBoard: () => delay({ items: BOARD.filter((b) => b.type !== 'trial') }),
  gApply: async (_gid, _cid, oid) => {
    const b = BOARD.find((x) => x.id === oid);
    if (b?.applied) throw new Error('Already applied.');
    if (b) b.applied = { id: id('apl'), status: 'submitted' };
    return delay(undefined);
  },
  gApplications: () => delay(APPLICATIONS),
  gCampaigns: () => delay(CAMPAIGNS),
  gSubmitCampaignAttempt: async (_gid, _cid, campId, mediaId, drillName) => {
    const r = await m12mock.submitCampaignAttempt('pl-guni', campId, mediaId, drillName);
    return { status: r.status, issues: r.issues };
  },
  gTrials: () => delay(TRIALS.map((t) => ({ ...t, playerName: 'Guni Adebayo' }))),
  gConfirmTrialSchedule: (_gid, tid) => m12mock.confirmTrialSchedule('pl-guni', tid),
  gDeclineTrialSchedule: (_gid, tid, reason) => m12mock.declineTrialSchedule('pl-guni', tid, reason),
  gCancelTrial: (_gid, tid, reason) => m12mock.cancelTrial('pl-guni', tid, reason),
  gGiveTrialConsent: async (_gid, tid) => {
    const t = TRIALS.find((x) => x.id === tid);
    if (t && !t.consents.some((c) => c.scope === 'guardian_event_consent')) t.consents.push({ byKind: 'guardian', scope: 'guardian_event_consent' });
    return delay(undefined);
  },
  gSetEmergencyContact: async () => delay(undefined),
  gSafetyPack: (_gid, tid) => delay(pack(TRIALS.find((x) => x.id === tid) ?? TRIALS[0], true)),
  // ---- M23 P6 — Offers (demo). The minor's guardian route sees none: the pathway is closed in this build.
  getOffers: () => delay(OFFERS.map((o) => ({ ...o }))),
  getOffer: async (_pid, oid) => { const o = OFFERS.find((x) => x.id === oid); if (!o) throw new Error('OFFER_NOT_FOUND'); return delay({ offer: { ...o }, history: OFFER_HISTORY.slice() }); },
  acceptOffer: (_pid, oid, revisionId) => offerAnswer(oid, revisionId, 'accepted', 'player'),
  declineOffer: (_pid, oid, revisionId) => offerAnswer(oid, revisionId, 'declined', 'player'),
  shareOfferWithAgent: async (_pid, oid, share) => { const o = OFFERS.find((x) => x.id === oid); if (!o) throw new Error('OFFER_NOT_FOUND'); o.agentShared = share; return delay({ offer: { ...o } }); },
  getOfferDocument: async (_pid, _oid, docId) => delay({ document: { id: docId, label: 'Outline of the proposal (PDF)', mime: 'application/pdf', bytes: 9, filename: 'outline.pdf' }, file: { mime: 'application/pdf', base64: 'JVBERi0xLjQK' } }),
  // M23 P7 — the demo never presents a signing: nothing is signed in a demo, and the section stays quiet.
  getSignings: () => delay([]),
  getSigning: async () => { throw new Error('SIGNING_NOT_FOUND'); },
  getSigningDocument: async () => { throw new Error('SIGNING_DOCUMENT_NOT_FOUND'); },
  completeSigning: async () => { throw new Error('SIGNING_NOT_FOUND'); },
  gSignings: () => delay([]),
  gOffers: () => delay([]),
  gOffer: async () => { throw new Error('OFFER_NOT_FOUND'); },
  gAcceptOffer: async () => { throw new Error('OFFER_NOT_FOUND'); },
  gDeclineOffer: async () => { throw new Error('OFFER_NOT_FOUND'); },
  gOfferDocument: async () => { throw new Error('OFFER_DOCUMENT_NOT_FOUND'); },
  gSquadInvites: () => delay([{ id: 'sqi-2', orgName: 'Eastport FC', playerName: 'Guni Adebayo', note: 'U15 development squad', status: 'pending_guardian' }]),
  gRespondSquadInvite: async () => delay(undefined),
  gFollowUps: () => delay(FOLLOWUPS.map((f) => ({ ...f, playerId: 'pl-guni' }))),
  gRespondFollowUp: (gid, fid, agree) => m12mock.respondFollowUp(gid, fid, agree),
};
