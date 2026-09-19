// M23 P5.6C — the attributed compliance review console (gate G-C0).
//
// The whole point of this panel: an authoritative compliance decision is made
// by a NAMED, authenticated reviewer. The shared admin key that opens the rest
// of this console is explicitly NOT a reviewer identity — every /ts/* route
// refuses it — so this panel has its own credentialed sign-in and sends only
// the reviewer's bearer token. The token lives in memory for the session, like
// the admin key itself; nothing is persisted.
//
// Nothing here decides an outcome locally. A reviewer resolves missing or
// uncertain FACTS against cited evidence; the server refuses an approval that
// would override a prohibition an ACTIVE rule states, and refuses a policy
// approval by the same administrator who proposed it (dual control).
import { useCallback, useEffect, useState } from 'react';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
const DEMO = import.meta.env.VITE_DEMO === '1';

export type M25Tab = 'agentreview' | 'agentpolicy' | 'agentreviewers' | 'agenttransactions';
export const M25_TABS: { id: M25Tab; label: string }[] = [
  { id: 'agentreview', label: 'Agent compliance review' },
  { id: 'agentpolicy', label: 'Jurisdiction policy' },
  { id: 'agentreviewers', label: 'Reviewer identities' },
  { id: 'agenttransactions', label: 'Agent transactions' },
];

// ------------------------------------------------------------------ types
interface Reviewer { id: string; name: string; role: 'trust_safety_reviewer' | 'trust_safety_admin'; status: 'active' | 'revoked'; createdAt: number; revokedAt: number | null; rev: number }
interface Reason { code: string; ruleId: string | null; ruleStatus: string | null; policyVersion: string | null }
interface Review {
  id: string; kind: string; status: string; agencyOrgId: string; agentUserId: string | null;
  subject: Record<string, unknown>; reasons: Reason[]; policyVersions: string[];
  requestedAt: number; startedAt: number | null; decidedAt: number | null;
  decision: { outcome: string; reasonCode: string; reason?: string; evidenceRefs?: string[]; reviewer: { id: string; name: string; role: string }; evidenceCount: number; resultingState?: Record<string, unknown> } | null;
  startedBy: { id: string; name: string } | null; supersedes: string | null; supersededBy: string | null;
  snapshot: Record<string, unknown> | null; rev: number;
}
interface SubjectDetail { [k: string]: unknown }
/**
 * M23 P5.6D — the Trust & Safety read of a transaction. Deliberately thin: ids,
 * party ROLES, states, counts. The parties' documents, notes, messages and
 * working particulars are theirs and are not exposed to this console at all
 * (§40/§34), so there is nothing here to leak and no action to take.
 */
interface TsTransaction {
  id: string; type: string; status: string; jurisdictions: string[];
  agencyOrgId: string; agentUserId: string | null;
  parties: { partyRole: string; subjectKind: string; removed: boolean; confirmed: boolean }[];
  representations: { partyRole: string; status: string; declaredOnly: boolean; reviewId: string | null }[];
  compliance: { outcome: string | null; pendingReason: string | null; blocked: boolean; clear: boolean; reasonCodes: string[]; policyVersions: string[]; evaluatedAt: number | null; stale: string | null } | null;
  reviews: { id: string; kind: string; status: string }[];
  documentCount: number; noteCount: number; linkedThreadCount: number;
  createdAt: number; updatedAt: number; rev: number;
}
interface TxMetrics {
  byStatus: Record<string, number>; byType: Record<string, number>;
  medianDurationMs: number | null; medianCompliancePendingMs: number | null; medianConsentWaitMs: number | null;
  cancellationReasons: Record<string, number>; holdReasons: Record<string, number>;
  staleSnapshots: number; note: string;
}
interface PolicyVersion {
  id: string; regulator: string; jurisdiction: string; policyVersion: number; supersedes: string | null;
  effectiveFrom: string; effectiveTo: string | null; status: string; publishedAt: number | null;
  proposedBy: { id: string; name: string } | null; approvedBy: { id: string; name: string; at: number } | null;
  rules?: Record<string, { ruleStatus: string; textStatus?: string; sourceRef?: string | null; note?: string | null }>;
}
interface DecisionRow { id: string; at: number; action: string; reviewId: string; kind: string; reviewer?: { id: string; name: string; role: string } | null; outcome?: string | null; reasonCode?: string | null; evidenceCount?: number | null }
interface Metrics {
  reviews: { byStatus: Record<string, number>; byKind: Record<string, number>; medianDurationMs: number | null };
  conflictOutcomes: Record<string, number>;
  consents: { requested: number; granted: number; declined: number; revoked: number };
  staleFacets: number; note: string;
}

