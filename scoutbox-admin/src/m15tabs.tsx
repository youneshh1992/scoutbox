// M15 Trust & Safety additions — the Football Passport back office:
// the correction queue (records are never silently edited; every resolution
// carries a written reason), the share registry (any link can be killed
// instantly), and the source-graph inspector that shows exactly which
// underlying record produced each passport item.
import { useCallback, useEffect, useState } from 'react';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
const DEMO = import.meta.env.VITE_DEMO === '1';

export type M15Tab = 'passport';
export const M15_TABS: { id: M15Tab; label: string }[] = [
  { id: 'passport', label: 'Passport' },
];

interface CorrectionRow {
  id: string; playerId: string; targetType: string; targetId: string | null;
  reason: string; by: { kind: string; id: string; name: string };
  status: string; resolution: { outcome: string; reason: string; at: number } | null; createdAt: number;
}
interface ShareRow { id: string; playerId: string; mode: string; createdAt: number; expiresAt: number; revokedAt: number | null; views: number; createdBy: string }
interface GraphEvent { id: string; source: { type: string; id: string }; provenance: string; visibility: string }
interface Graph {
  player: { id: string; name: string };
  timeline: { id: string; type: string; when: { display: string }; provenance: string }[];
  graph: GraphEvent[];
  conflicts: { code: string; authoritative: { orgName: string | null }; submitted: { orgName: string | null } }[];
  temporalConflicts: { code: string; kind: string; eventId?: string; key?: string }[];
}

const NOW = Date.now();
const cannedCorrections: CorrectionRow[] = [
  { id: 'pcor-d1', playerId: 'pl-adeyemi', targetType: 'club_history', targetId: 'row-eastport', reason: 'Joined in August, the record says July.', by: { kind: 'player', id: 'pl-adeyemi', name: 'Kola Adeyemi' }, status: 'open', resolution: null, createdAt: NOW - 5 * 3600e3 },
  { id: 'pcor-d0', playerId: 'pl-guni', targetType: 'achievement', targetId: 'pach-2', reason: 'Wrong season on the trophy entry.', by: { kind: 'guardian', id: 'gd-amara', name: 'Amara Adebayo' }, status: 'resolved', resolution: { outcome: 'corrected', reason: 'Season corrected after club confirmation.', at: NOW - 86400e3 }, createdAt: NOW - 2 * 86400e3 },
];
const cannedShares: ShareRow[] = [
  { id: 'pshr-d1', playerId: 'pl-adeyemi', mode: 'public', createdAt: NOW - 3 * 86400e3, expiresAt: NOW + 27 * 86400e3, revokedAt: null, views: 12, createdBy: 'player' },
  { id: 'pshr-d2', playerId: 'pl-guni', mode: 'recruitment', createdAt: NOW - 86400e3, expiresAt: NOW + 29 * 86400e3, revokedAt: null, views: 1, createdBy: 'guardian' },
];
const cannedGraph: Graph = {
  player: { id: 'pl-adeyemi', name: 'Kola Adeyemi' },
  timeline: [
    { id: 'pev:signing:sign-d1:signed', type: 'signed', when: { display: '2026-05-02' }, provenance: 'verified_club_confirmed' },
    { id: 'pev:career:pcar-d1:club_joined', type: 'club_joined', when: { display: '2018' }, provenance: 'player_submitted' },
  ],
  graph: [
    { id: 'pev:signing:sign-d1:signed', source: { type: 'signing', id: 'sign-d1' }, provenance: 'verified_club_confirmed', visibility: 'public' },
    { id: 'pev:career:pcar-d1:club_joined', source: { type: 'career_entry', id: 'pcar-d1' }, provenance: 'player_submitted', visibility: 'recruitment' },
  ],
  conflicts: [{ code: 'CURRENT_CLUB_CONFLICT', authoritative: { orgName: 'Eastport United FC' }, submitted: { orgName: 'Sunday Kings FC' } }],
  temporalConflicts: [],
};

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

