// Demo mirror of the individual's transaction view (EXPO_PUBLIC_DEMO=1).
// Synthetic examples; state lives in this tab's memory and resets on reload.
// Mirrors the server's rules where the screen depends on them: a minor has no
// transactions at all, only the individual's own party row can be confirmed,
// confirming is idempotent, and nothing here is an offer or a signature.
import type { PlayerM26, PlayerTransaction, TxTimelineEntry } from './m26client';

const NOW = Date.now();
const DAY = 86_400_000;
const delay = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), 100));
class MockError extends Error { constructor(public code: string, message: string) { super(message); } }

const HONEST = 'A ScoutBox transaction is a permissioned workspace. "Ready" means ScoutBox currently permits this workflow to proceed under the encoded rules — it is not a statement of legal validity, no governing body has approved anything, no offer exists and nothing has been signed.';
const HONEST_OFFER = 'Readiness means ScoutBox currently permits this workflow to proceed under the encoded rules. No offer exists, no offer can be created here, and nothing has been agreed, approved or signed.';
const HONEST_COMPLIANCE = 'ScoutBox has evaluated its own encoded rules. It has not determined anyone’s legal rights and no governing body has approved anything.';

const TXS: Record<string, PlayerTransaction[]> = {
  'pl-adeyemi': [
    {
      id: 'atx-d1', type: 'employment_contract', status: 'PARTIES_CONFIRMED', jurisdictions: ['ENG'],
      viewerRoles: ['party_individual'], agency: { id: 'org-northstar', name: 'North Star Sports Agency' },
      parties: [
        { id: 'p1', partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi', name: 'You', removed: false, confirmedAt: null, confirmedByKind: null },
        { id: 'p2', partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport', name: 'Eastport FC', removed: false, confirmedAt: NOW - DAY, confirmedByKind: 'club_user' },
      ],
      awaitingConfirmation: ['individual'], partiesConfirmed: false,
      representations: [{ id: 'r1', partyRole: 'individual', status: 'verified', basis: 'client_confirmed_agreement', scope: ['employment'] }],
      compliance: { outcome: null, pendingReason: 'PARTIES_NOT_CONFIRMED', blocked: false, clear: false, reasonCodes: [], evaluatedAt: NOW - DAY, staleness: null, honest: HONEST_COMPLIANCE },
      consents: [],
      documents: [{ id: 'd1', documentType: 'term_sheet_draft', visibility: 'ALL_TRANSACTION_PARTIES', version: 1, label: 'Draft term sheet', uploadedAt: NOW - DAY, actor: { kind: 'agent', label: 'Representing agent' }, downloadable: false }],
      notes: [],
      offerBoundary: { canStartOfferWorkflow: false, blockers: ['TRANSACTION_NOT_READY', 'COMPLIANCE_NOT_CLEAR', 'INDIVIDUAL_NOT_CONFIRMED'], honest: HONEST_OFFER },
      updatedAt: NOW - DAY, rev: 3, honest: HONEST,
    },
    {
      id: 'atx-d2', type: 'transfer', status: 'READY', jurisdictions: ['ENG'],
      viewerRoles: ['party_individual'], agency: { id: 'org-northstar', name: 'North Star Sports Agency' },
      parties: [
        { id: 'p3', partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi', name: 'You', removed: false, confirmedAt: NOW - 6 * DAY, confirmedByKind: 'player' },
        { id: 'p4', partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-harbour', name: 'Harbour City FC', removed: false, confirmedAt: NOW - 6 * DAY, confirmedByKind: 'club_user' },
        { id: 'p5', partyRole: 'releasing_entity', subjectKind: 'club', subjectId: 'org-eastport', name: 'Eastport FC', removed: false, confirmedAt: NOW - 5 * DAY, confirmedByKind: 'club_user' },
      ],
      awaitingConfirmation: [], partiesConfirmed: true,
      representations: [{ id: 'r2', partyRole: 'individual', status: 'verified', basis: 'client_confirmed_agreement', scope: ['transfer'] }],
      compliance: { outcome: 'CLEAR', pendingReason: null, blocked: false, clear: true, reasonCodes: [], evaluatedAt: NOW - 4 * DAY, staleness: null, honest: HONEST_COMPLIANCE },
      consents: [{ id: 'rcs-mine', kind: 'dual_representation', partyRole: 'individual', status: 'granted', mine: true, requestedAt: NOW - 5 * DAY, grantedAt: NOW - 5 * DAY, revokedAt: null }],
      documents: [],
      notes: [{ id: 'n1', visibility: 'PLAYER_AGENT_SHARED', text: 'Agreed to look at the medical dates next week.', at: NOW - 4 * DAY }],
      offerBoundary: { canStartOfferWorkflow: true, blockers: [], honest: HONEST_OFFER },
      updatedAt: NOW - 4 * DAY, rev: 6, honest: HONEST,
    },
  ],
};

const TIMELINE: Record<string, TxTimelineEntry[]> = {
  'atx-d1': [
    { id: 't2', at: NOW - DAY, action: 'transaction_party_confirmed', audience: 'all_parties', actor: { kind: 'club', label: 'Club signatory' }, detail: { partyRole: 'engaging_entity' } },
    { id: 't1', at: NOW - 2 * DAY, action: 'transaction_created', audience: 'all_parties', actor: { kind: 'agent', label: 'Representing agent' }, detail: { count: 2 } },
  ],
  'atx-d2': [
    { id: 't5', at: NOW - 4 * DAY, action: 'transaction_compliance_evaluated', audience: 'all_parties', actor: { kind: 'system', label: 'ScoutBox' }, detail: { outcome: 'CLEAR' } },
    { id: 't4', at: NOW - 5 * DAY, action: 'transaction_party_confirmed', audience: 'all_parties', actor: { kind: 'player', label: 'Player' }, detail: { partyRole: 'individual' } },
    { id: 't3', at: NOW - 7 * DAY, action: 'transaction_created', audience: 'all_parties', actor: { kind: 'agent', label: 'Representing agent' }, detail: { count: 3 } },
  ],
};

export const m26mock: PlayerM26 = {
  async list(playerId) {
    // A guardian-managed account has no transaction workspace at all.
    if (playerId === 'pl-guni' || playerId.startsWith('pl-minor')) {
      return delay({ items: [], minor: true, note: 'Agent transactions are not available for under-18 accounts in ScoutBox.' });
    }
    return delay({ items: TXS[playerId] ?? [], note: HONEST });
  },
  async confirm(playerId, id) {
    const tx = (TXS[playerId] ?? []).find((t) => t.id === id);
    if (!tx) throw new MockError('TRANSACTION_NOT_FOUND', 'No transaction with that reference is available to you.');
    const mine = tx.parties.find((p) => p.subjectKind === 'player' && p.subjectId === playerId);
    if (!mine) throw new MockError('TRANSACTION_NOT_FOUND', 'No transaction with that reference is available to you.');
    if (!mine.confirmedAt) {
      mine.confirmedAt = Date.now();
      mine.confirmedByKind = 'player';
      tx.awaitingConfirmation = tx.awaitingConfirmation.filter((r) => r !== 'individual');
      tx.partiesConfirmed = tx.awaitingConfirmation.length === 0;
      tx.compliance.pendingReason = tx.partiesConfirmed ? 'REPRESENTATION_MISSING' : 'PARTIES_NOT_CONFIRMED';
      tx.rev += 1;
      tx.updatedAt = Date.now();
      (TIMELINE[tx.id] ??= []).unshift({ id: `t-${tx.rev}`, at: Date.now(), action: 'transaction_party_confirmed', audience: 'all_parties', actor: { kind: 'player', label: 'Player' }, detail: { partyRole: 'individual' } });
    }
    return delay(tx);
  },
  async timeline(_playerId, id) {
    return delay({ items: TIMELINE[id] ?? [], note: 'The timeline is what you may see of what happened in this transaction.' });
  },
};
