// M16 Trust & Safety — Box Cam cases. T&S can invalidate a Box Cam result
// (or let it stand) with a written reason, and restore an invalidated one —
// but can NEVER fabricate verified duration, rep counts or completion. The
// integrity inspector shows the server-derived result and its hash; frame
// observations are not editable here.
import { useCallback, useEffect, useState } from 'react';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
const DEMO = import.meta.env.VITE_DEMO === '1';

export type M16Tab = 'boxcam';
export const M16_TABS: { id: M16Tab; label: string }[] = [{ id: 'boxcam', label: 'Box Cam' }];

interface SessionView {
  id: string; playerId: string; drillTitle: string; verificationState: string | null;
  verifiedActiveMs: number | null; verifiedReps: number | null; sessionDurationMs: number | null;
  targetCompleted: boolean | null; provider: string; providerVersion: number; simulated: boolean;
  resultHash?: string | null; lastSeq?: number; batches?: number; verificationReasons?: string[];
}
interface Dispute { id: string; sessionId: string; playerId: string; by: { kind: string; name: string }; reason: string; status: string; resolution: { outcome: string; reason: string } | null; createdAt: number; session: SessionView }

const NOW = Date.now();
const canned: Dispute[] = [
  { id: 'boxd-d1', sessionId: 'boxs-d1', playerId: 'pl-adeyemi', by: { kind: 'player', name: 'Kola Adeyemi' }, reason: 'Box Cam missed my last few minutes — the camera fogged up.', status: 'open', resolution: null, createdAt: NOW - 4 * 3600e3, session: { id: 'boxs-d1', playerId: 'pl-adeyemi', drillTitle: 'Box Control', verificationState: 'partially_verified', verifiedActiveMs: 1123000, verifiedReps: null, sessionDurationMs: 1267000, targetCompleted: false, provider: 'local_test', providerVersion: 1, simulated: true, resultHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', lastSeq: 412, batches: 84, verificationReasons: ['TARGET_NOT_YET_COMPLETED', 'OBSERVATION_QUALITY_DEGRADED'] } },
];
const fmt = (ms: number | null | undefined) => ms == null ? '—' : `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

async function call<T>(key: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-admin-key': key, ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? body.error ?? res.statusText);
  return body as T;
}
const post = (key: string, path: string, body: unknown) => call(key, path, { method: 'POST', body: JSON.stringify(body) });

function ReasonButton({ label, prompt: promptText, onGo, primary }: { label: string; prompt: string; onGo: (reason: string) => void; primary?: boolean }) {
  return <button className={primary ? 'primary' : ''} onClick={() => { const r = window.prompt(promptText, ''); if (r && r.trim()) onGo(r.trim()); }}>{label}</button>;
}

export function M16Panel({ adminKey, say }: { tab: M16Tab; adminKey: string; say: (t: string) => void }) {
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [showResolved, setShowResolved] = useState(false);

  const load = useCallback(async () => {
    if (DEMO) { setDisputes(canned); return; }
    try { setDisputes((await call<{ items: Dispute[] }>(adminKey, `/admin/box-cam/disputes${showResolved ? '?all=1' : ''}`)).items); }
    catch (e) { say(e instanceof Error ? e.message : 'load failed'); }
  }, [adminKey, say, showResolved]);
  useEffect(() => { void load(); }, [load]);

  const act = (fn: () => Promise<unknown>, done: string) => (DEMO ? Promise.resolve() : fn()).then(() => { say(done); void load(); }).catch((e) => say(e instanceof Error ? e.message : 'failed'));

  return (
    <div className="list-rows">
      <div className="notice">
        Box Cam results are server-derived from observed activity. Trust &amp; Safety can invalidate a result (or let it stand)
        with a written, audited reason, and restore an invalidated one — but never fabricates verified duration, repetition
        counts or completion. Simulated (demo) sessions are always labelled.
      </div>
      <h3>Box Cam disputes ({disputes.filter((d) => d.status === 'open').length} open)
        {' '}<button onClick={() => setShowResolved((x) => !x)}>{showResolved ? 'Open only' : 'Include resolved'}</button>
      </h3>
      {disputes.map((d) => (
        <div key={d.id} className="list-row" style={{ flexWrap: 'wrap', flexDirection: 'column', alignItems: 'stretch' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="grow"><b>{d.by.name}</b> <span className="pill blue">{d.by.kind}</span> — “{d.reason}”</span>
            {d.status === 'open' ? (
              <>
                <ReasonButton label="Result stands" prompt="Why the result stands (sent to the reporter):" onGo={(reason) => act(() => post(adminKey, `/admin/box-cam/disputes/${d.id}/resolve`, { outcome: 'stands', reason }), 'Resolved: result stands.')} />
                <ReasonButton label="Invalidate" prompt="Reason for invalidating this Box Cam result:" onGo={(reason) => act(() => post(adminKey, `/admin/box-cam/disputes/${d.id}/resolve`, { outcome: 'invalidated', reason }), 'Result invalidated.')} />
                <ReasonButton label="Provider bug" prompt="Describe the provider issue (invalidates the result):" onGo={(reason) => act(() => post(adminKey, `/admin/box-cam/disputes/${d.id}/resolve`, { outcome: 'provider_bug', reason }), 'Logged as a provider bug; result invalidated.')} />
              </>
            ) : <span className={`pill ${d.resolution?.outcome === 'stands' ? 'green' : 'red'}`}>{d.resolution?.outcome}</span>}
          </div>
          <div className="dim" style={{ fontSize: 12.5, marginTop: 6, fontFamily: 'monospace' }}>
            {d.session.drillTitle} · state={d.session.verificationState} · verified={d.session.verifiedReps != null ? `${d.session.verifiedReps} reps` : fmt(d.session.verifiedActiveMs)} · session={fmt(d.session.sessionDurationMs)} · provider={d.session.provider}@{d.session.providerVersion}{d.session.simulated ? ' (simulated)' : ''}
          </div>
          {d.session.resultHash && <div className="dim" style={{ fontSize: 11, fontFamily: 'monospace' }}>hash={d.session.resultHash.slice(0, 24)}… · seq={d.session.lastSeq} · batches={d.session.batches} · reasons={(d.session.verificationReasons ?? []).join(', ') || '—'}</div>}
          {d.status !== 'open' && d.session.verificationState === 'invalidated' && (
            <div style={{ marginTop: 6 }}>
              <ReasonButton label="Restore result" prompt="Reason for restoring the original result:" onGo={(reason) => act(() => post(adminKey, `/admin/box-cam/sessions/${d.sessionId}/restore`, { reason }), 'Result restored (history preserved).')} />
            </div>
          )}
        </div>
      ))}
      {disputes.length === 0 && <div className="dim">No Box Cam disputes.</div>}
    </div>
  );
}