export function M15Panel({ adminKey, say }: { tab: M15Tab; adminKey: string; say: (t: string) => void }) {
  const [corrections, setCorrections] = useState<CorrectionRow[]>([]);
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [graphId, setGraphId] = useState('');
  const [graph, setGraph] = useState<Graph | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const load = useCallback(async () => {
    if (DEMO) { setCorrections(cannedCorrections); setShares(cannedShares); return; }
    try {
      setCorrections((await call<{ items: CorrectionRow[] }>(adminKey, `/admin/passport/corrections${showResolved ? '?all=1' : ''}`)).items);
      setShares((await call<{ items: ShareRow[] }>(adminKey, '/admin/passport/shares')).items);
    } catch (e) { say(e instanceof Error ? e.message : 'load failed'); }
  }, [adminKey, say, showResolved]);
  useEffect(() => { void load(); }, [load]);

  const act = (fn: () => Promise<unknown>, done: string) =>
    (DEMO ? Promise.resolve() : fn()).then(() => { say(done); void load(); }).catch((e) => say(e instanceof Error ? e.message : 'failed'));

  const resolveBtns = (c: CorrectionRow) => (
    <>
      <ReasonButton primary label="Corrected" prompt="What was corrected, and on what basis? (audited, sent to the requester)" onGo={(reason) => act(() => post(adminKey, `/admin/passport/corrections/${c.id}/resolve`, { resolution: 'corrected', reason }), 'Resolved: corrected.')} />
      <ReasonButton label="Rejected" prompt="Why the record stands as it is (sent to the requester):" onGo={(reason) => act(() => post(adminKey, `/admin/passport/corrections/${c.id}/resolve`, { resolution: 'rejected', reason }), 'Resolved: rejected with reason.')} />
      <ReasonButton label="Referred" prompt="Where this is referred (e.g. the M14 verification dispute flow) and why:" onGo={(reason) => act(() => post(adminKey, `/admin/passport/corrections/${c.id}/resolve`, { resolution: 'referred', reason }), 'Resolved: referred.')} />
    </>
  );

  return (
    <div className="list-rows">
      <div className="notice">
        The Football Passport is a projection over source records — nothing here edits a source directly.
        A correction resolution documents what happened; claim-level changes go through the M14 verification
        tools, evidence changes through the M12 evidence tools.
      </div>

      <h3>Correction requests ({corrections.filter((c) => c.status === 'open').length} open)
        {' '}<button onClick={() => setShowResolved((x) => !x)}>{showResolved ? 'Open only' : 'Include resolved'}</button>
      </h3>
      {corrections.map((c) => (
        <div key={c.id} className="list-row" style={{ flexWrap: 'wrap' }}>
          <span className="grow">
            <b>{c.by.name}</b> <span className="pill blue">{c.by.kind}</span> on <b>{c.playerId}</b> · {c.targetType}{c.targetId ? ` (${c.targetId})` : ''}
            <div className="dim" style={{ fontSize: 12.5 }}>“{c.reason}” · {new Date(c.createdAt).toLocaleString()}</div>
            {c.resolution && <div className="dim" style={{ fontSize: 12 }}>→ {c.resolution.outcome}: {c.resolution.reason}</div>}
          </span>
          {c.status === 'open' ? resolveBtns(c) : <span className="pill green">{c.status}</span>}
        </div>
      ))}
      {corrections.length === 0 && <div className="dim">No correction requests.</div>}

      <h3>Share registry ({shares.filter((s) => !s.revokedAt).length} active)</h3>
      <div className="notice" style={{ fontSize: 12.5 }}>
        Tokens are stored hashed — nobody, including this console, can recover a link. Revocation is
        immediate, and a dead link is indistinguishable from an unknown one.
      </div>
      {shares.map((s) => (
        <div key={s.id} className="list-row">
          <span className="grow">
            <b>{s.playerId}</b> <span className={`pill ${s.mode === 'public' ? 'blue' : 'gold'}`}>{s.mode}</span>
            <span className="dim"> by {s.createdBy} · {s.views} views · expires {new Date(s.expiresAt).toLocaleDateString()}</span>
          </span>
          {s.revokedAt
            ? <span className="pill red">revoked</span>
            : <button onClick={() => act(() => post(adminKey, `/admin/passport/shares/${s.id}/revoke`, {}), 'Share revoked — the link is dead now.')}>Kill link</button>}
        </div>
      ))}
      {shares.length === 0 && <div className="dim">No shares minted.</div>}

      <h3>Source graph inspector</h3>
      <div className="notice" style={{ fontSize: 12.5 }}>
        The full projection for one player: every event with its source record, provenance and visibility —
        plus any flagged conflicts. This is the T&amp;S view; players and clubs never see this level of detail.
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input style={{ flex: 1 }} placeholder="Player id (e.g. pl-adeyemi)" value={graphId} onChange={(e) => setGraphId(e.target.value)} />
        <button className="primary" onClick={async () => {
          if (DEMO) { setGraph(cannedGraph); return; }
          try { setGraph(await call<Graph>(adminKey, `/admin/passport/${encodeURIComponent(graphId.trim())}/graph`)); } catch (e) { say(e instanceof Error ? e.message : 'failed'); }
        }}>Inspect</button>
      </div>
      {graph && (
        <>
          <h3 style={{ marginTop: 8 }}>{graph.player.name} <span className="dim">({graph.player.id})</span></h3>
          {graph.conflicts.map((cf) => (
            <div key={cf.code + (cf.submitted.orgName ?? '')} className="notice" style={{ fontSize: 12.5 }}>
              ⚖ {cf.code}: authoritative “{cf.authoritative.orgName}” vs player-submitted “{cf.submitted.orgName}” — a correction flag, never an automatic fraud accusation.
            </div>
          ))}
          {graph.temporalConflicts.map((tc, i) => (
            <div key={i} className="notice" style={{ fontSize: 12.5 }}>⏱ {tc.code} · {tc.kind} · {tc.eventId ?? tc.key ?? ''}</div>
          ))}
          {graph.graph.map((g) => (
            <div key={g.id} className="list-row">
              <span className="grow" style={{ fontFamily: 'monospace', fontSize: 12 }}>{g.id}</span>
              <span className="dim" style={{ fontSize: 12 }}>{g.source.type}:{g.source.id}</span>
              <span className="pill">{g.provenance}</span>
              <span className="pill blue">{g.visibility}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
