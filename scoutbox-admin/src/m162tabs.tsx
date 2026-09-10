// M16.2 Trust & Safety — the ScoutBox Trust Score derivation inspector.
//
// The Trust Score is EVIDENCE CONFIDENCE, derived at read time from canonical
// evidence. It is never ability, potential, character or recruitment
// suitability, and a low score means limited evidence — never a judgement of
// the person.
//
// This console is READ-ONLY BY DESIGN: there is no route that writes a score
// and no input here that could. A wrong score is fixed by correcting the
// underlying evidence or the policy, then recalculating.
import { useCallback, useEffect, useState } from 'react';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
const DEMO = import.meta.env.VITE_DEMO === '1';

export type M162Tab = 'trust';
export const M162_TABS: { id: M162Tab; label: string }[] = [{ id: 'trust', label: 'Trust' }];

export const TRUST_NO_WRITE_NOTICE =
  'Trust Score is derived at read time from canonical evidence. Trust & Safety cannot set or adjust a score — correct the underlying evidence or the policy, then recalculate.';

interface Signal { code: string; text: string }
interface Explanation { component: string; level: string; levelLabel: string; weight: number; coverage: number; reasons: string[] }
interface TrustProfile {
  score: number; band: string; bandLabel: string; policyVersion: number; disclaimer: string;
  simulatedEvidenceIncluded: boolean; viewer: string;
  components: Record<string, { weight: number; coverageBp: number; level: { id: string; label: string }; reasons: string[]; strengths: Signal[]; gaps: Signal[]; detail: Record<string, unknown> }>;
  strengths: Signal[]; gaps: Signal[]; explanations: Explanation[];
  context: { isAdult: boolean; adultOnlyFacetsExcluded: string[] };
}
interface Snapshot { at: number; score: number; band: string; policyVersion: number; hash: string }
interface TrustResponse { playerId: string; trust: TrustProfile; policy: { version: number; weights: Record<string, number> }; snapshot: Snapshot; note: string }
interface PolicyResponse {
  policyVersion: number; weights: Record<string, number>;
  bands: { id: string; label: string; min: number; max: number }[];
  curves: Record<string, number[]>; subCaps: Record<string, number>; disclaimer: string;
}

const COMPONENT_LABELS: Record<string, string> = {
  identity: 'Identity', footballHistory: 'Football history', relationships: 'Relationships',
  evidence: 'Evidence', combine: 'Combine', references: 'References',
};
const label = (id: string) => COMPONENT_LABELS[id] ?? id;

const DISCLAIMER = 'ScoutBox Trust Score reflects verification and evidence confidence — not football ability or recruitment suitability.';

// -------------------------------------------------------------- demo state
const cannedPolicy: PolicyResponse = {
  policyVersion: 1,
  weights: { identity: 15, footballHistory: 20, relationships: 20, evidence: 20, combine: 15, references: 10 },
  bands: [
    { id: 'limited_evidence', label: 'Limited evidence', min: 0, max: 39 },
    { id: 'developing_evidence', label: 'Developing evidence', min: 40, max: 59 },
    { id: 'established_evidence', label: 'Established evidence', min: 60, max: 74 },
    { id: 'strong_evidence', label: 'Strong evidence', min: 75, max: 89 },
    { id: 'very_strong_evidence', label: 'Very strong evidence', min: 90, max: 100 },
  ],
  curves: {
    relationships: [0, 5000, 7500, 9000, 10000],
    combineProtocols: [0, 5500, 8000, 9200, 10000],
    boxCam: [0, 4500, 6500, 8000, 8800, 9400, 10000],
    evidenceRecords: [0, 4000, 6000, 7500, 8500, 9200, 10000],
    references: [0, 5500, 8000, 10000],
  },
  subCaps: { evidenceRecords: 6000, boxCam: 6000 },
  disclaimer: DISCLAIMER,
};

