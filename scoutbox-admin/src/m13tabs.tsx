// M13 Trust & Safety additions: representation review, federation groups,
// support desk (with the explicit time-limited access flow), the delivery
// centre, service metrics and backups. VITE_DEMO=1 runs on canned rows.
import { useCallback, useEffect, useState } from 'react';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
const DEMO = import.meta.env.VITE_DEMO === '1';

export type M13Tab = 'representation' | 'groups' | 'supportdesk' | 'deliverycentre' | 'servicehealth' | 'backups';
export const M13_TABS: { id: M13Tab; label: string }[] = [
  { id: 'representation', label: 'Representation' },
  { id: 'groups', label: 'Federation groups' },
  { id: 'supportdesk', label: 'Support desk' },
  { id: 'deliverycentre', label: 'Delivery centre' },
  { id: 'servicehealth', label: 'Service health' },
  { id: 'backups', label: 'Backups' },
];

interface Rep { id: string; playerName: string; agencyName: string; representativeName: string; scope: string; status: string; credential: { note: string; reviewStatus: string; honest: string } | null }
interface Grp { id: string; name: string; memberOrgIds: string[]; adminOrgIds: string[]; pendingInvites: { orgId: string }[] }
interface Ticket { id: string; orgId: string; byName: string; subject: string; status: string; refs: { kind: string; id: string }[]; replies: { by: string; text: string }[] }
interface AccessGrant { id: string; ticketId: string; status: string; hours: number; expiresAt: number | null; accessLog: { at: number; what: string }[] }
interface DeliveryData { provider: string; providerNote: string; counts: Record<string, number>; awaitingAck: number; recent: { id: string; channel: string; to: string | null; status: string; skipReason: string | null; attempts: unknown[] }[] }
interface Metrics { requests: number; status2xx: number; status4xx: number; status5xx: number; slowRequests: number; failedUploads: number; deliveryFailures: number; webhookFailures: number; dispatchBacklog: number; webhookBacklog: number; note: string; opsEvents: { at: number; kind: string }[] }
interface Backup { dir: string; manifest: { createdAt: number; counts: Record<string, number>; files: { path: string }[]; restore: string } | null }

const NOW = Date.now();
const canned = {
  representation: [
    { id: 'rep-1', playerName: 'Kola Adeyemi', agencyName: 'North Star Sports Agency', representativeName: 'Alex Agent', scope: 'contracts_only', status: 'active', credential: { note: 'FA intermediary licence PDF', reviewStatus: 'pending', honest: 'uploaded document, review pending — NOT an independently verified licence' } },
    { id: 'rep-2', playerName: 'Astrid Svensson', agencyName: 'North Star Sports Agency', representativeName: 'Alex Agent', scope: 'full', status: 'disputed', credential: null },
  ] as Rep[],
  groups: [
    { id: 'grp-1', name: 'North West Development Group', memberOrgIds: ['org-eastport', 'org-hackneymarsh'], adminOrgIds: ['org-eastport'], pendingInvites: [] },
  ] as Grp[],
  tickets: [
    { id: 'tkt-1', orgId: 'org-eastport', byName: 'Maria Keane', subject: 'Import row stuck in review', status: 'open', refs: [{ kind: 'import', id: 'imp-d1' }], replies: [] },
  ] as Ticket[],
  grants: [
    { id: 'sag-1', ticketId: 'tkt-1', status: 'requested', hours: 24, expiresAt: null, accessLog: [] },
  ] as AccessGrant[],
  delivery: {
    provider: 'local-fake',
    providerNote: 'Local fake provider only — real email/SMS/push transport is not configured; no message leaves this machine.',
    counts: { delivered: 41, accepted: 12, skipped: 9, retrying: 1, failed: 2, actioned: 5 },
    awaitingAck: 1,
    recent: [
      { id: 'dsp-1', channel: 'in_app', to: 'org_user:usr-d1', status: 'actioned', skipReason: null, attempts: [] },
      { id: 'dsp-2', channel: 'email', to: 'nina@eastport-example.club', status: 'accepted', skipReason: null, attempts: [{}] },
      { id: 'dsp-3', channel: 'email', to: null, status: 'skipped', skipReason: 'guardian_routed — external delivery for under-18s goes to the guardian record', attempts: [] },
    ],
  } as DeliveryData,
  metrics: {
    requests: 4182, status2xx: 4040, status4xx: 139, status5xx: 3, slowRequests: 2,
    failedUploads: 1, deliveryFailures: 2, webhookFailures: 1, dispatchBacklog: 1, webhookBacklog: 0,
    note: 'Counters cover this process since boot. Local development metrics — not a production SLA measurement.',
    opsEvents: [{ at: NOW - 3600e3, kind: 'delivery_failed' }, { at: NOW - 2 * 3600e3, kind: 'backup_created' }],
  } as Metrics,
  backups: [
    { dir: '2026-09-09T10-30-00-000Z', manifest: { createdAt: NOW - 4 * 3600e3, counts: { players: 14, orgs: 5, notifications: 220 }, files: [{ path: 'db.json' }, { path: 'media/media-1.webm' }], restore: 'Copy this directory to a NEW empty DATA_DIR and start the server with DATA_DIR pointing at it. Never restore over a live data directory.' } },
  ] as Backup[],
};

