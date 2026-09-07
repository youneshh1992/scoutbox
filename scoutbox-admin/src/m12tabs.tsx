// M12 Trust & Safety additions: evidence disputes, coach affiliations,
// trial-day staff-check review, post-signing outcome aggregates, and
// drill-guidance coach review. VITE_DEMO=1 runs on canned synthetic rows.
import { useCallback, useEffect, useState } from 'react';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
const DEMO = import.meta.env.VITE_DEMO === '1';

export type M12Tab = 'disputes' | 'coaches' | 'staffchecks' | 'outcomes' | 'drillguide';
export const M12_TABS: { id: M12Tab; label: string }[] = [
  { id: 'disputes', label: 'Evidence disputes' },
  { id: 'staffchecks', label: 'Staff checks' },
  { id: 'coaches', label: 'Coach affiliations' },
  { id: 'outcomes', label: 'Outcome tracking' },
  { id: 'drillguide', label: 'Drill guidance' },
];

interface Dispute { id: string; evidenceId: string; playerId: string; label: string; tier: string; reason: string; at: number; by: { name: string }; status: string }
interface Affiliation { id: string; orgName: string; coachName: string; role: string; from: string; to: string | null; status: string; conflictOfInterest: string | null; confirmedBy: { name: string } }
interface StaffCheck { trialId: string; orgName: string; staffId: string; name: string; role: string; check: { kind: string; ref: string | null; status: string; state: string; expiresAt: string | null } }
interface OutcomeRow { orgId: string; orgName: string; suppressed: boolean; note?: string; signings?: number; followUpsDue?: number; reported?: number; confirmed?: number; disputed?: number; unknown?: number; retained?: number; denominator?: string }
interface Guidance { drillId: string; recording: Record<string, string>; coachReview: { status: string; reviewer: string | null; at: number | null } }

const NOW = Date.now();
const canned = {
  disputes: [
    { id: 'dsp-1', evidenceId: 'evd-d9', playerId: 'pl-adeyemi', label: 'League goals 2025/26 — 12', tier: 'self_reported', reason: 'Club records show 11, not 12.', at: NOW - 3600e3, by: { name: 'Maria Keane · Eastport FC' }, status: 'open' },
  ] as Dispute[],
  coaches: [
    { id: 'aff-1', orgName: 'Hackney Marsh Rovers', coachName: 'Dee Mensah', role: 'Head Coach', from: '2024-08-01', to: null, status: 'confirmed', conflictOfInterest: 'none declared', confirmedBy: { name: 'Dee Mensah' } },
    { id: 'aff-2', orgName: 'Moss Side Athletic', coachName: 'Ray Holt', role: 'U18 Coach', from: '2023-09-01', to: '2026-06-30', status: 'revoked', conflictOfInterest: 'uncle of a squad player', confirmedBy: { name: 'S. Byrne' } },
  ] as Affiliation[],
  staffchecks: [
    { trialId: 'trial-demo-1', orgName: 'Eastport FC', staffId: 'stf-d2', name: 'Marcus Cole', role: 'U23 Coach', check: { kind: 'DBS (England & Wales)', ref: 'DBS-9917', status: 'pending', state: 'pending', expiresAt: null } },
  ] as StaffCheck[],
  outcomes: [
    { orgId: 'org-eastport', orgName: 'Eastport FC', suppressed: true, note: 'Fewer than 3 signings — details suppressed to protect individual responses.' },
    { orgId: 'org-hackneymarsh', orgName: 'Hackney Marsh Rovers', suppressed: false, signings: 5, followUpsDue: 4, reported: 3, confirmed: 2, disputed: 0, unknown: 1, retained: 3, denominator: 'retention counts confirmed+reported registrations over 4 due follow-ups (1 unknown)' },
  ] as OutcomeRow[],
  drillguide: [
    { drillId: 'sprint-30', recording: { equipment: 'Any phone camera ≥ 720p', camera: 'Fixed position, side-on' }, coachReview: { status: 'unreviewed', reviewer: null, at: null } },
    { drillId: 'cone-weave', recording: { equipment: 'Any phone camera ≥ 720p', camera: 'Fixed, elevated if possible' }, coachReview: { status: 'reviewed', reviewer: 'T&S football staff', at: NOW - 5 * 86400e3 } },
  ] as Guidance[],
};

