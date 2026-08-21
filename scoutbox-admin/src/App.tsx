// ScoutBox Trust & Safety console — the human back-office behind the
// product's promises: report review, club verification, guardian IDV audit,
// suspension management, moderation log and thread audit.
// VITE_DEMO=1 runs on canned data for the demo tab; live mode talks to
// scoutbox-server with the x-admin-key header.

import { useCallback, useEffect, useState } from 'react';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
const DEMO = import.meta.env.VITE_DEMO === '1';

interface Report {
  id: string; ts: number; by: string; byId: string; targetKind: string;
  targetOrgId: string | null; targetScoutName: string | null; targetPlayerId: string | null;
  reason: string; urgent: boolean; status: string; outcome: string | null; resolvedAt: number | null;
}
interface Club {
  id: string; name: string; type: string; plan: string; verified: boolean;
  verifiedDomain: string | null; safeguardingContractSigned: boolean;
  safeguardingCertified: boolean; suspended?: boolean;
}
interface GuardianRow { id: string; name: string; email: string; idVerified: boolean; disclaimerAccepted: boolean; childIds: string[] }
interface IdvRow { id: string; guardianId: string; guardianName: string; documentType: string; documentRef: string; ts: number; status: string }
interface BlockRow { id: string; playerId: string; orgId: string; by: string; reason: string; ts: number }
interface ModRow { id: string; ts: number; context: { kind?: string }; flags: string[]; severity?: string | null }
interface ThreadRow { id: string; playerName: string; orgName: string; scoutName: string; scoutRole: string; counterparty: string; messages: { id: string; ts: number; sender: { name: string }; text: string }[] }
interface Overview { players: number; guardians: number; orgs: number; openReports: number; blocks: number; moderationHits: number; channels: number; signings: number; persisted: boolean; invoices?: number; emailsSent?: number; pushesSent?: number; sessions?: number; storageEngine?: string; groomingEscalations?: number }
interface MailRow { id: string; ts: number; to: string; subject: string; text: string; transport: string; delivered: boolean }
interface InvoiceRow { id: string; ts: number; orgName: string; description: string; amount: number; currency: string; status: string; provider: string }