const cannedExplanations: Explanation[] = [
  { component: 'identity', level: 'established', levelLabel: 'Established', weight: 15, coverage: 70, reasons: ['Identity confirmed by ScoutBox review.', 'Identity was confirmed by document review rather than an authoritative source.'] },
  { component: 'footballHistory', level: 'strong', levelLabel: 'Strong', weight: 20, coverage: 88, reasons: ['Your current club is confirmed.', '2 club records are independently confirmed.', '1 club entry is provided by the player and not independently confirmed.'] },
  { component: 'relationships', level: 'strong', levelLabel: 'Strong', weight: 20, coverage: 75, reasons: ['1 verified club relationship.', '1 verified coach relationship.'] },
  { component: 'evidence', level: 'strong', levelLabel: 'Strong', weight: 20, coverage: 85, reasons: ['1 provenance-bearing evidence item on record.', '1 Box Cam observed training session.'] },
  { component: 'combine', level: 'very_strong', levelLabel: 'Very strong', weight: 15, coverage: 92, reasons: ['3 standardized Combine Verified measurements.'] },
  { component: 'references', level: 'established', levelLabel: 'Established', weight: 10, coverage: 55, reasons: ['1 reference with verified provenance.'] },
];

const cannedTrust: TrustResponse = {
  playerId: 'pl-adeyemi',
  trust: {
    score: 79, band: 'strong_evidence', bandLabel: 'Strong evidence', policyVersion: 1,
    disclaimer: DISCLAIMER, simulatedEvidenceIncluded: true, viewer: 'trust_safety',
    components: Object.fromEntries(cannedExplanations.map((e) => [e.component, {
      weight: e.weight, coverageBp: e.coverage * 100, level: { id: e.level, label: e.levelLabel },
      reasons: [], strengths: [], gaps: [], detail: {},
    }])),
    strengths: [], gaps: [], explanations: cannedExplanations,
    context: { isAdult: false, adultOnlyFacetsExcluded: ['agency_representation'] },
  },
  policy: { version: 1, weights: cannedPolicy.weights },
  snapshot: { at: Date.now(), score: 79, band: 'strong_evidence', policyVersion: 1, hash: 'b7c0e2d4a1f38596c4d20e7f9a1b3c5d' },
  note: TRUST_NO_WRITE_NOTICE,
};

async function call<T>(key: string, path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers: { 'content-type': 'application/json', 'x-admin-key': key } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? body.error ?? res.statusText);
  return body as T;
}