const STATUSES = ['OPEN', 'PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED', 'SUPERSEDED'];
const STATUS_LABEL: Record<string, string> = {
  OPEN: 'open work (awaiting or in review)', PENDING: 'awaiting review', IN_REVIEW: 'in review',
  APPROVED: 'approved', REJECTED: 'rejected', CANCELLED: 'cancelled', SUPERSEDED: 'superseded',
};
const TX_STATUSES = ['DRAFT', 'PARTIES_CONFIRMED', 'COMPLIANCE_PENDING', 'COMPLIANCE_BLOCKED', 'READY', 'ACTIVE', 'ON_HOLD', 'CANCELLED', 'CLOSED', 'ARCHIVED'];
const TX_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'draft', PARTIES_CONFIRMED: 'parties confirmed', COMPLIANCE_PENDING: 'compliance pending',
  COMPLIANCE_BLOCKED: 'compliance blocked', READY: 'ready to proceed in ScoutBox', ACTIVE: 'in progress',
  ON_HOLD: 'on hold', CANCELLED: 'cancelled', CLOSED: 'closed', ARCHIVED: 'archived',
};
/** A duration in words. Never a bare millisecond count in front of a human. */
const ms = (v: number | null) => {
  if (v === null) return 'not enough data';
  const h = v / 3600e3;
  if (h < 1) return `${Math.round(v / 60e3)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
};
const matchesFilter = (r: { status: string }, f: string) => (f === 'OPEN' ? r.status === 'PENDING' || r.status === 'IN_REVIEW' : r.status === f);
const KIND_LABEL: Record<string, string> = {
  verification_facet: 'Verification of a facet',
  representation_dispute: 'Client dispute',
  representation_declared: 'Declared representation of an entity',
  conflict_evaluation: 'Conflict evaluation',
};
const ROLE_LABEL: Record<string, string> = { trust_safety_reviewer: 'Reviewer', trust_safety_admin: 'Administrator' };
const when = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleString() : '—');

// ------------------------------------------------------------------ demo
const NOW = Date.now();
const demoReviewers: Reviewer[] = [
  { id: 'tsr-dev-admin', name: 'Priya Shah', role: 'trust_safety_admin', status: 'active', createdAt: NOW - 200 * 86400e3, revokedAt: null, rev: 1 },
  { id: 'tsr-dev-reviewer', name: 'Marcus Bell', role: 'trust_safety_reviewer', status: 'active', createdAt: NOW - 150 * 86400e3, revokedAt: null, rev: 1 },
  { id: 'tsr-dev-admin2', name: 'Léa Fontaine', role: 'trust_safety_admin', status: 'active', createdAt: NOW - 120 * 86400e3, revokedAt: null, rev: 1 },
];
const demoReviews: Review[] = [
  {
    id: 'rrv-d1', kind: 'verification_facet', status: 'PENDING', agencyOrgId: 'org-northstar', agentUserId: 'usr-eve',
    subject: { profileId: 'agp-usr-eve', userId: 'usr-eve', facet: 'national_registration', memberAssociation: 'ENG' },
    reasons: [{ code: 'NO_PROVIDER', ruleId: null, ruleStatus: null, policyVersion: null }], policyVersions: ['jp-eng-2026-27-1'],
    requestedAt: NOW - 4 * 3600e3, startedAt: null, decidedAt: null, decision: null, startedBy: null, supersedes: null, supersededBy: null, snapshot: null, rev: 1,
  },
  {
    id: 'rrv-d2', kind: 'representation_declared', status: 'PENDING', agencyOrgId: 'org-northstar', agentUserId: 'usr-ana',
    subject: { contextId: 'ctx-d1', representationId: 'crp-d2', partyRole: 'engaging_entity' },
    reasons: [{ code: 'REPRESENTATION_UNVERIFIED', ruleId: null, ruleStatus: null, policyVersion: null }], policyVersions: ['jp-fifa-2025-1', 'jp-eng-2026-27-1'],
    requestedAt: NOW - 2 * 3600e3, startedAt: null, decidedAt: null, decision: null, startedBy: null, supersedes: null, supersededBy: null,
    snapshot: { outcome: 'MANUAL_REGULATORY_REVIEW_REQUIRED' }, rev: 1,
  },
  {
    id: 'rrv-d3', kind: 'conflict_evaluation', status: 'PENDING', agencyOrgId: 'org-northstar', agentUserId: 'usr-ana',
    subject: { contextId: 'ctx-d2', representationId: null, partyRole: 'individual' },
    reasons: [{ code: 'RULE_STATUS_UNCERTAIN', ruleId: 'FIFA-12.8', ruleStatus: 'UNDER_LEGAL_REVIEW', policyVersion: 'jp-fifa-2025-1' }], policyVersions: ['jp-fifa-2025-1'],
    requestedAt: NOW - 26 * 3600e3, startedAt: null, decidedAt: null, decision: null, startedBy: null, supersedes: null, supersededBy: null,
    snapshot: { outcome: 'MANUAL_REGULATORY_REVIEW_REQUIRED' }, rev: 1,
  },
  {
    id: 'rrv-d0', kind: 'representation_dispute', status: 'APPROVED', agencyOrgId: 'org-northstar', agentUserId: 'usr-ana',
    subject: { agreementId: 'rep-d4' }, reasons: [{ code: 'CLIENT_DISPUTE', ruleId: null, ruleStatus: null, policyVersion: null }], policyVersions: [],
    requestedAt: NOW - 3 * 86400e3, startedAt: NOW - 3 * 86400e3 + 600e3, decidedAt: NOW - 3 * 86400e3 + 3600e3,
    decision: { outcome: 'APPROVED', reasonCode: 'dispute_reinstated', reason: 'The client confirmed the relationship in writing; the dispute was a mistaken tap.', evidenceRefs: ['Client confirmation, 12 Sep 2026'], reviewer: { id: 'tsr-dev-reviewer', name: 'Marcus Bell', role: 'trust_safety_reviewer' }, evidenceCount: 1, resultingState: { agreementStatus: 'active' } },
    startedBy: { id: 'tsr-dev-reviewer', name: 'Marcus Bell' }, supersedes: null, supersededBy: null, snapshot: null, rev: 4,
  },
];
const demoSubjectDetail: Record<string, SubjectDetail> = {
  'rrv-d1': { agentDisplayName: 'Eve Laurent', facet: 'national_registration', memberAssociation: 'ENG', reference: 'FA-REAL-42', state: 'MANUAL_REVIEW_REQUIRED', submittedAt: NOW - 4 * 3600e3 },
  'rrv-d2': { contextId: 'ctx-d1', type: 'employment_contract', jurisdictions: ['ENG'], partyRoles: ['individual', 'engaging_entity'], representations: [{ partyRole: 'individual', status: 'verified' }, { partyRole: 'engaging_entity', status: 'pending_review' }], lastOutcome: 'MANUAL_REGULATORY_REVIEW_REQUIRED' },
  'rrv-d3': { contextId: 'ctx-d2', type: 'transfer', jurisdictions: ['INT'], partyRoles: ['individual', 'engaging_entity', 'releasing_entity'], representations: [{ partyRole: 'individual', status: 'verified' }], lastOutcome: 'MANUAL_REGULATORY_REVIEW_REQUIRED' },
  'rrv-d0': { agreementId: 'rep-d4', status: 'disputed', disputedAt: NOW - 3 * 86400e3, hadReason: true, scope: ['employment'], jurisdiction: 'ENG' },
};
const demoPolicies: PolicyVersion[] = [
  { id: 'jp-fifa-2025-1', regulator: 'FIFA', jurisdiction: 'INT', policyVersion: 1, supersedes: null, effectiveFrom: '2025-10-01', effectiveTo: null, status: 'published', publishedAt: NOW - 300 * 86400e3, proposedBy: null, approvedBy: null, rules: { 'FIFA-11.1': { ruleStatus: 'ACTIVE', sourceRef: 'FFAR 11(1)' }, 'FIFA-12.8': { ruleStatus: 'UNDER_LEGAL_REVIEW', note: 'Operative status contested; the national rule decides where one is encoded.' }, 'FIFA-19': { ruleStatus: 'SUSPENDED', sourceRef: 'FFAR 19' } } },
  { id: 'jp-eng-2026-27-1', regulator: 'FA', jurisdiction: 'ENG', policyVersion: 1, supersedes: null, effectiveFrom: '2026-07-01', effectiveTo: null, status: 'published', publishedAt: NOW - 80 * 86400e3, proposedBy: null, approvedBy: null, rules: { 'ENG-6.3': { ruleStatus: 'ACTIVE', sourceRef: 'FA Regulations 2026/27, C6.3' }, 'ENG-6.4': { ruleStatus: 'ACTIVE' }, 'ENG-7.13': { ruleStatus: 'PARTIALLY_SUSPENDED' } } },
  { id: 'jp-eng-2026-27-2', regulator: 'FA', jurisdiction: 'ENG', policyVersion: 2, supersedes: 'jp-eng-2026-27-1', effectiveFrom: new Date(NOW + 7 * 86400e3).toISOString().slice(0, 10), effectiveTo: null, status: 'proposed', publishedAt: null, proposedBy: { id: 'tsr-dev-admin', name: 'Priya Shah' }, approvedBy: null, rules: { 'ENG-6.3': { ruleStatus: 'ACTIVE' } } },
];
const demoAudit: DecisionRow[] = [
  { id: 'aud-d1', at: NOW - 3 * 86400e3 + 3600e3, action: 'regulatory_review_resolved', reviewId: 'rrv-d0', kind: 'representation_dispute', reviewer: { id: 'tsr-dev-reviewer', name: 'Marcus Bell', role: 'trust_safety_reviewer' }, outcome: 'APPROVED', reasonCode: 'dispute_reinstated', evidenceCount: 1 },
  { id: 'aud-d2', at: NOW - 3 * 86400e3 + 600e3, action: 'regulatory_review_started', reviewId: 'rrv-d0', kind: 'representation_dispute', reviewer: { id: 'tsr-dev-reviewer', name: 'Marcus Bell', role: 'trust_safety_reviewer' } },
];
const demoMetrics: Metrics = {
  reviews: { byStatus: { PENDING: 3, IN_REVIEW: 0, APPROVED: 1, REJECTED: 0, CANCELLED: 0, SUPERSEDED: 0 }, byKind: { verification_facet: 1, representation_dispute: 1, representation_declared: 1, conflict_evaluation: 1 }, medianDurationMs: 3000e3 },
  conflictOutcomes: { CLEAR: 4, PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED: 2, MANUAL_REGULATORY_REVIEW_REQUIRED: 2, PROHIBITED_CONFLICT: 1 },
  consents: { requested: 3, granted: 1, declined: 0, revoked: 1 },
  staleFacets: 1,
  note: 'Process metrics only. No agent is ranked and no subscription or payment status enters any compliance outcome.',
};

// M23 P5.6D — synthetic transactions for the demo build. Roles and states only,
// exactly as the real T&S read gives them: no names, no documents, no notes.
const demoTxs: TsTransaction[] = [
  {
    id: 'atx-d1', type: 'employment_contract', status: 'ACTIVE', jurisdictions: ['ENG'], agencyOrgId: 'org-northstar', agentUserId: 'usr-ana',
    parties: [{ partyRole: 'individual', subjectKind: 'player', removed: false, confirmed: true }, { partyRole: 'engaging_entity', subjectKind: 'club', removed: false, confirmed: true }],
    representations: [{ partyRole: 'individual', status: 'verified', declaredOnly: false, reviewId: null }],
    compliance: { outcome: 'CLEAR', pendingReason: null, blocked: false, clear: true, reasonCodes: [], policyVersions: ['jp-eng-2026-27-1'], evaluatedAt: NOW - 2 * 3600e3, stale: null },
    reviews: [], documentCount: 2, noteCount: 1, linkedThreadCount: 1, createdAt: NOW - 9 * 86400e3, updatedAt: NOW - 2 * 3600e3, rev: 11,
  },
  {
    id: 'atx-d2', type: 'transfer', status: 'COMPLIANCE_PENDING', jurisdictions: ['INT', 'ENG'], agencyOrgId: 'org-northstar', agentUserId: 'usr-ana',
    parties: [{ partyRole: 'individual', subjectKind: 'player', removed: false, confirmed: true }, { partyRole: 'engaging_entity', subjectKind: 'club', removed: false, confirmed: true }, { partyRole: 'releasing_entity', subjectKind: 'club', removed: false, confirmed: false }],
    representations: [{ partyRole: 'individual', status: 'verified', declaredOnly: false, reviewId: null }, { partyRole: 'engaging_entity', status: 'pending_review', declaredOnly: true, reviewId: 'rrv-d2' }],
    compliance: { outcome: 'PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED', pendingReason: 'CONSENT_REQUIRED', blocked: false, clear: false, reasonCodes: ['DUAL_REPRESENTATION_CONSENT_REQUIRED'], policyVersions: ['jp-fifa-2025-1', 'jp-eng-2026-27-1'], evaluatedAt: NOW - 20 * 3600e3, stale: null },
    reviews: [{ id: 'rrv-d2', kind: 'representation_declared', status: 'PENDING' }], documentCount: 1, noteCount: 0, linkedThreadCount: 0, createdAt: NOW - 4 * 86400e3, updatedAt: NOW - 20 * 3600e3, rev: 7,
  },
  {
    id: 'atx-d3', type: 'loan', status: 'COMPLIANCE_BLOCKED', jurisdictions: ['ENG'], agencyOrgId: 'org-northstar', agentUserId: 'usr-ana',
    parties: [{ partyRole: 'individual', subjectKind: 'player', removed: false, confirmed: true }, { partyRole: 'engaging_entity', subjectKind: 'club', removed: false, confirmed: true }, { partyRole: 'releasing_entity', subjectKind: 'club', removed: false, confirmed: true }],
    representations: [{ partyRole: 'individual', status: 'verified', declaredOnly: false, reviewId: null }, { partyRole: 'releasing_entity', status: 'verified', declaredOnly: false, reviewId: null }],
    compliance: { outcome: 'PROHIBITED_CONFLICT', pendingReason: null, blocked: true, clear: false, reasonCodes: ['PROHIBITED_MULTIPLE_REPRESENTATION'], policyVersions: ['jp-eng-2026-27-1'], evaluatedAt: NOW - 30 * 3600e3, stale: null },
    reviews: [], documentCount: 0, noteCount: 2, linkedThreadCount: 0, createdAt: NOW - 6 * 86400e3, updatedAt: NOW - 30 * 3600e3, rev: 5,
  },
  {
    id: 'atx-d4', type: 'transfer', status: 'CANCELLED', jurisdictions: ['ENG'], agencyOrgId: 'org-northstar', agentUserId: 'usr-ana',
    parties: [{ partyRole: 'individual', subjectKind: 'player', removed: true, confirmed: true }, { partyRole: 'engaging_entity', subjectKind: 'club', removed: false, confirmed: true }],
    representations: [], compliance: null, reviews: [],
    documentCount: 0, noteCount: 0, linkedThreadCount: 0, createdAt: NOW - 40 * 86400e3, updatedAt: NOW - 30 * 86400e3, rev: 9,
  },
];
const demoTxMetrics: TxMetrics = {
  byStatus: { DRAFT: 1, PARTIES_CONFIRMED: 0, COMPLIANCE_PENDING: 1, COMPLIANCE_BLOCKED: 1, READY: 0, ACTIVE: 1, ON_HOLD: 1, CANCELLED: 1, CLOSED: 0, ARCHIVED: 0 },
  byType: { employment_contract: 2, transfer: 2, loan: 1, other_services: 0 },
  medianDurationMs: 10 * 86400e3, medianCompliancePendingMs: 22 * 3600e3, medianConsentWaitMs: 14 * 3600e3,
  cancellationReasons: { parties_withdrew: 1, duplicate: 0, opened_in_error: 0, compliance_not_resolvable: 0, other: 0 },
  holdReasons: { awaiting_party: 1, awaiting_document: 0, awaiting_regulatory_step: 0, other: 0 },
  staleSnapshots: 1,
  note: 'Process metrics only. No agent, club or player is ranked, and no subscription or payment status enters any transaction outcome.',
};

// ------------------------------------------------------------------ panel
export function M25Panel({ tab, say }: { tab: M25Tab; adminKey: string; say: (t: string) => void }) {
  // The reviewer session. Deliberately not the admin key, and deliberately not persisted.
  const [token, setToken] = useState<string | null>(DEMO ? 'demo-reviewer' : null);
  const [me, setMe] = useState<Reviewer | null>(DEMO ? demoReviewers[0] : null);
  const [reviewerId, setReviewerId] = useState('');
  const [secret, setSecret] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  const [reviews, setReviews] = useState<Review[]>([]);
  const [statusFilter, setStatusFilter] = useState('OPEN');
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ review: Review; subjectDetail: SubjectDetail | null } | null>(null);
  const [policies, setPolicies] = useState<PolicyVersion[]>([]);
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [audit, setAudit] = useState<DecisionRow[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [txs, setTxs] = useState<TsTransaction[]>([]);
  const [txMetrics, setTxMetrics] = useState<TxMetrics | null>(null);
  const [txStatusFilter, setTxStatusFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  // One resolution form per open item.
  const [form, setForm] = useState<{ reasonCode: string; reason: string; evidence: string }>({ reasonCode: '', reason: '', evidence: '' });

  const call = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...init?.headers },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.message ?? body.error ?? res.statusText) as Error & { code?: string; body?: Record<string, unknown> };
      err.code = body.error; err.body = body;
      throw err;
    }
    return body as T;
  }, [token]);

  const signIn = async () => {
    setAuthError(null);
    try {
      const r = await call<{ token: string; reviewer: Reviewer }>('/auth/reviewer/login', { method: 'POST', body: JSON.stringify({ reviewerId: reviewerId.trim(), secret }) });
      setToken(r.token); setMe(r.reviewer); setSecret('');
      say(`Signed in as ${r.reviewer.name} — every decision will be recorded against this identity.`);
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : 'Sign-in failed.');
    }
  };
  const signOut = () => { setToken(null); setMe(null); setReviews([]); setDetail(null); setOpen(null); };

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    if (DEMO) {
      setReviews(demoReviews.filter((r) => matchesFilter(r, statusFilter)));
      setPolicies(demoPolicies); setReviewers(demoReviewers); setAudit(demoAudit); setMetrics(demoMetrics);
      setTxs(demoTxs.filter((x) => !txStatusFilter || x.status === txStatusFilter)); setTxMetrics(demoTxMetrics);
      return;
    }
    try {
      if (tab === 'agentreview') {
        // Fetched whole and filtered here: a decision changes an item's status, and an
        // item you are deciding must not vanish out from under you mid-decision.
        const all = (await call<{ items: Review[] }>('/ts/compliance/reviews')).items;
        setReviews(all.filter((r) => matchesFilter(r, statusFilter)));
        setMetrics(await call<Metrics>('/ts/compliance/metrics'));
      }
      if (tab === 'agentpolicy') setPolicies((await call<{ items: PolicyVersion[] }>('/ts/compliance/policies')).items);
      if (tab === 'agentreviewers') {
        setReviewers((await call<{ items: Reviewer[] }>('/ts/reviewers')).items);
        setAudit((await call<{ items: DecisionRow[] }>('/ts/compliance/audit')).items);
      }
      if (tab === 'agenttransactions') {
        const q = txStatusFilter ? `?status=${encodeURIComponent(txStatusFilter)}` : '';
        setTxs((await call<{ items: TsTransaction[] }>(`/ts/transactions${q}`)).items);
        setTxMetrics(await call<TxMetrics>('/ts/transactions/metrics'));
      }
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === 'REVIEWER_REVOKED' || err.code === 'REVIEWER_AUTH_REQUIRED') { signOut(); setAuthError('This reviewer session has ended. Sign in again.'); return; }
      setError(err.message);
    }
  }, [token, tab, statusFilter, txStatusFilter, call]);

  useEffect(() => { void load(); }, [load]);

  const openItem = async (id: string) => {
    setOpen(id); setForm({ reasonCode: '', reason: '', evidence: '' }); setError(null);
    if (DEMO) { const r = demoReviews.find((x) => x.id === id)!; setDetail({ review: r, subjectDetail: demoSubjectDetail[id] ?? null }); return; }
    try { setDetail(await call<{ review: Review; subjectDetail: SubjectDetail | null }>(`/ts/compliance/reviews/${id}`)); } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
  };

  const act = async (r: Review, path: string, body: Record<string, unknown>, okMsg: string) => {
    setError(null);
    if (DEMO) { say(`${okMsg} (demo — nothing was recorded)`); return; }
    try {
      const out = await call<{ review: Review }>(`/ts/compliance/reviews/${r.id}/${path}`, { method: 'POST', body: JSON.stringify({ ...body, expectedRev: r.rev }) });
      say(okMsg);
      setDetail((cur) => (cur ? { ...cur, review: out.review } : cur));
      await load();
    } catch (e) {
      const err = e as Error & { code?: string };
      // The two refusals worth naming in the UI: a reviewer never overrides an
      // active prohibition, and an uncertain rule status is a policy question.
      if (err.code === 'REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE') setError('An ACTIVE encoded rule prohibits this. No reviewer can approve past it — reject it, or change the policy version through dual control.');
      else if (err.code === 'REVIEW_REQUIRES_POLICY_VERSION') setError('The deciding rule\'s operative status is uncertain. That is a policy question: publish a named version under dual control, then re-evaluate.');
      else setError(err.message);
    }
  };

  const resolve = (r: Review, outcome: 'APPROVED' | 'REJECTED') => {
    const evidenceRefs = form.evidence.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!form.reasonCode.trim() || !form.reason.trim()) return say('A reason code and a written reason are required.');
    if (outcome === 'APPROVED' && evidenceRefs.length === 0) return say('An approval must cite at least one evidence reference.');
    void act(r, 'resolve', { outcome, reasonCode: form.reasonCode.trim(), reason: form.reason.trim(), evidenceRefs }, `Recorded as ${outcome.toLowerCase()}, attributed to you.`);
  };

  const approvePolicy = async (p: PolicyVersion) => {
    setError(null);
    if (DEMO) { say(`${p.id} would be published — a DIFFERENT administrator must approve what one proposed (demo).`); return; }
    try { await call(`/ts/compliance/policies/${p.id}/approve`, { method: 'POST', body: JSON.stringify({}) }); say(`${p.id} published. Open contexts evaluated under an older version are flagged for re-evaluation.`); await load(); } catch (e) {
      const err = e as Error & { code?: string };
      setError(err.code === 'POLICY_DUAL_CONTROL_REQUIRED' ? 'Dual control: the approving administrator must be a different person from the proposer.' : err.message);
    }
  };

  // -------------------------------------------------------------- sign-in
  if (!token || !me) {
    return (
      <div className="list-rows" data-testid="reviewer-signin">
        <div className="notice">
          <b>This console's admin key is not a reviewer identity.</b> An authoritative compliance decision — verifying a licence facet,
          resolving a client dispute, confirming a declared representation, settling a conflict question — is recorded against a named,
          authenticated Trust &amp; Safety reviewer. Sign in with your own reviewer credentials. Nothing you do here is anonymous.
        </div>
        <div className="list-row" style={{ gap: 8 }}>
          <input placeholder="Reviewer id" value={reviewerId} onChange={(e) => setReviewerId(e.target.value)} aria-label="Reviewer id" data-testid="reviewer-id" />
          <input type="password" placeholder="Reviewer secret" value={secret} onChange={(e) => setSecret(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && signIn()} aria-label="Reviewer secret" data-testid="reviewer-secret" />
          <button className="primary" onClick={signIn} data-testid="reviewer-signin-go">Sign in</button>
        </div>
        {authError && <div className="notice block" role="alert" data-testid="reviewer-auth-error">{authError}</div>}
        <div className="notice">
          Reviewer identities are provisioned by a Trust &amp; Safety administrator, or in production by the operator bootstrap
          (TS_REVIEWER_BOOTSTRAP_*). Development builds seed three named reviewers so this lane can be exercised.
        </div>
      </div>
    );
  }

  const who = (
    <div className="list-row" data-testid="reviewer-who">
      <span className="grow"><b>{me.name}</b> <span className="dim">· {ROLE_LABEL[me.role]} · {me.id}</span></span>
      <span className="pill green">authenticated reviewer</span>
      <button onClick={signOut}>Sign out</button>
    </div>
  );

  // -------------------------------------------------------------- queue
  if (tab === 'agentreview') {
    const item = detail?.review ?? null;
    return (
      <div className="list-rows">
        {who}
        <div className="notice">
          A reviewer resolves missing or uncertain <b>facts</b> against cited evidence. A reviewer never rewrites policy: an approval that
          would override a prohibition an ACTIVE rule states is refused, and an uncertain rule status goes back to policy, under dual control.
        </div>
        {error && <div className="notice block" role="alert" data-testid="review-error">{error}</div>}
        <div className="list-row" style={{ gap: 8 }}>
          <label className="chk">Status
            <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); }} aria-label="Filter by status" data-testid="status-filter">
              {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s] ?? s.toLowerCase()}</option>)}
            </select>
          </label>
          <span className="grow dim">{reviews.length} item(s)</span>
          <button onClick={() => void load()}>↻ Refresh</button>
        </div>
        {metrics && (
          <div className="stat-grid" data-testid="review-metrics">
            <div className="stat"><div className="v">{metrics.reviews.byStatus.PENDING ?? 0}</div><div className="k">Awaiting review</div></div>
            <div className="stat"><div className="v">{metrics.reviews.byStatus.IN_REVIEW ?? 0}</div><div className="k">In review</div></div>
            <div className="stat"><div className="v">{metrics.reviews.medianDurationMs === null ? '—' : `${Math.round(metrics.reviews.medianDurationMs / 60000)}m`}</div><div className="k">Median time to decide</div></div>
            <div className="stat"><div className="v">{metrics.consents.granted}/{metrics.consents.requested}</div><div className="k">Consents granted</div></div>
            <div className="stat"><div className="v">{metrics.staleFacets}</div><div className="k">Stale verifications</div></div>
          </div>
        )}

        {/* The item being worked on lives in its OWN panel. A decision changes its
            status, and an item must not vanish out from under the person deciding it
            because the list filter no longer matches. */}
        {item && (
          <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }} data-testid="review-detail" data-review={item.id} data-status={item.status}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="pill">{KIND_LABEL[item.kind] ?? item.kind}</span>
              <span className="grow dim">{item.id} · raised {when(item.requestedAt)}{item.policyVersions.length ? ` · ${item.policyVersions.join(', ')}` : ''}</span>
              {item.startedBy && <span className="dim">started by {item.startedBy.name}</span>}
              <span className={`pill ${item.status === 'PENDING' ? 'gold' : item.status === 'IN_REVIEW' ? 'blue' : item.status === 'APPROVED' ? 'green' : item.status === 'REJECTED' ? 'red' : ''}`} data-testid="open-status">{item.status.replace(/_/g, ' ').toLowerCase()}</span>
              <button onClick={() => { setOpen(null); setDetail(null); }}>Close</button>
            </div>
            <div className="dim">{item.reasons.map((x) => `${x.code}${x.ruleId ? ` (${x.ruleId}: ${x.ruleStatus})` : ''}`).join(' · ') || '—'}</div>
            <div className="notice" data-testid="subject-detail">
              <b>What this review needs.</b>{' '}
              {detail?.subjectDetail
                ? Object.entries(detail.subjectDetail).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ')
                : 'The subject record is no longer available; the item can still be closed.'}
            </div>
            {item.snapshot && <div className="dim">Snapshot at the time it was raised: {JSON.stringify(item.snapshot).slice(0, 400)}</div>}
            {item.decision ? (
              <div className="notice" data-testid="review-decision">
                <b>{item.decision.outcome}</b> by {item.decision.reviewer.name} ({ROLE_LABEL[item.decision.reviewer.role] ?? item.decision.reviewer.role}) · {item.decision.reasonCode}
                {item.decision.reason ? <div>{item.decision.reason}</div> : null}
                {item.decision.evidenceRefs?.length ? <div className="dim">evidence: {item.decision.evidenceRefs.join(' · ')}</div> : null}
                {item.decision.resultingState ? <div className="dim">resulting state: {JSON.stringify(item.decision.resultingState)}</div> : null}
                {['APPROVED', 'REJECTED'].includes(item.status) && !item.supersededBy && (
                  <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input style={{ flex: 1 }} placeholder="Why this decision should be reconsidered" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} aria-label="Reason to supersede" />
                    <button onClick={() => void act(item, 'supersede', { reason: form.reason }, 'A new review supersedes it. The original decision is retained, untouched.')} data-testid="supersede">Supersede</button>
                  </div>
                )}
                {item.supersededBy && <div className="dim">superseded by {item.supersededBy}</div>}
              </div>
            ) : (
              <>
                {item.status === 'PENDING' && <div><button className="primary" onClick={() => void act(item, 'start', {}, 'Started — the item is attributed to you.')} data-testid="start">Start review</button></div>}
                <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                  <label>Reason code<input value={form.reasonCode} onChange={(e) => setForm({ ...form, reasonCode: e.target.value })} placeholder="e.g. fa_list_match" data-testid="reason-code" /></label>
                  <label>Written reason<input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="What you examined and concluded" data-testid="reason-text" /></label>
                </div>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, color: 'var(--muted)' }}>
                  Evidence references (one per line; required to approve)
                  <textarea rows={3} value={form.evidence} onChange={(e) => setForm({ ...form, evidence: e.target.value })} data-testid="evidence" />
                </label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="primary" onClick={() => resolve(item, 'APPROVED')} data-testid="approve">Approve</button>
                  <button onClick={() => resolve(item, 'REJECTED')} data-testid="reject">Reject</button>
                  <button onClick={() => { if (!form.reason.trim()) return say('Cancelling needs a written reason.'); void act(item, 'cancel', { reason: form.reason.trim() }, 'Cancelled. Nothing about the subject changed.'); }} data-testid="cancel">Cancel item</button>
                </div>
                <div className="dim">
                  Your name, role and the evidence you cite are recorded with the decision and shown to the agency as an attributed
                  role — never as an anonymous action, and never with your reason text.
                </div>
              </>
            )}
          </div>
        )}

        {reviews.length === 0 && <div className="notice">Nothing at this status.</div>}
        {reviews.map((r) => (
          <div key={r.id} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }} data-testid={`review-${r.id}`} data-status={r.status}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="pill">{KIND_LABEL[r.kind] ?? r.kind}</span>
              <span className="grow dim">{r.id} · raised {when(r.requestedAt)}{r.policyVersions.length ? ` · ${r.policyVersions.join(', ')}` : ''}</span>
              {r.startedBy && <span className="dim">started by {r.startedBy.name}</span>}
              <span className={`pill ${r.status === 'PENDING' ? 'gold' : r.status === 'IN_REVIEW' ? 'blue' : r.status === 'APPROVED' ? 'green' : r.status === 'REJECTED' ? 'red' : ''}`}>{r.status.replace(/_/g, ' ').toLowerCase()}</span>
              <button onClick={() => (open === r.id ? (setOpen(null), setDetail(null)) : void openItem(r.id))} data-testid={`open-${r.id}`}>{open === r.id ? 'Close' : 'Open'}</button>
            </div>
            <div className="dim">{r.reasons.map((x) => `${x.code}${x.ruleId ? ` (${x.ruleId}: ${x.ruleStatus})` : ''}`).join(' · ') || '—'}</div>
          </div>
        ))}
        {metrics && <div className="notice" data-testid="metrics-note">{metrics.note}</div>}
      </div>
    );
  }


  // -------------------------------------------------------------- policy
  if (tab === 'agentpolicy') {
    return (
      <div className="list-rows">
        {who}
        <div className="notice">
          A rule's <b>text</b> and its <b>operative status</b> are separate facts. Publishing a version is dual-controlled: one
          administrator proposes it, a different one approves it. Publishing never re-verdicts an existing evaluation — open contexts are
          flagged for re-evaluation instead.
        </div>
        {error && <div className="notice block" role="alert" data-testid="policy-error">{error}</div>}
        {policies.map((p) => (
          <div key={p.id} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }} data-testid={`policy-${p.id}`} data-status={p.status}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="grow"><b>{p.id}</b> <span className="dim">· {p.regulator} · {p.jurisdiction} · v{p.policyVersion}{p.supersedes ? ` · supersedes ${p.supersedes}` : ''}</span></span>
              <span className={`pill ${p.status === 'published' ? 'green' : 'gold'}`}>{p.status}</span>
              <span className="dim">in effect from {p.effectiveFrom}{p.effectiveTo ? ` to ${p.effectiveTo}` : ''}</span>
              {p.status === 'proposed' && me.role === 'trust_safety_admin' && <button className="primary" onClick={() => void approvePolicy(p)} data-testid={`approve-${p.id}`}>Approve &amp; publish</button>}
            </div>
            <div className="dim">
              {p.proposedBy ? `proposed by ${p.proposedBy.name}` : 'seeded by migration'}
              {p.approvedBy ? ` · approved by ${p.approvedBy.name} ${when(p.approvedBy.at)}` : ''}
              {p.publishedAt ? ` · published ${when(p.publishedAt)}` : ''}
            </div>
            {p.rules && (
              <table className="data" style={{ marginTop: 6 }}>
                <thead><tr><th>Rule</th><th>Operative status</th><th>Source</th><th>Note</th></tr></thead>
                <tbody>
                  {Object.entries(p.rules).map(([rid, rule]) => (
                    <tr key={rid} data-testid={`rule-${rid}`}>
                      <td>{rid}</td>
                      <td><span className={`pill ${rule.ruleStatus === 'ACTIVE' ? 'green' : rule.ruleStatus === 'SUSPENDED' ? 'red' : 'gold'}`}>{rule.ruleStatus.replace(/_/g, ' ').toLowerCase()}</span></td>
                      <td className="dim">{rule.sourceRef ?? '—'}</td>
                      <td className="dim">{rule.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
        {policies.length === 0 && <div className="notice">No policy version is stored. Until one is, every jurisdiction reads as unsupported and nothing proceeds automatically.</div>}
      </div>
    );
  }

  // ------------------------------------------------------- transactions (P5.6D)
  // A READ, not a console. Trust & Safety sees states, ids, party ROLES and
  // process counts; it cannot confirm a party, write a note, read a document or
  // move a transaction, because none of those are Trust & Safety's to do. A
  // compliance question about one is answered through the review queue, where a
  // named reviewer resolves facts against cited evidence.
  if (tab === 'agenttransactions') {
    return (
      <div className="list-rows" data-testid="ts-transactions">
        {who}
        <div className="notice">
          Agent transaction workspaces, as states and party <b>roles</b>. The parties' documents, notes, conversations and working
          particulars are theirs and are not shown here. Nothing on this tab changes a transaction: a compliance question is answered in
          the review queue, by a named reviewer, against cited evidence.
        </div>
        {error && <div className="notice block" role="alert" data-testid="tx-error">{error}</div>}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor="tx-status">Status</label>
          <select id="tx-status" value={txStatusFilter} onChange={(e) => setTxStatusFilter(e.target.value)} data-testid="tx-status-filter">
            <option value="">every status</option>
            {TX_STATUSES.map((st) => <option key={st} value={st}>{TX_STATUS_LABEL[st] ?? st}</option>)}
          </select>
          <span className="dim">{txs.length} shown</span>
        </div>
        {txMetrics && (
          <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }} data-testid="tx-metrics">
            <b>Process metrics</b>
            <div className="dim">
              median time open {ms(txMetrics.medianDurationMs)} · median time in compliance pending {ms(txMetrics.medianCompliancePendingMs)} ·
              median consent wait {ms(txMetrics.medianConsentWaitMs)} · stale compliance snapshots {txMetrics.staleSnapshots}
            </div>
            <div className="dim">
              {TX_STATUSES.filter((st) => (txMetrics.byStatus[st] ?? 0) > 0).map((st) => `${TX_STATUS_LABEL[st] ?? st}: ${txMetrics.byStatus[st]}`).join(' · ') || 'no transaction yet'}
            </div>
            <div className="dim" style={{ fontSize: 12 }}>{txMetrics.note}</div>
          </div>
        )}
        {txs.length === 0 && <div className="notice" data-testid="tx-empty">No transaction matches.</div>}
        {txs.map((x) => {
          const c = x.compliance;
          const word = !c ? 'not evaluated' : c.blocked ? 'blocked by policy' : c.stale ? 'needs re-checking' : c.clear ? 'clear' : (c.pendingReason ?? 'pending');
          const cls = !c ? '' : c.blocked ? 'red' : c.clear && !c.stale ? 'green' : 'gold';
          return (
            <div key={x.id} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }} data-testid={`ts-tx-${x.id}`} data-status={x.status}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="grow"><b>{x.id}</b> <span className="dim">· {x.type.replace(/_/g, ' ')} · {x.jurisdictions.join(', ') || 'no jurisdiction resolved'} · agency {x.agencyOrgId}</span></span>
                <span className="pill">{TX_STATUS_LABEL[x.status] ?? x.status}</span>
                <span className={`pill ${cls}`}>{word}</span>
              </div>
              <div className="dim">
                parties: {x.parties.map((pt) => `${pt.partyRole.replace(/_/g, ' ')} (${pt.subjectKind}${pt.removed ? ', removed' : pt.confirmed ? ', confirmed' : ', unconfirmed'})`).join(' · ') || 'none'}
              </div>
              <div className="dim">
                representation: {x.representations.map((r) => `${r.partyRole.replace(/_/g, ' ')} — ${r.status}${r.declaredOnly ? ' (declared, not yet reviewed)' : ''}`).join(' · ') || 'none attached'}
              </div>
              {c && (
                <div className="dim">
                  {c.outcome ?? 'no outcome'}{c.reasonCodes.length ? ` · ${c.reasonCodes.join(', ')}` : ''}
                  {c.policyVersions.length ? ` · policy ${c.policyVersions.join(', ')}` : ''}
                  {c.evaluatedAt ? ` · evaluated ${when(c.evaluatedAt)}` : ''}{c.stale ? ` · snapshot stale (${c.stale})` : ''}
                </div>
              )}
              {x.reviews.length > 0 && (
                <div className="dim">open review: {x.reviews.map((r) => `${r.id} (${KIND_LABEL[r.kind] ?? r.kind}, ${r.status})`).join(' · ')}</div>
              )}
              <div className="dim" style={{ fontSize: 12 }}>
                {x.documentCount} document{x.documentCount === 1 ? '' : 's'} · {x.noteCount} note{x.noteCount === 1 ? '' : 's'} ·
                {' '}{x.linkedThreadCount} linked conversation{x.linkedThreadCount === 1 ? '' : 's'} · opened {when(x.createdAt)} · last change {when(x.updatedAt)} · rev {x.rev}
                {' '}<span title="Counts only. The contents are the parties' and are not exposed to this console.">(counts only)</span>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // -------------------------------------------------------------- reviewers
  return (
    <div className="list-rows">
      {who}
      <div className="notice">
        Reviewer identities and the decision record. Only an administrator provisions or revokes one, at least one administrator must
        remain, and revoking ends that reviewer's sessions immediately. Decisions made before a revocation keep their attribution.
      </div>
      {error && <div className="notice block" role="alert" data-testid="reviewers-error">{error}</div>}
      {reviewers.map((r) => (
        <div key={r.id} className="list-row" data-testid={`reviewer-${r.id}`} data-status={r.status}>
          <span className="grow"><b>{r.name}</b> <span className="dim">· {ROLE_LABEL[r.role]} · {r.id} · since {when(r.createdAt)}</span></span>
          <span className={`pill ${r.status === 'active' ? 'green' : 'red'}`}>{r.status}</span>
          {r.status === 'active' && me.role === 'trust_safety_admin' && r.id !== me.id && (
            <button onClick={async () => {
              if (!window.confirm(`Revoke ${r.name}?\n\nTheir sessions end now. Every decision they have made keeps their name.`)) return;
              if (DEMO) return say('Revoked (demo — nothing was recorded).');
              try { await call(`/ts/reviewers/${r.id}/revoke`, { method: 'POST', body: JSON.stringify({ reason: 'revoked from the console', expectedRev: r.rev }) }); say('Revoked. Their sessions have ended.'); await load(); } catch (e) {
                const err = e as Error & { code?: string };
                setError(err.code === 'LAST_REVIEWER_ADMIN' ? 'At least one Trust & Safety administrator must remain.' : err.message);
              }
            }} data-testid={`revoke-${r.id}`}>Revoke</button>
          )}
        </div>
      ))}
      {me.role === 'trust_safety_admin' && <ProvisionReviewer onDone={load} call={call} say={say} setError={setError} />}
      <h4 style={{ color: 'var(--muted)', marginTop: 12 }}>Decision record (attributed)</h4>
      <table className="data" data-testid="decision-audit">
        <thead><tr><th>When</th><th>Action</th><th>Item</th><th>Kind</th><th>Reviewer</th><th>Outcome</th><th>Evidence</th></tr></thead>
        <tbody>
          {audit.map((a) => (
            <tr key={a.id}>
              <td>{when(a.at)}</td>
              <td>{a.action.replace(/regulatory_review_/, '').replace(/_/g, ' ')}</td>
              <td className="dim">{a.reviewId}</td>
              <td>{KIND_LABEL[a.kind] ?? a.kind}</td>
              <td>{a.reviewer ? `${a.reviewer.name} (${ROLE_LABEL[a.reviewer.role] ?? a.reviewer.role})` : '—'}</td>
              <td>{a.outcome ?? '—'}{a.reasonCode ? ` · ${a.reasonCode}` : ''}</td>
              <td>{a.evidenceCount ?? '—'}</td>
            </tr>
          ))}
          {audit.length === 0 && <tr><td colSpan={7} className="dim">No decision yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function ProvisionReviewer({ onDone, call, say, setError }: {
  onDone: () => Promise<void> | void;
  call: <T,>(path: string, init?: RequestInit) => Promise<T>;
  say: (t: string) => void;
  setError: (m: string | null) => void;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'trust_safety_reviewer' | 'trust_safety_admin'>('trust_safety_reviewer');
  const [secret, setSecret] = useState('');
  return (
    <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }} data-testid="provision-reviewer">
      <b>Provision a reviewer</b>
      <div className="form-grid">
        <label>Reviewer id<input value={id} onChange={(e) => setId(e.target.value)} placeholder="tsr-…" /></label>
        <label>Name (as the record will show it)<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Role
          <select value={role} onChange={(e) => setRole(e.target.value as 'trust_safety_reviewer' | 'trust_safety_admin')}>
            <option value="trust_safety_reviewer">Reviewer</option>
            <option value="trust_safety_admin">Administrator</option>
          </select>
        </label>
        <label>Initial secret (12+ characters)<input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
      </div>
      <div>
        <button className="primary" disabled={!id.trim() || !name.trim() || secret.length < 12} onClick={async () => {
          setError(null);
          if (DEMO) return say('Provisioned (demo — nothing was recorded).');
          try { await call('/ts/reviewers', { method: 'POST', body: JSON.stringify({ id: id.trim(), name: name.trim(), role, secret }) }); say(`${name.trim()} can now sign in and will be named on every decision they make.`); setId(''); setName(''); setSecret(''); await onDone(); } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
        }}>Provision</button>
      </div>
    </div>
  );
}