// ------------------------------------------------------------- demo state
const demo = {
  overview: { players: 13, guardians: 2, orgs: 3, openReports: 2, blocks: 1, moderationHits: 4, channels: 3, signings: 1, persisted: true, invoices: 1, emailsSent: 2, pushesSent: 9, sessions: 6, storageEngine: 'sqlite', groomingEscalations: 1 } as Overview,
  reports: [
    { id: 'rep-9001', ts: Date.now() - 3600e3, by: 'guardian', byId: 'gd-amara', targetKind: 'scout', targetOrgId: 'org-northstar', targetScoutName: 'T. Rivera', targetPlayerId: null, reason: 'Asked to move the conversation to WhatsApp.', urgent: true, status: 'pending_review', outcome: null, resolvedAt: null },
    { id: 'rep-9002', ts: Date.now() - 7200e3, by: 'player', byId: 'pl-adeyemi', targetKind: 'club', targetOrgId: 'org-harbour', targetScoutName: null, targetPlayerId: null, reason: 'Trial report still not filed after three weeks.', urgent: false, status: 'pending_review', outcome: null, resolvedAt: null },
    { id: 'rep-9000', ts: Date.now() - 86400e3, by: 'org_user', byId: 'usr-1', targetKind: 'player', targetOrgId: null, targetScoutName: null, targetPlayerId: 'pl-x', reason: 'Suspected duplicate profile.', urgent: false, status: 'resolved', outcome: 'Duplicate merged.', resolvedAt: Date.now() - 80000e3 },
  ] as Report[],
  outbox: [
    { id: 'mail-1', ts: Date.now() - 1800e3, to: 'nadia@testfamily.co.uk', subject: 'Verify your ScoutBox guardian account', text: 'Your ScoutBox verification code is QK7M2X.', transport: 'dev-outbox', delivered: false },
    { id: 'mail-2', ts: Date.now() - 3600e3, to: 'recruitment@eastportfc.co.uk', subject: 'Verify Eastport FC on ScoutBox', text: 'Your ScoutBox club verification code is B4TR9N.', transport: 'dev-outbox', delivered: false },
  ] as MailRow[],
  invoices: [
    { id: 'inv-1', ts: Date.now() - 86400e3, orgName: 'Eastport FC', description: 'Success fee — Elias Svensson signed inside the attribution window', amount: 1500, currency: 'EUR', status: 'issued', provider: 'dev-ledger' },
  ] as InvoiceRow[],
  clubs: [
    { id: 'org-eastport', name: 'Eastport FC', type: 'club', plan: 'Pro', verified: true, verifiedDomain: 'eastportfc.com', safeguardingContractSigned: true, safeguardingCertified: true },
    { id: 'org-harbour', name: 'Harbour City FC', type: 'club', plan: 'Academy', verified: false, verifiedDomain: null, safeguardingContractSigned: false, safeguardingCertified: false },
    { id: 'org-northstar', name: 'North Star Sports Agency', type: 'agency', plan: 'Agency', verified: false, verifiedDomain: null, safeguardingContractSigned: false, safeguardingCertified: false },
  ] as Club[],
  guardians: [
    { id: 'gd-amara', name: 'Amara Adebayo', email: 'amara.adebayo@example.com', idVerified: true, disclaimerAccepted: true, childIds: ['pl-guni'] },
    { id: 'gd-marek', name: 'Marek Kowalski', email: 'marek.kowalski@example.com', idVerified: true, disclaimerAccepted: true, childIds: ['pl-tomasz', 'pl-imani'] },
  ] as GuardianRow[],
  idvQueue: [
    { id: 'idv-1', guardianId: 'gd-amara', guardianName: 'Amara Adebayo', documentType: 'passport', documentRef: 'P•••••41', ts: Date.now() - 90 * 86400e3, status: 'auto_approved' },
    { id: 'idv-2', guardianId: 'gd-marek', guardianName: 'Marek Kowalski', documentType: 'driving_licence', documentRef: 'D•••••88', ts: Date.now() - 60 * 86400e3, status: 'auto_approved' },
  ] as IdvRow[],
  blocks: [{ id: 'blk-1', playerId: 'pl-guni', orgId: 'org-northstar', by: 'guardian', reason: 'suspended_pending_review', ts: Date.now() - 3000e3 }] as BlockRow[],
  moderation: [
    { id: 'mod-1', ts: Date.now() - 4000e3, context: { kind: 'org_request_message' }, flags: ['phone_number', 'social_platform'] },
    { id: 'mod-2', ts: Date.now() - 9000e3, context: { kind: 'player_message' }, flags: ['phone_number'] },
    { id: 'mod-3', ts: Date.now() - 86400e3, context: { kind: 'media_title' }, flags: ['social_handle'] },
    { id: 'mod-4', ts: Date.now() - 2 * 86400e3, context: { kind: 'guardian_message' }, flags: ['email'] },
    { id: 'mod-5', ts: Date.now() - 1000e3, context: { kind: 'org_message' }, flags: ['secrecy'], severity: 'grooming' },
  ] as ModRow[],
  threads: [
    {
      id: 'chan-1', playerName: 'Guni Adebayo', orgName: 'Eastport FC', scoutName: 'Maria Keane', scoutRole: 'Head of Recruitment', counterparty: 'guardian',
      messages: [
        { id: 'm1', ts: Date.now() - 3500e3, sender: { name: 'Maria Keane · Head of Recruitment · Eastport FC' }, text: 'Thanks for accepting — the U15 assessment day runs 10am–1pm.' },
        { id: 'm2', ts: Date.now() - 3400e3, sender: { name: 'Amara Adebayo' }, text: 'Who will be present at the session?' },
      ],
    },
  ] as ThreadRow[],
};