async function call<T>(key: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-admin-key': key, ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? body.error ?? res.statusText);
  return body as T;
}

export function M12Panel({ tab, adminKey, say }: { tab: M12Tab; adminKey: string; say: (t: string) => void }) {
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [coaches, setCoaches] = useState<Affiliation[]>([]);
  const [checks, setChecks] = useState<StaffCheck[]>([]);
  const [outcomes, setOutcomes] = useState<OutcomeRow[]>([]);
  const [guide, setGuide] = useState<Guidance[]>([]);

  const load = useCallback(async () => {
    if (DEMO) {
      setDisputes(canned.disputes.filter((d) => d.status === 'open'));
      setCoaches(canned.coaches); setChecks(canned.staffchecks);
      setOutcomes(canned.outcomes); setGuide(canned.drillguide);
      return;
    }
    try {
      setDisputes((await call<{ items: Dispute[] }>(adminKey, '/admin/evidence/disputes')).items);
      setCoaches((await call<{ items: Affiliation[] }>(adminKey, '/admin/coaches')).items);
      setChecks((await call<{ items: StaffCheck[] }>(adminKey, '/admin/staff-checks')).items);
      setOutcomes((await call<{ rows: OutcomeRow[] }>(adminKey, '/admin/outcomes')).rows);
      setGuide((await call<{ items: Guidance[] }>(adminKey, '/admin/drill-guidance')).items);
    } catch (e) { say(e instanceof Error ? e.message : 'Load failed'); }
  }, [adminKey, say]);
  useEffect(() => { void load(); }, [load, tab]);

  if (tab === 'disputes') {
    return (
      <div>
        <p className="notice">A dispute freezes nothing automatically — a human reads both sides. Upholding with downgrade returns the claim to self-reported.</p>
        {disputes.length === 0 && <p className="notice">No open disputes.</p>}
        {disputes.map((d) => (
          <div className="list-row" key={d.id}>
            <div className="grow">
              <b>{d.label}</b> <span className="pill">{d.tier.replace('_', ' ')}</span>
              <div className="notice">{d.by.name}: “{d.reason}”</div>
            </div>
            <button onClick={async () => {
              if (DEMO) { setDisputes([]); say('Upheld — claim downgraded to self-reported (demo).'); return; }
              await call(adminKey, `/admin/evidence/disputes/${d.id}/resolve`, { method: 'POST', body: JSON.stringify({ resolution: 'upheld', downgrade: true, note: 'club evidence stronger' }) });
              say('Upheld — verification downgraded.'); void load();
            }}>Uphold + downgrade</button>
            <button onClick={async () => {
              if (DEMO) { setDisputes([]); say('Rejected (demo).'); return; }
              await call(adminKey, `/admin/evidence/disputes/${d.id}/resolve`, { method: 'POST', body: JSON.stringify({ resolution: 'rejected', note: 'claim stands' }) });
              say('Rejected — the claim stands.'); void load();
            }}>Reject</button>
          </div>
        ))}
      </div>
    );
  }
  if (tab === 'coaches') {
    return (
      <div>
        <p className="notice">Club-confirmed affiliations with conflict declarations. Revocation removes CURRENT privileges only — historical references stay attributed.</p>
        {coaches.map((a) => (
          <div className="list-row" key={a.id}>
            <div className="grow">
              <b>{a.coachName}</b> · {a.role} · {a.orgName}
              <div className="notice">{a.from}{a.to ? ` → ${a.to}` : ' → current'} · confirmed by {a.confirmedBy.name}{a.conflictOfInterest ? ` · declared: ${a.conflictOfInterest}` : ''}</div>
            </div>
            <span className={`pill ${a.status === 'confirmed' ? 'green' : a.status === 'revoked' ? 'red' : ''}`}>{a.status}</span>
          </div>
        ))}
      </div>
    );
  }
  if (tab === 'staffchecks') {
    return (
      <div>
        <p className="notice">A filed reference is NOT a completed background check — pending stays pending until a human reviews it here.</p>
        {checks.length === 0 && <p className="notice">Nothing pending.</p>}
        {checks.map((c) => (
          <div className="list-row" key={`${c.trialId}-${c.staffId}`}>
            <div className="grow">
              <b>{c.name}</b> · {c.role} · {c.orgName}
              <div className="notice">{c.check.kind}{c.check.ref ? ` · ref ${c.check.ref}` : ''} · trial {c.trialId}</div>
            </div>
            <span className={`pill ${c.check.state === 'reviewed' ? 'green' : 'gold'}`}>{c.check.state}</span>
            {c.check.status === 'pending' && <>
              <button onClick={async () => {
                if (DEMO) { setChecks((xs) => xs.map((x) => x.staffId === c.staffId ? { ...x, check: { ...x.check, status: 'reviewed', state: 'reviewed' } } : x)); say('Marked reviewed (demo).'); return; }
                await call(adminKey, `/admin/staff-checks/${c.trialId}/${c.staffId}`, { method: 'POST', body: JSON.stringify({ status: 'reviewed', expiresAt: new Date(Date.now() + 365 * 86400e3).toISOString() }) });
                say('Check reviewed.'); void load();
              }}>Mark reviewed</button>
              <button onClick={async () => {
                if (DEMO) { setChecks((xs) => xs.filter((x) => x.staffId !== c.staffId)); say('Rejected (demo).'); return; }
                await call(adminKey, `/admin/staff-checks/${c.trialId}/${c.staffId}`, { method: 'POST', body: JSON.stringify({ status: 'rejected' }) });
                say('Check rejected — check-in stays blocked.'); void load();
              }}>Reject</button>
            </>}
          </div>
        ))}
      </div>
    );
  }
  if (tab === 'outcomes') {
    return (
      <div>
        <p className="notice">Defined denominators; unknown counted as unknown; orgs with fewer than 3 signings are suppressed so no individual answer is inferable.</p>
        {outcomes.map((o) => (
          <div className="list-row" key={o.orgId}>
            <div className="grow">
              <b>{o.orgName}</b>
              {o.suppressed
                ? <div className="notice">🔒 {o.note}</div>
                : <div className="notice">{o.signings} signings · {o.followUpsDue} due · {o.confirmed} confirmed · {o.disputed} disputed · {o.unknown} unknown · {o.retained} retained<br />{o.denominator}</div>}
            </div>
            {o.suppressed && <span className="pill">suppressed</span>}
          </div>
        ))}
      </div>
    );
  }
  // drillguide
  return (
    <div>
      <p className="notice">Instructional content is labelled honestly: “unreviewed” until a named person reviews it. No professional validation is claimed where none happened.</p>
      {guide.map((g) => (
        <div className="list-row" key={g.drillId}>
          <div className="grow">
            <b>{g.drillId}</b>
            <div className="notice">{Object.values(g.recording).join(' · ')}</div>
          </div>
          <span className={`pill ${g.coachReview.status === 'reviewed' ? 'green' : 'gold'}`}>{g.coachReview.status}{g.coachReview.reviewer ? ` · ${g.coachReview.reviewer}` : ''}</span>
          {g.coachReview.status === 'unreviewed' && (
            <button onClick={async () => {
              if (DEMO) { setGuide((xs) => xs.map((x) => x.drillId === g.drillId ? { ...x, coachReview: { status: 'reviewed', reviewer: 'T&S football staff', at: Date.now() } } : x)); say('Reviewed (demo).'); return; }
              await call(adminKey, `/admin/drill-guidance/${g.drillId}/review`, { method: 'POST', body: JSON.stringify({ reviewer: 'T&S football staff' }) });
              say('Guidance marked reviewed by a named person.'); void load();
            }}>Mark reviewed</button>
          )}
        </div>
      ))}
    </div>
  );
}
