// M14 Trust & Safety additions: the Verification review centre — human-review
// queue, root organisation requests, domain requests, disputes, expiring and
// suspended claims, and the authority cascade tool. Every consequential
// decision requires a written reason (audited server-side). VITE_DEMO=1 runs
// on canned rows that mirror the honest server labels.
import { useCallback, useEffect, useState } from 'react';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
const DEMO = import.meta.env.VITE_DEMO === '1';

export type M14Tab = 'verification' | 'verdisputes';
export const M14_TABS: { id: M14Tab; label: string }[] = [
  { id: 'verification', label: 'Verification' },
  { id: 'verdisputes', label: 'Ver. disputes' },
];

interface ClaimRow {
  id: string; claimType: string; status: string; role: string | null;
  subject: { type: string; id: string; name: string };
  organisation: { id: string; name: string; status: string } | null;
  reviewReasons: string[]; riskFlags: string[]; assignedTo: string | null;
  createdAt: number; updatedAt: number;
}
interface RootReq {
  id: string; status: string; orgName: string; orgType: string; country: string;
  federation: string | null; website: string; domain: string; applicantName: string;
  applicantRole: string; workEmail: string; checks: Record<string, string>;
  riskFlags: string[]; reviewReasons: string[]; emailProved: boolean; createdAt: number;
}
interface DomainReq { id: string; orgId: string; domain: string; status: string; reviewReasons?: string[]; createdAt: number }
interface Dispute { id: string; claimId: string; byName: string; reason: string; status: string; createdAt: number; claim: ClaimRow | null }
interface Queue {
  humanReview: ClaimRow[]; rootRequests: RootReq[]; disputes: Omit<Dispute, 'claim'>[];
  suspended: ClaimRow[]; disputedClaims: ClaimRow[]; domainRequests: DomainReq[];
  expiring: ClaimRow[]; recentlyRevoked: ClaimRow[]; queueOldestMs: number;
}

const NOW = Date.now();
const cannedQueue: Queue = {
  humanReview: [
    { id: 'vclm-d1', claimType: 'PERSON_IDENTITY', status: 'requires_human_review', role: null, subject: { type: 'user', id: 'usr-tom', name: 'Tom Field' }, organisation: { id: 'org-eastport', name: 'Eastport United', status: 'verified' }, reviewReasons: ['DOCUMENT_AUTHENTICITY_UNCONFIRMED'], riskFlags: [], assignedTo: null, createdAt: NOW - 8 * 3600e3, updatedAt: NOW - 8 * 3600e3 },
    { id: 'vclm-d2', claimType: 'LICENCE', status: 'requires_human_review', role: null, subject: { type: 'user', id: 'usr-sam', name: 'Sam Cole' }, organisation: null, reviewReasons: ['NO_AUTHORITATIVE_SOURCE', 'DOCUMENT_AUTHENTICITY_UNCONFIRMED'], riskFlags: [], assignedTo: null, createdAt: NOW - 30 * 3600e3, updatedAt: NOW - 30 * 3600e3 },
  ],
  rootRequests: [
    { id: 'vroot-d1', status: 'requires_human_review', orgName: 'Riverton Athletic FC', orgType: 'professional club', country: 'GB', federation: null, website: 'https://www.rivertonathletic.com', domain: 'rivertonathletic.com', applicantName: 'Priya Nair', applicantRole: 'Club Secretary', workEmail: 'priya.nair@rivertonathletic.com', checks: { emailDomainAlignment: 'passed', dnsOwnership: 'not_configured', duplicateOrganisation: 'passed', freeEmailProvider: 'passed' }, riskFlags: [], reviewReasons: ['ROOT_ORGANISATION_BOOTSTRAP'], emailProved: true, createdAt: NOW - 20 * 3600e3 },
    { id: 'vroot-d2', status: 'requires_human_review', orgName: 'Marsh Lane Juniors', orgType: 'grassroots club', country: 'GB', federation: 'London FA', website: 'https://marshlanejuniors.example.org', domain: '', applicantName: 'Kemi Ade', applicantRole: 'Club Secretary', workEmail: 'kemi.ade.mlj@gmail.com', checks: { emailDomainAlignment: 'mismatch', dnsOwnership: 'not_configured', freeEmailProvider: 'flagged' }, riskFlags: ['FREE_EMAIL_PROVIDER'], reviewReasons: ['ROOT_ORGANISATION_BOOTSTRAP'], emailProved: true, createdAt: NOW - 5 * 3600e3 },
  ],
  disputes: [{ id: 'vdsp-d1', claimId: 'vclm-d9', byName: 'Priya Nair', reason: 'My departure date is wrong — I worked through July.', status: 'open', createdAt: NOW - 3600e3 }],
  suspended: [], disputedClaims: [], domainRequests: [{ id: 'vdom-d1', orgId: 'org-riverton', domain: 'eastportfc.com', status: 'requires_human_review', reviewReasons: ['DOMAIN_OWNERSHIP_AMBIGUOUS'], createdAt: NOW - 2 * 3600e3 }],
  expiring: [], recentlyRevoked: [], queueOldestMs: 30 * 3600e3,
};
const cannedDisputes: Dispute[] = cannedQueue.disputes.map((d) => ({
  ...d,
  claim: { id: d.claimId, claimType: 'CLUB_ROLE', status: 'disputed', role: 'Academy Coach', subject: { type: 'user', id: 'usr-priya', name: 'Priya Nair' }, organisation: { id: 'org-eastport', name: 'Eastport United', status: 'verified' }, reviewReasons: ['DISPUTED_CLAIM'], riskFlags: [], assignedTo: null, createdAt: NOW - 700 * 86400e3, updatedAt: NOW - 3600e3 },
}));

