// Demo mirror of the player's My Agent surface (EXPO_PUBLIC_DEMO=1).
// Synthetic examples; state lives in this tab's memory and resets on reload.
// Mirrors the server's rules: a proposal can be confirmed, declined or
// disputed; an active relationship can be ended or disputed; a dispute is
// terminal here; a minor sees nothing.
import type { AgentRelationship, PlayerM24 } from './m24client';

const NOW = Date.now();
const DAY = 86_400_000;
const delay = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), 100));
class MockError extends Error { constructor(public code: string, message: string) { super(message); } }

const HONEST = 'A ScoutBox relationship record. It is not a representation contract and ScoutBox has not assessed its legal validity; the client confirmed it in ScoutBox.';
const ANA = { userId: 'usr-ana', displayName: 'Ana Costa', agency: { id: 'org-northstar', name: 'North Star Sports Agency' }, verification: { fifaLicence: 'VERIFIED', jurisdictions: [{ memberAssociation: 'ENG', nationalRegistration: 'VERIFIED' }] }, honest: 'Verified against recorded provenance; check the provenance before relying on it.' };
const UNVERIFIED_AGENT = { userId: 'usr-tomas', displayName: 'Tomás Rivera', agency: { id: 'org-northstar', name: 'North Star Sports Agency' }, verification: { fifaLicence: 'MANUAL_REVIEW_REQUIRED', jurisdictions: [] }, honest: 'This agent\'s licence is NOT verified in ScoutBox.' };

const RELS: Record<string, AgentRelationship[]> = {
  'pl-adeyemi': [
    { id: 'rep-p1', status: 'proposed', pending: true, scope: ['employment', 'transfer'], exclusive: false, jurisdiction: 'ENG', termMonths: 18, startAt: null, endAt: null, proposedAt: NOW - 2 * DAY, confirmedAt: null, terminatedBy: null, disputeReason: null, shareWithAgencyStaff: false, legacy: null, rev: 1, honest: HONEST, agent: ANA },
    { id: 'rep-p2', status: 'proposed', pending: true, scope: ['commercial'], exclusive: false, jurisdiction: 'INT', termMonths: 12, startAt: null, endAt: null, proposedAt: NOW - DAY, confirmedAt: null, terminatedBy: null, disputeReason: null, shareWithAgencyStaff: false, legacy: null, rev: 1, honest: HONEST, agent: UNVERIFIED_AGENT },
  ],
};

export const m24mock: PlayerM24 = {
  list: (pid) => {
    if (pid === 'pl-guni' || pid === 'pl-tomasz') return delay({ items: [], minor: true, note: 'Agent representation is not available for under-18 accounts in ScoutBox.' });
    return delay({ items: (RELS[pid] ?? []).slice().sort((a, b) => (b.proposedAt ?? 0) - (a.proposedAt ?? 0)), note: 'Nothing is active until you confirm it. You can end an active relationship at any time; the record stays in your history.' });
  },
  act: (pid, id, action, input) => {
    const r = (RELS[pid] ?? []).find((x) => x.id === id);
    if (!r) throw new MockError('REPRESENTATION_NOT_FOUND', 'Not found.');
    if (input.expectedRev !== r.rev) throw new MockError('REPRESENTATION_VERSION_CONFLICT', 'This changed since you loaded it. Reload and try again.');
    const allowed: Record<string, string[]> = { proposed: ['confirm', 'decline', 'dispute'], active: ['terminate', 'dispute'] };
    if (!(allowed[r.status] ?? []).includes(action)) throw new MockError(r.status === 'disputed' ? 'REPRESENTATION_DISPUTED' : 'REPRESENTATION_NOT_ACTIVE', 'This relationship is not in a state that allows that.');
    const t = Date.now();
    if (action === 'confirm') { r.status = 'active'; r.pending = false; r.confirmedAt = t; r.startAt = t; r.endAt = t + (r.termMonths ?? 12) * 30 * DAY; }
    if (action === 'decline') { r.status = 'declined'; r.pending = false; }
    if (action === 'terminate') { r.status = 'terminated_by_client'; r.terminatedBy = 'client'; }
    if (action === 'dispute') { r.status = 'disputed'; r.pending = false; r.disputeReason = input.reason ?? null; }
    r.rev += 1;
    return delay(r);
  },
  setSharing: (pid, id, share, expectedRev) => {
    const r = (RELS[pid] ?? []).find((x) => x.id === id);
    if (!r) throw new MockError('REPRESENTATION_NOT_FOUND', 'Not found.');
    if (expectedRev !== r.rev) throw new MockError('REPRESENTATION_VERSION_CONFLICT', 'This changed since you loaded it. Reload and try again.');
    if (r.shareWithAgencyStaff !== share) { r.shareWithAgencyStaff = share; r.rev += 1; }
    return delay(r);
  },
};