// ---------------------------------------------------------------- helpers
async function call<T>(key: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-admin-key': key, ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? body.error ?? res.statusText);
  return body as T;
}

type Tab = 'overview' | 'reports' | 'clubs' | 'guardians' | 'blocks' | 'moderation' | 'threads' | 'outbox' | 'billing';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'reports', label: 'Report queue' },
  { id: 'clubs', label: 'Club verification' },
  { id: 'guardians', label: 'Guardian IDV' },
  { id: 'blocks', label: 'Suspensions' },
  { id: 'moderation', label: 'Moderation log' },
  { id: 'threads', label: 'Thread audit' },
  { id: 'outbox', label: 'Mail outbox' },
  { id: 'billing', label: 'Billing' },
];

export default function App() {
  const [key, setKey] = useState(DEMO ? 'demo' : '');
  const [entered, setEntered] = useState(DEMO);
  const [tab, setTab] = useState<Tab>(DEMO ? 'reports' : 'overview');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [guardians, setGuardians] = useState<GuardianRow[]>([]);
  const [idvQueue, setIdvQueue] = useState<IdvRow[]>([]);
  const [blocks, setBlocks] = useState<BlockRow[]>([]);
  const [moderation, setModeration] = useState<ModRow[]>([]);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [outbox, setOutbox] = useState<MailRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [outcomeDrafts, setOutcomeDrafts] = useState<Record<string, string>>({});

  const say = (text: string) => { setToast(text); setTimeout(() => setToast(null), 3500); };

  const load = useCallback(async () => {
    setError(null);
    if (DEMO) {
      setOverview(demo.overview); setReports(demo.reports); setClubs(demo.clubs);
      setGuardians(demo.guardians); setIdvQueue(demo.idvQueue); setBlocks(demo.blocks);
      setModeration(demo.moderation); setThreads(demo.threads);
      setOutbox(demo.outbox); setInvoices(demo.invoices);
      return;
    }
    try {
      setOverview(await call<Overview>(key, '/admin/overview'));
      setReports(await call<Report[]>(key, '/admin/reports'));
      setClubs(await call<Club[]>(key, '/admin/clubs'));
      const g = await call<{ guardians: GuardianRow[]; idvQueue: IdvRow[] }>(key, '/admin/guardians');
      setGuardians(g.guardians); setIdvQueue(g.idvQueue);
      setBlocks(await call<BlockRow[]>(key, '/admin/blocks'));
      setModeration(await call<ModRow[]>(key, '/admin/moderation'));
      setThreads(await call<ThreadRow[]>(key, '/admin/channels'));
      setOutbox(await call<MailRow[]>(key, '/admin/outbox'));
      setInvoices(await call<InvoiceRow[]>(key, '/admin/invoices'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cannot reach scoutbox-server — is it running with your ADMIN_KEY?');
      setEntered(false);
    }
  }, [key]);

  useEffect(() => { if (entered) void load(); }, [entered, load]);

  const resolveReport = async (r: Report, action: 'none' | 'warning' | 'suspend_org' | 'dismiss') => {
    const outcome = outcomeDrafts[r.id]?.trim();
    if (!outcome) return say('Write the outcome the reporter will read.');
    if (DEMO) {
      r.status = 'resolved'; r.outcome = outcome; r.resolvedAt = Date.now();
      setReports([...reports]);
      say('Resolved — the reporter has been notified.');
      return;
    }
    try {
      await call(key, `/admin/reports/${r.id}/resolve`, { method: 'POST', body: JSON.stringify({ outcome, action }) });
      say('Resolved — the reporter has been notified.');
      await load();
    } catch (e) { say(e instanceof Error ? e.message : 'Failed'); }
  };

  const setClubVerification = async (c: Club, patch: Partial<Club>) => {
    if (DEMO) {
      Object.assign(c, patch);
      c.safeguardingCertified = !!c.verified && !!c.safeguardingContractSigned;
      setClubs([...clubs]);
      say(`${c.name} updated.`);
      return;
    }
    try {
      await call(key, `/admin/clubs/${c.id}/verification`, { method: 'POST', body: JSON.stringify(patch) });
      say(`${c.name} updated.`);
      await load();
    } catch (e) { say(e instanceof Error ? e.message : 'Failed'); }
  };

  const setIdv = async (g: GuardianRow, approved: boolean) => {
    if (DEMO) { g.idVerified = approved; setGuardians([...guardians]); say('Updated.'); return; }
    try {
      await call(key, `/admin/guardians/${g.id}/idv`, { method: 'POST', body: JSON.stringify({ approved }) });
      say('Updated.');
      await load();
    } catch (e) { say(e instanceof Error ? e.message : 'Failed'); }
  };

  const liftBlock = async (b: BlockRow) => {
    if (DEMO) { setBlocks(blocks.filter((x) => x.id !== b.id)); say('Suspension lifted.'); return; }
    try {
      await call(key, `/admin/blocks/${b.id}/lift`, { method: 'POST' });
      say('Suspension lifted.');
      await load();
    } catch (e) { say(e instanceof Error ? e.message : 'Failed'); }
  };

  if (!entered) {
    return (
      <div className="login">
        <div style={{ textAlign: 'center' }}>
          <h1>Scout<span>Box</span> <span style={{ fontSize: 22 }}>Trust &amp; Safety</span></h1>
          <div className="tagline">Staff console — report review, verification, audit.</div>
        </div>
        <div className="enter-row">
          <input type="password" placeholder="Admin key" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setEntered(true)} />
          <button className="primary" onClick={() => setEntered(true)}>Enter</button>
        </div>
        {error && <div className="notice block">{error}</div>}
      </div>
    );
  }

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">Scout<span>Box</span> T&amp;S</div>
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)} style={{ position: 'relative' }}>
            {t.label}
            {t.id === 'reports' && reports.filter((r) => r.status === 'pending_review').length > 0 && (
              <span className="nav-badge">{reports.filter((r) => r.status === 'pending_review').length}</span>
            )}
          </button>
        ))}
        <div className="spacer" />
        <div className="whoami"><b>Safety staff</b>{DEMO ? 'Demo mode' : 'Live'}</div>
      </nav>
      <div className="main">
        <div className="topbar">
          <h2>{TABS.find((t) => t.id === tab)?.label}</h2>
          {DEMO && <span className="pill blue">demo data</span>}
          <button onClick={() => void load()}>↻ Refresh</button>
        </div>
        <div className="content">
          {tab === 'overview' && overview && (
            <div className="stat-grid">
              <Stat v={overview.players} k="Players" />
              <Stat v={overview.guardians} k="Guardians" />
              <Stat v={overview.openReports} k="Open reports" />
              <Stat v={overview.blocks} k="Active blocks" />
              <Stat v={overview.moderationHits} k="Moderation hits" />
              <Stat v={overview.channels} k="Threads" />
              <Stat v={overview.signings} k="Signings" />
              <Stat v={overview.invoices ?? 0} k="Invoices" />
              <Stat v={overview.emailsSent ?? 0} k="Emails sent" />
              <Stat v={overview.sessions ?? 0} k="Live sessions" />
              <Stat v={overview.groomingEscalations ?? 0} k="Grooming escalations" />
              <Stat v={overview.storageEngine ?? 'memory'} k="Storage" />
              <Stat v={overview.persisted ? 'yes' : 'seed'} k="Snapshot loaded" />
            </div>
          )}

          {tab === 'reports' && (
            <div className="list-rows">
              {reports.length === 0 && <div className="notice">No reports.</div>}
              {reports.map((r) => (
                <div key={r.id} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    {r.urgent && <span className="pill red">URGENT — comms suspended</span>}
                    <span className="pill">{r.targetKind}</span>
                    <span className="grow"><b>{r.reason}</b></span>
                    <span className="dim">by {r.by} · {new Date(r.ts).toLocaleString()}</span>
                    <span className={`pill ${r.status === 'pending_review' ? 'gold' : 'green'}`}>{r.status === 'pending_review' ? 'awaiting review' : 'resolved'}</span>
                  </div>
                  <div className="dim">
                    target: {r.targetOrgId ?? r.targetPlayerId ?? '—'}{r.targetScoutName ? ` · scout: ${r.targetScoutName}` : ''}
                  </div>
                  {r.status === 'pending_review' ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        style={{ flex: 1 }}
                        placeholder="Outcome the reporter will read"
                        value={outcomeDrafts[r.id] ?? ''}
                        onChange={(e) => setOutcomeDrafts({ ...outcomeDrafts, [r.id]: e.target.value })}
                      />
                      <button onClick={() => resolveReport(r, 'none')}>Resolve</button>
                      <button onClick={() => resolveReport(r, 'warning')}>Warn</button>
                      <button className="primary" onClick={() => resolveReport(r, 'suspend_org')}>Suspend org</button>
                      <button onClick={() => resolveReport(r, 'dismiss')}>Dismiss</button>
                    </div>
                  ) : (
                    r.outcome && <div className="dim">outcome: {r.outcome}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === 'clubs' && (
            <div className="list-rows">
              {clubs.map((c) => (
                <div key={c.id} className="list-row">
                  <span className="grow">
                    <b>{c.name}</b> <span className="dim">({c.type} · {c.plan}{c.verifiedDomain ? ` · @${c.verifiedDomain}` : ''})</span>
                  </span>
                  {c.suspended && <span className="pill red">suspended</span>}
                  {c.safeguardingCertified && <span className="pill green">🛡 certified</span>}
                  <label className="chk"><input type="checkbox" checked={c.verified} onChange={(e) => setClubVerification(c, { verified: e.target.checked })} /> verified</label>
                  <label className="chk"><input type="checkbox" checked={c.safeguardingContractSigned} onChange={(e) => setClubVerification(c, { safeguardingContractSigned: e.target.checked })} /> contract</label>
                  <label className="chk"><input type="checkbox" checked={!!c.suspended} onChange={(e) => setClubVerification(c, { suspended: e.target.checked })} /> suspend</label>
                </div>
              ))}
              <div className="notice">Verified + contract = eligible for U18 visibility. Certification drops automatically while an urgent report stands.</div>
            </div>
          )}

          {tab === 'guardians' && (
            <>
              <div className="list-rows" style={{ marginBottom: 18 }}>
                {guardians.map((g) => (
                  <div key={g.id} className="list-row">
                    <span className="grow"><b>{g.name}</b> <span className="dim">{g.email} · {g.childIds.length} child{g.childIds.length === 1 ? '' : 'ren'}</span></span>
                    <span className={`pill ${g.idVerified ? 'green' : 'red'}`}>{g.idVerified ? 'ID verified' : 'unverified'}</span>
                    <button onClick={() => setIdv(g, !g.idVerified)}>{g.idVerified ? 'Revoke' : 'Approve'}</button>
                  </div>
                ))}
              </div>
              <h4 style={{ color: 'var(--muted)', marginBottom: 8 }}>IDV submissions (audit)</h4>
              <table className="data">
                <thead><tr><th>Guardian</th><th>Document</th><th>Ref</th><th>When</th><th>Status</th></tr></thead>
                <tbody>
                  {idvQueue.map((q) => (
                    <tr key={q.id}><td>{q.guardianName}</td><td>{q.documentType}</td><td>{q.documentRef}</td><td>{new Date(q.ts).toLocaleDateString()}</td><td>{q.status}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {tab === 'blocks' && (
            <div className="list-rows">
              {blocks.length === 0 && <div className="notice">No active blocks or suspensions.</div>}
              {blocks.map((b) => (
                <div key={b.id} className="list-row">
                  <span className="pill red">{b.reason === 'suspended_pending_review' ? 'suspension' : 'block'}</span>
                  <span className="grow">{b.orgId} → {b.playerId}</span>
                  <span className="dim">by {b.by} · {new Date(b.ts).toLocaleString()}</span>
                  <button onClick={() => liftBlock(b)}>Lift</button>
                </div>
              ))}
            </div>
          )}

          {tab === 'moderation' && (
            <table className="data">
              <thead><tr><th>When</th><th>Where</th><th>Severity</th><th>Flags</th></tr></thead>
              <tbody>
                {moderation.map((m) => (
                  <tr key={m.id}>
                    <td>{new Date(m.ts).toLocaleString()}</td>
                    <td>{m.context?.kind ?? '—'}</td>
                    <td>{m.severity === 'grooming' ? <span className="pill red">GROOMING — escalated</span> : <span className="pill">{m.severity ?? 'contact'}</span>}</td>
                    <td>{m.flags.map((f) => <span key={f} className="pill red" style={{ marginRight: 4 }}>{f.replace(/_/g, ' ')}</span>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'outbox' && (
            <div className="list-rows">
              <div className="notice">Dev mail transport: everything the platform "sends" lands here. Set SENDGRID_API_KEY on the server to deliver for real — this view then becomes the delivery audit.</div>
              {outbox.length === 0 && <div className="notice">No mail yet.</div>}
              {outbox.map((m) => (
                <div key={m.id} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <span className="grow"><b>{m.subject}</b></span>
                    <span className="dim">to {m.to}</span>
                    <span className={`pill ${m.delivered ? 'green' : 'gold'}`}>{m.delivered ? 'delivered' : m.transport}</span>
                    <span className="dim">{new Date(m.ts).toLocaleString()}</span>
                  </div>
                  <div className="dim" style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
                </div>
              ))}
            </div>
          )}

          {tab === 'billing' && (
            <div className="list-rows">
              <div className="notice">Success fees issued by the billing adapter (dev ledger; Stripe when STRIPE_SECRET_KEY is set). A signing inside the attribution window invoices automatically.</div>
              {invoices.length === 0 && <div className="notice">No invoices yet.</div>}
              {invoices.map((i) => (
                <div key={i.id} className="list-row">
                  <span className="grow"><b>{i.orgName ?? ''}</b> <span className="dim">{i.description}</span></span>
                  <span className="pill gold">€{i.amount}</span>
                  <span className="pill">{i.status}</span>
                  <span className="pill blue">{i.provider}</span>
                  <span className="dim">{new Date(i.ts).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          )}

          {tab === 'threads' && (
            <div className="list-rows">
              <div className="notice">Every conversation on the platform is auditable — this is the "all communications logged" promise, inspectable.</div>
              {threads.map((t) => (
                <div key={t.id} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer' }} onClick={() => setOpenThread(openThread === t.id ? null : t.id)}>
                    <span className="grow"><b>{t.orgName}</b> ↔ {t.counterparty === 'guardian' ? `guardian of ${t.playerName}` : t.playerName}</span>
                    <span className="dim">{t.scoutRole} — {t.scoutName}</span>
                    <span className="pill">{t.messages.length} msg</span>
                  </div>
                  {openThread === t.id && (
                    <div className="thread" style={{ maxHeight: 260 }}>
                      {t.messages.map((m) => (
                        <div key={m.id} className="bubble theirs">
                          <div className="who">{m.sender.name} · {new Date(m.ts).toLocaleString()}</div>
                          {m.text}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Stat({ v, k }: { v: number | string; k: string }) {
  return <div className="stat"><div className="v">{v}</div><div className="k">{k}</div></div>;
}