export function M162Panel({ adminKey, say }: { tab: M162Tab; adminKey: string; say: (t: string) => void }) {
  const [policy, setPolicy] = useState<PolicyResponse | null>(null);
  const [playerId, setPlayerId] = useState(DEMO ? 'pl-adeyemi' : '');
  const [data, setData] = useState<TrustResponse | null>(null);

  const loadPolicy = useCallback(async () => {
    if (DEMO) { setPolicy(cannedPolicy); return; }
    try { setPolicy(await call<PolicyResponse>(adminKey, '/admin/trust-policy')); }
    catch (e) { say(e instanceof Error ? e.message : 'policy load failed'); }
  }, [adminKey, say]);
  useEffect(() => { void loadPolicy(); }, [loadPolicy]);

  async function loadPlayer() {
    const id = playerId.trim();
    if (!id) { say('Enter a player id to inspect its derivation.'); return; }
    if (DEMO) { setData({ ...cannedTrust, playerId: id }); return; }
    try { setData(await call<TrustResponse>(adminKey, `/admin/trust/${encodeURIComponent(id)}`)); }
    catch (e) { setData(null); say(e instanceof Error ? e.message : 'load failed'); }
  }

  return (
    <div className="list-rows">
      {/* The core constraint, stated where staff act. */}
      <div className="notice">{TRUST_NO_WRITE_NOTICE}</div>
      <div className="notice">{policy?.disclaimer ?? DISCLAIMER}</div>

      {/* Read-only lookup: a player id in, a derivation out. No write control
          exists on this screen — by design, not by permission. */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          style={{ minWidth: 220 }}
          placeholder="Player id (e.g. pl-adeyemi)"
          aria-label="Player id"
          value={playerId}
          onChange={(e) => setPlayerId(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void loadPlayer()}
        />
        <button className="primary" onClick={() => void loadPlayer()}>Show derivation</button>
      </div>

      {data && (
        <>
          <div className="list-row" style={{ flexWrap: 'wrap' }}>
            <span className="grow"><b>{data.playerId}</b></span>
            <span style={{ fontSize: 26, fontWeight: 800 }}>{data.trust.score}</span>
            <span className="dim">/ 100</span>
            <span className="pill blue">{data.trust.bandLabel}</span>
            <span className="pill">policy v{data.trust.policyVersion}</span>
            {data.trust.simulatedEvidenceIncluded && <span className="pill gold">simulated evidence included</span>}
          </div>
          <div className="dim" style={{ fontSize: 12.5 }}>{data.trust.disclaimer || DISCLAIMER}</div>

          {/* Full derivation: component level, coverage, weight and the exact
              human-readable reasons the engine produced. */}
          <h3 style={{ marginBottom: 0 }}>Derivation</h3>
          <table className="data">
            <thead><tr><th>Component</th><th>Level</th><th>Coverage</th><th>Weight</th><th>Reasons</th></tr></thead>
            <tbody>
              {data.trust.explanations.map((e) => (
                <tr key={e.component}>
                  <td>{label(e.component)}</td>
                  <td>{e.levelLabel}</td>
                  <td>{e.coverage}%</td>
                  <td>{e.weight}</td>
                  <td>{e.reasons.length > 0 ? e.reasons.map((r, i) => <div key={i} className="dim" style={{ fontSize: 12.5 }}>{r}</div>) : <span className="dim">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.trust.context.adultOnlyFacetsExcluded.length > 0 && (
            <div className="dim" style={{ fontSize: 12.5 }}>
              Excluded for this account (never counted as missing): {data.trust.context.adultOnlyFacetsExcluded.join(', ')}
            </div>
          )}

          <div className="dim" style={{ fontSize: 11.5, fontFamily: 'monospace' }}>
            snapshot: score={data.snapshot.score} · band={data.snapshot.band} · policy=v{data.snapshot.policyVersion} · hash={data.snapshot.hash.slice(0, 24)}…
          </div>
          <div className="dim" style={{ fontSize: 12.5 }}>{data.note}</div>
        </>
      )}

      {/* Policy: the versioned table every score is derived from. Changing a
          score means changing this, then recalculating — never typing a number. */}
      <h3 style={{ marginBottom: 0 }}>Policy v{policy?.policyVersion ?? '—'}</h3>
      {policy ? (
        <>
          <table className="data">
            <thead><tr><th>Component</th><th>Weight</th></tr></thead>
            <tbody>
              {Object.entries(policy.weights).map(([k, w]) => (
                <tr key={k}><td>{label(k)}</td><td>{w}</td></tr>
              ))}
              <tr><td><b>Total</b></td><td><b>{Object.values(policy.weights).reduce((t, n) => t + n, 0)}</b></td></tr>
            </tbody>
          </table>
          <div className="dim" style={{ fontSize: 12.5 }}>
            Bands: {policy.bands.map((b) => `${b.label} ${b.min}–${b.max}`).join(' · ')}
          </div>
          <div className="dim" style={{ fontSize: 11.5, fontFamily: 'monospace' }}>
            sub-caps: {Object.entries(policy.subCaps).map(([k, v]) => `${k}=${v}bp`).join(' · ')}
          </div>
          <div className="dim" style={{ fontSize: 11.5, fontFamily: 'monospace' }}>
            curves: {Object.entries(policy.curves).map(([k, v]) => `${k}=[${(v ?? []).join(',')}]`).join(' · ')}
          </div>
        </>
      ) : <div className="dim">Policy not loaded.</div>}
    </div>
  );
}
