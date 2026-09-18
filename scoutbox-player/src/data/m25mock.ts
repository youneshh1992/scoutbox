// Demo mirror of the player's consent card (EXPO_PUBLIC_DEMO=1).
// Synthetic examples; state lives in this tab's memory and resets on reload.
// Mirrors the server's rules: granting needs both acknowledgements, only a
// granted consent can be revoked, a declined one is final for that request,
// and a minor has no consents at all.
import type { AgentConsentRequest, PlayerM25 } from './m25client';

const NOW = Date.now();
const DAY = 86_400_000;
const delay = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), 100));
class MockError extends Error { constructor(public code: string, message: string) { super(message); } }

const HONEST = 'You may decline. Consent is specific to this agent, this transaction context and these parties; it can be revoked at any time, and a revocation stops any future regulated action that needs it. ScoutBox records your answer; it does not advise you.';

const REQS: Record<string, AgentConsentRequest[]> = {
  'pl-adeyemi': [
    {
      id: 'rcs-d1', kind: 'dual_representation', status: 'requested', partyRole: 'individual',
      agent: { userId: 'usr-ana', displayName: 'Ana Costa', agency: 'North Star Sports Agency', licence: 'VERIFIED' },
      context: {
        id: 'ctx-d1', type: 'employment_contract', jurisdictions: ['ENG'],
        parties: [{ partyRole: 'individual', subjectKind: 'player', name: 'You' }, { partyRole: 'engaging_entity', subjectKind: 'club', name: 'Eastport FC' }],
      },
      otherPartyRoles: ['engaging_entity'],
      particulars: { fullParticularsProvided: true, legalAdviceOffered: true, proposedFeeDisclosed: true, acknowledged: null },
      policyVersions: ['jp-fifa-2025-1', 'jp-eng-2026-27-1'], ruleIds: ['ENG-6.3'],
      requestedAt: NOW - 2 * 3600e3, grantedAt: null, declinedAt: null, revokedAt: null, rev: 1, honest: HONEST,
    },
    {
      id: 'rcs-d0', kind: 'dual_representation', status: 'granted', partyRole: 'individual',
      agent: { userId: 'usr-ana', displayName: 'Ana Costa', agency: 'North Star Sports Agency', licence: 'VERIFIED' },
      context: {
        id: 'ctx-d0', type: 'transfer', jurisdictions: ['ENG'],
        parties: [{ partyRole: 'individual', subjectKind: 'player', name: 'You' }, { partyRole: 'engaging_entity', subjectKind: 'club', name: 'Harbour City FC' }],
      },
      otherPartyRoles: ['engaging_entity'],
      particulars: { fullParticularsProvided: true, legalAdviceOffered: true, proposedFeeDisclosed: true, acknowledged: { particulars: true, legalAdvice: true, at: NOW - 20 * DAY } },
      policyVersions: ['jp-fifa-2025-1', 'jp-eng-2026-27-1'], ruleIds: ['ENG-6.3'],
      requestedAt: NOW - 21 * DAY, grantedAt: NOW - 20 * DAY, declinedAt: null, revokedAt: null, rev: 2, honest: HONEST,
    },
  ],
};

export const m25mock: PlayerM25 = {
  list: (pid) => {
    if (pid === 'pl-guni' || pid === 'pl-tomasz') return delay({ items: [], minor: true, note: 'Agent representation and its consents are not available for under-18 accounts in ScoutBox.' });
    return delay({ items: (REQS[pid] ?? []).slice().sort((a, b) => b.requestedAt - a.requestedAt) });
  },
  answer: (pid, id, action, input) => {
    const k = (REQS[pid] ?? []).find((x) => x.id === id);
    if (!k) throw new MockError('CONSENT_NOT_FOUND', 'Not found.');
    if (input.expectedRev !== k.rev) throw new MockError('CONSENT_VERSION_CONFLICT', 'This changed since you loaded it. Reload and try again.');
    if (action === 'revoke') {
      if (k.status !== 'granted') throw new MockError('CONSENT_NOT_PENDING', 'Only a granted consent can be revoked.');
      k.status = 'revoked'; k.revokedAt = Date.now(); k.rev += 1;
      return delay(k);
    }
    if (k.status !== 'requested') throw new MockError('CONSENT_NOT_PENDING', 'That request has already been answered.');
    if (action === 'grant') {
      if (!input.acknowledgedParticulars || !input.acknowledgedLegalAdvice) {
        throw new MockError('CONSENT_INPUT_INVALID', 'To grant, confirm you received the full particulars and were told you may take independent legal advice.');
      }
      k.status = 'granted'; k.grantedAt = Date.now();
      k.particulars = { ...(k.particulars ?? { fullParticularsProvided: true, legalAdviceOffered: true, proposedFeeDisclosed: true, acknowledged: null }), acknowledged: { particulars: true, legalAdvice: true, at: Date.now() } };
    } else {
      k.status = 'declined'; k.declinedAt = Date.now();
    }
    k.rev += 1;
    return delay(k);
  },
};