async function call<T>(key: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-admin-key': key, ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? body.error ?? res.statusText);
  return body as T;
}

export function M13Panel({ tab, adminKey, say }: { tab: M13Tab; adminKey: string; say: (t: string) => void }) {
  const [reps, setReps] = useState<Rep[]>([]);
  const [groups, setGroups] = useState<Grp[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [grants, setGrants] = useState<AccessGrant[]>([]);
  const [delivery, setDelivery] = useState<DeliveryData | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [backups, setBackups] = useState<Backup[]>([]);

  const load = useCallback(async () => {
    if (DEMO) {
      setReps(canned.representation); setGroups(canned.groups); setTickets(canned.tickets);
      setGrants(canned.grants); setDelivery(canned.delivery); setMetrics(canned.metrics); setBackups(canned.backups);
      return;
    }
    try {
      if (tab === 'representation') setReps((await call<{ items: Rep[] }>(adminKey, '/admin/representations')).items);
      if (tab === 'groups') setGroups((await call<{ items: Grp[] }>(adminKey, '/admin/groups')).items);
      if (tab === 'supportdesk') {
        const r = await call<{ items: Ticket[]; grants: AccessGrant[] }>(adminKey, '/admin/support');
        setTickets(r.items); setGrants(r.grants);
      }
      if (tab === 'deliverycentre') setDelivery(await call<DeliveryData>(adminKey, '/admin/delivery'));
      if (tab === 'servicehealth') setMetrics(await call<Metrics>(adminKey, '/admin/metrics'));
      if (tab === 'backups') setBackups((await call<{ items: Backup[] }>(adminKey, '/admin/backups')).items);
    } catch (e) { say(e instanceof Error ? e.message : 'load failed'); }
  }, [tab, adminKey, say]);
  useEffect(() => { void load(); }, [load]);

  const act = (fn: () => Promise<unknown>, done: string) =>
    (DEMO ? Promise.resolve() : fn()).then(() => { say(done); void load(); }).catch((e) => say(e instanceof Error ? e.message : 'failed'));

  if (tab === 'representation') {
    return (
      <div className="list-rows">
        <div className="notice">Adult-only representation relationships. Age is DOB-evaluated on every request; an uploaded credential is a document review at best — no licence-register integration exists.</div>
        {reps.map((r) => (
          <div key={r.id} className="list-row">
            <span className="grow">
              <b>{r.playerName}</b> ↔ {r.agencyName} <span className="dim">({r.representativeName} · {r.scope.replace(/_/g, ' ')})</span>
              {r.credential && <div className="dim" style={{ fontSize: 12 }}>📄 {r.credential.note} — {r.credential.reviewStatus.replace(/_/g, ' ')}. {r.credential.honest}</div>}
            </span>
            <span className={`pill ${r.status === 'active' ? 'green' : r.status === 'disputed' || r.status === 'withdrawn' ? 'red' : ''}`}>{r.status}</span>
            {r.credential?.reviewStatus === 'pending' && (
              <button onClick={() => act(() => call(adminKey, `/admin/representations/${r.id}/review-credential`, { method: 'POST', body: JSON.stringify({ valid: true }) }), 'Document review recorded (NOT an independent register check).')}>Review document</button>
            )}
          </div>
        ))}
        {reps.length === 0 && <div className="notice">No representation records.</div>}
      </div>
    );
  }

  if (tab === 'groups') {
    return (
      <div className="list-rows">
        <div className="notice">Federation/group workspaces. Membership shares nothing; grants are explicit and expiring, and no grant overrides under-18 or grassroots rules.</div>
        {groups.map((g) => (
          <div key={g.id} className="list-row">
            <span className="grow"><b>{g.name}</b> <span className="dim">{g.memberOrgIds.length} member(s) · admin: {g.adminOrgIds.join(', ')}{g.pendingInvites.length ? ` · ${g.pendingInvites.length} pending invite(s)` : ''}</span></span>
          </div>
        ))}
        <button onClick={() => act(() => call(adminKey, '/admin/groups', { method: 'POST', body: JSON.stringify({ name: 'New regional group', adminOrgId: 'org-eastport' }) }), 'Group created with a delegated admin org.')}>Onboard a group</button>
      </div>
    );
  }

  if (tab === 'supportdesk') {
    return (
      <div className="list-rows">
        <div className="notice">Tickets reference records by id — nothing is copied. Reading an org's records needs an org-lead-approved, time-limited grant; every read is logged. There is no silent impersonation path.</div>
        {tickets.map((tk) => {
          const g = grants.find((x) => x.ticketId === tk.id);
          return (
            <div key={tk.id} className="list-row">
              <span className="grow">
                <b>{tk.subject}</b> <span className="dim">{tk.byName} · {tk.orgId} · refs: {tk.refs.map((r) => `${r.kind}:${r.id}`).join(', ') || '—'}</span>
                {g && <div className="dim" style={{ fontSize: 12 }}>access: {g.status}{g.status === 'active' && g.expiresAt ? ` until ${new Date(g.expiresAt).toLocaleTimeString()}` : ''} · {g.accessLog.length} logged read(s)</div>}
              </span>
              <span className={`pill ${tk.status === 'open' ? 'blue' : ''}`}>{tk.status}</span>
              <button onClick={() => act(() => call(adminKey, `/admin/support/${tk.id}/reply`, { method: 'POST', body: JSON.stringify({ text: 'We are looking into this now.' }) }), 'Replied.')}>Reply</button>
              {!g && <button onClick={() => act(() => call(adminKey, `/admin/support/${tk.id}/request-access`, { method: 'POST', body: JSON.stringify({ hours: 24 }) }), 'Access requested — an org lead must approve it.')}>Request access</button>}
              {g?.status === 'active' && <button onClick={() => act(() => call(adminKey, `/admin/support/${tk.id}/org-records`), 'Read the referenced records (logged).')}>Open records</button>}
            </div>
          );
        })}
        {tickets.length === 0 && <div className="notice">No tickets.</div>}
      </div>
    );
  }

  if (tab === 'deliverycentre' && delivery) {
    return (
      <div>
        <div className="notice">{delivery.providerNote}</div>
        <div className="stats-row" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '10px 0' }}>
          {Object.entries(delivery.counts).map(([k, v]) => (
            <div key={k} className="stat"><b style={{ fontSize: 18 }}>{v}</b><div className="dim">{k.replace(/_/g, ' ')}</div></div>
          ))}
          <div className="stat"><b style={{ fontSize: 18 }}>{delivery.awaitingAck}</b><div className="dim">awaiting acknowledgement</div></div>
        </div>
        <div className="notice" style={{ fontSize: 12.5 }}>Status ladder is forward-only: queued → accepted → delivered (confirmed only) → opened (measured only) → actioned. Email acceptance is never reported as read.</div>
        <div className="list-rows">
          {delivery.recent.slice(0, 25).map((d) => (
            <div key={d.id} className="list-row">
              <span className="grow"><b>{d.channel}</b> <span className="dim">{d.to ?? '—'}{d.skipReason ? ` · ${d.skipReason}` : ''} · {d.attempts.length} attempt(s)</span></span>
              <span className={`pill ${['delivered', 'opened', 'actioned'].includes(d.status) ? 'green' : d.status === 'failed' ? 'red' : ''}`}>{d.status}</span>
            </div>
          ))}
        </div>
        <button onClick={() => act(() => call(adminKey, '/admin/delivery/inject-failure', { method: 'POST', body: JSON.stringify({ channel: 'email', count: 1 }) }), 'Injected one provider failure — watch it retry.')}>Inject provider failure (test)</button>
      </div>
    );
  }

  if (tab === 'servicehealth' && metrics) {
    return (
      <div>
        <div className="notice">{metrics.note}</div>
        <div className="stats-row" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '10px 0' }}>
          <div className="stat"><b style={{ fontSize: 18 }}>{metrics.requests}</b><div className="dim">requests</div></div>
          <div className="stat"><b style={{ fontSize: 18 }}>{metrics.status5xx}</b><div className="dim">5xx</div></div>
          <div className="stat"><b style={{ fontSize: 18 }}>{metrics.slowRequests}</b><div className="dim">&gt;500ms</div></div>
          <div className="stat"><b style={{ fontSize: 18 }}>{metrics.failedUploads}</b><div className="dim">failed uploads</div></div>
          <div className="stat"><b style={{ fontSize: 18 }}>{metrics.deliveryFailures}</b><div className="dim">delivery failures</div></div>
          <div className="stat"><b style={{ fontSize: 18 }}>{metrics.webhookFailures}</b><div className="dim">webhook failures</div></div>
          <div className="stat"><b style={{ fontSize: 18 }}>{metrics.dispatchBacklog + metrics.webhookBacklog}</b><div className="dim">retry backlog</div></div>
        </div>
        <div className="list-rows">
          {metrics.opsEvents.slice(0, 15).map((e, i) => (
            <div key={i} className="list-row"><span className="grow">{e.kind.replace(/_/g, ' ')}</span><span className="dim">{new Date(e.at).toLocaleString()}</span></div>
          ))}
        </div>
      </div>
    );
  }

  if (tab === 'backups') {
    return (
      <div className="list-rows">
        <div className="notice">Backups carry a checksummed manifest. Restores go into a SEPARATE empty directory — never over the live database. The m13 test suite runs a full backup → isolated-restore → smoke-test cycle.</div>
        {backups.map((b) => (
          <div key={b.dir} className="list-row">
            <span className="grow">
              <b>{b.dir}</b>
              {b.manifest && <span className="dim"> · {b.manifest.files.length} file(s) · {Object.entries(b.manifest.counts).map(([k, v]) => `${v} ${k}`).join(' · ')}</span>}
              {b.manifest && <div className="dim" style={{ fontSize: 12 }}>{b.manifest.restore}</div>}
            </span>
            <button onClick={() => act(() => call(adminKey, '/admin/backup/verify', { method: 'POST', body: JSON.stringify({ dir: b.dir }) }), 'Backup verified against its manifest.')}>Verify</button>
          </div>
        ))}
        <button onClick={() => act(() => call(adminKey, '/admin/backup', { method: 'POST' }), 'Backup written with manifest + checksums.')}>Create backup</button>
      </div>
    );
  }

  return null;
}