async function call<T>(key: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-admin-key': key, ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? body.error ?? res.statusText);
  return body as T;
}
const post = (key: string, path: string, body: unknown) => call(key, path, { method: 'POST', body: JSON.stringify(body) });

function ReasonButton({ label, prompt: promptText, onGo, primary }: { label: string; prompt: string; onGo: (reason: string) => void; primary?: boolean }) {
  return (
    <button className={primary ? 'primary' : ''} onClick={() => {
      const reason = window.prompt(promptText, '');
      if (reason && reason.trim()) onGo(reason.trim());
    }}>{label}</button>
  );
}

export function M14Panel({ tab, adminKey, say }: { tab: M14Tab; adminKey: string; say: (t: string) => void }) {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [disputes, setDisputes] = useState<Dispute[]>([]);

  const load = useCallback(async () => {
    if (DEMO) { setQueue(cannedQueue); setDisputes(cannedDisputes); return; }
    try {
      if (tab === 'verification') setQueue(await call<Queue>(adminKey, '/admin/verification/queue'));
      if (tab === 'verdisputes') setDisputes((await call<{ items: Dispute[] }>(adminKey, '/admin/verification/disputes')).items);
    } catch (e) { say(e instanceof Error ? e.message : 'load failed'); }
  }, [tab, adminKey, say]);
  useEffect(() => { void load(); }, [load]);

  const act = (fn: () => Promise<unknown>, done: string) =>
    (DEMO ? Promise.resolve() : fn()).then(() => { say(done); void load(); }).catch((e) => say(e instanceof Error ? e.message : 'failed'));

  if (tab === 'verification') {
    if (!queue) return <div className="dim">Loading…</div>;
    return (
      <div className="list-rows">
        <div className="notice">
          Human review is the LAST step: every case below already passed the deterministic checks and carries exact reason codes.
          Risk flags are signals, never conclusions. Consequential decisions require a written reason and are audited.
          {queue.queueOldestMs > 0 && <> · Oldest waiting: {Math.round(queue.queueOldestMs / 3600e3)}h</>}
        </div>

        <h3>Human review queue ({queue.humanReview.length})</h3>
        {queue.humanReview.map((c) => (
          <div key={c.id} className="list-row" style={{ flexWrap: 'wrap' }}>
            <span className="grow">
              <b>{c.subject.name}</b> — {c.claimType.replace(/_/g, ' ').toLowerCase()}{c.role ? ` (${c.role})` : ''}
              {c.organisation && <span className="dim"> · {c.organisation.name} [{c.organisation.status}]</span>}
              <div className="dim" style={{ fontSize: 12 }}>why human: {c.reviewReasons.join(', ') || '—'}{c.riskFlags.length > 0 && <> · ⚠ {c.riskFlags.join(', ')} (signals, not fraud)</>}</div>
            </span>
            <ReasonButton primary label="Approve" prompt="Reason for approval (audited):" onGo={(reason) => act(() => post(adminKey, `/admin/verification/claims/${c.id}/approve`, { reason }), 'Approved with reason.')} />
            <ReasonButton label="More evidence" prompt="What additional evidence is needed?" onGo={(reason) => act(() => post(adminKey, `/admin/verification/claims/${c.id}/request-info`, { reason }), 'Evidence requested.')} />
            <ReasonButton label="Reject" prompt="Reason for rejection (shown to the person):" onGo={(reason) => act(() => post(adminKey, `/admin/verification/claims/${c.id}/reject`, { reason }), 'Rejected with reason.')} />
            <ReasonButton label="Suspend" prompt="Reason for suspension:" onGo={(reason) => act(() => post(adminKey, `/admin/verification/claims/${c.id}/suspend`, { reason }), 'Suspended.')} />
          </div>
        ))}
        {queue.humanReview.length === 0 && <div className="dim">Queue clear.</div>}

        <h3>Root organisation requests ({queue.rootRequests.length})</h3>
        <div className="notice" style={{ fontSize: 12.5 }}>
          Bootstrapping trust: domain-email control is evidence of mailbox control, never of the organisation itself.
          The first administrator of an organisation is ALWAYS a human decision.
        </div>
        {queue.rootRequests.map((r) => (
          <div key={r.id} className="list-row" style={{ flexWrap: 'wrap' }}>
            <span className="grow">
              <b>{r.orgName}</b> <span className="pill blue">{r.orgType}</span> <span className="dim">{r.country} · {r.website}</span>
              <div className="dim" style={{ fontSize: 12 }}>applicant: {r.applicantName} ({r.applicantRole}) · {r.workEmail} {r.emailProved ? '✓ mailbox proved' : '○ mailbox unproved'}{r.federation ? ` · federation: ${r.federation}` : ''}</div>
              <div className="dim" style={{ fontSize: 12 }}>checks: {Object.entries(r.checks).map(([k, v]) => `${k}=${v}`).join(' · ')}</div>
              {r.riskFlags.length > 0 && <div className="dim" style={{ fontSize: 12 }}>⚠ {r.riskFlags.join(', ')} (signals)</div>}
            </span>
            {r.status === 'requires_human_review' && (
              <>
                <ReasonButton primary label="Approve org + root admin" prompt="Evidence basis for approving this organisation and first administrator:" onGo={(reason) => act(() => post(adminKey, `/admin/verification/root-requests/${r.id}/approve`, { reason }), 'Organisation verified; root administrator established.')} />
                <ReasonButton label="Reject" prompt="Reason for rejection (recorded, shown to applicant):" onGo={(reason) => act(() => post(adminKey, `/admin/verification/root-requests/${r.id}/reject`, { reason }), 'Root request rejected.')} />
              </>
            )}
            {r.status !== 'requires_human_review' && <span className="pill">{r.status}</span>}
          </div>
        ))}

        <h3>Domain requests ({queue.domainRequests.length})</h3>
        {queue.domainRequests.map((d) => (
          <div key={d.id} className="list-row">
            <span className="grow"><b>{d.domain}</b> <span className="dim">for {d.orgId}</span> <span className="dim" style={{ fontSize: 12 }}>{(d.reviewReasons ?? []).join(', ')}</span></span>
            <ReasonButton primary label="Approve" prompt="Basis for approving this domain:" onGo={(reason) => act(() => post(adminKey, `/admin/verification/domain-requests/${d.id}/decide`, { approve: true, reason }), 'Domain approved.')} />
            <ReasonButton label="Reject" prompt="Reason for rejecting this domain:" onGo={(reason) => act(() => post(adminKey, `/admin/verification/domain-requests/${d.id}/decide`, { approve: false, reason }), 'Domain rejected.')} />
          </div>
        ))}

        {queue.suspended.length > 0 && <h3>Suspended claims ({queue.suspended.length})</h3>}
        {queue.suspended.map((c) => (
          <div key={c.id} className="list-row">
            <span className="grow"><b>{c.subject.name}</b> — {c.claimType.replace(/_/g, ' ').toLowerCase()} <span className="pill red">suspended</span></span>
            <ReasonButton label="Reinstate" prompt="Reason for reinstatement:" onGo={(reason) => act(() => post(adminKey, `/admin/verification/claims/${c.id}/reinstate`, { reason }), 'Reinstated.')} />
            <ReasonButton label="Revoke" prompt="Reason for revocation:" onGo={(reason) => act(() => post(adminKey, `/admin/verification/claims/${c.id}/revoke`, { reason }), 'Revoked (history preserved).')} />
          </div>
        ))}

        {queue.expiring.length > 0 && <h3>Expiring within 30 days ({queue.expiring.length})</h3>}
        {queue.expiring.map((c) => (
          <div key={c.id} className="list-row"><span className="grow"><b>{c.subject.name}</b> — {c.claimType.replace(/_/g, ' ').toLowerCase()}{c.role ? ` (${c.role})` : ''}</span></div>
        ))}
        {queue.recentlyRevoked.length > 0 && <h3>Recently revoked ({queue.recentlyRevoked.length})</h3>}
        {queue.recentlyRevoked.map((c) => (
          <div key={c.id} className="list-row"><span className="grow"><b>{c.subject.name}</b> — {c.claimType.replace(/_/g, ' ').toLowerCase()} <span className="pill red">revoked</span></span></div>
        ))}
      </div>
    );
  }

  // verdisputes
  return (
    <div className="list-rows">
      <div className="notice">A disputed claim never silently disappears: evidence and history are preserved, and resolution requires a written reason.</div>
      {disputes.map((d) => (
        <div key={d.id} className="list-row" style={{ flexWrap: 'wrap' }}>
          <span className="grow">
            <b>{d.byName}</b>: “{d.reason}”
            {d.claim && <div className="dim" style={{ fontSize: 12 }}>{d.claim.subject.name} · {d.claim.claimType.replace(/_/g, ' ').toLowerCase()}{d.claim.role ? ` (${d.claim.role})` : ''} · {d.claim.organisation?.name ?? '—'}</div>}
          </span>
          {d.status === 'open' ? (
            <>
              <ReasonButton primary label="Uphold + correct" prompt="Correction applied (reason, audited):" onGo={(reason) => act(() => post(adminKey, `/admin/verification/disputes/${d.id}/resolve`, { action: 'correct', reason }), 'Dispute resolved with a correction.')} />
              <ReasonButton label="Reinstate claim" prompt="Reason:" onGo={(reason) => act(() => post(adminKey, `/admin/verification/disputes/${d.id}/resolve`, { action: 'reinstate', reason }), 'Claim reinstated.')} />
              <ReasonButton label="Revoke claim" prompt="Reason:" onGo={(reason) => act(() => post(adminKey, `/admin/verification/disputes/${d.id}/resolve`, { action: 'revoke', reason }), 'Claim revoked (history kept).')} />
              <ReasonButton label="Dismiss" prompt="Why the dispute is dismissed (shown to the person):" onGo={(reason) => act(() => post(adminKey, `/admin/verification/disputes/${d.id}/resolve`, { action: 'dismiss', reason }), 'Dispute dismissed with reason.')} />
            </>
          ) : <span className="pill green">{d.status}</span>}
        </div>
      ))}
      {disputes.length === 0 && <div className="dim">No disputes.</div>}
    </div>
  );
}
