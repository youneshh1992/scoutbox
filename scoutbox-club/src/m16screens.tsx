// M16 org screens — coach-assigned Box Training in the player drawer.
// The coach assigns supported drills, sees Box Cam results (never footage),
// and can publish Box Challenges. Honest wall copy when the standing gates
// refuse (agency excluded, unverified/suspended orgs, radius, blocks).
import { useEffect, useState } from 'react';
import { ApiError, type Session } from './api';
import { m16, type BoxAssignments, type BoxDrill } from './m16api';
import { t } from './i18n';

function wallMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'AGENCY_NOT_ELIGIBLE') return t('bt.wallAgency');
    if (e.code === 'ORG_NOT_ELIGIBLE') return t('bt.wallUnverified');
    if (e.code === 'ORG_SUSPENDED') return t('bt.wallSuspended');
    if (e.code === 'UNDER_18_WALL') return t('bt.wallMinor');
    if (e.code === 'NOT_VISIBLE') return t('bt.wallNotVisible');
    return e.message;
  }
  return e instanceof Error ? e.message : 'failed';
}

const fmtTarget = (target: { type: string; value: number }) => target.type === 'duration' ? `${Math.round(target.value / 60000)}m` : `${target.value}`;

export function BoxTrainingPanel({ session, playerId, notify }: { session: Session; playerId: string; notify: (text: string, error?: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<BoxAssignments | null>(null);
  const [drills, setDrills] = useState<BoxDrill[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const [drillId, setDrillId] = useState('');
  const [targetValue, setTargetValue] = useState('');
  const [freq, setFreq] = useState('');
  const [instructions, setInstructions] = useState('');

  useEffect(() => {
    if (!open) return;
    let live = true;
    setErr(null);
    m16.drills(session).then((d) => { if (live) { setDrills(d); if (!drillId && d[0]) setDrillId(d[0].id); } }).catch(() => {});
    m16.assignments(session, playerId).then((x) => live && setData(x)).catch((e) => live && setErr(wallMessage(e)));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, playerId, open, bump]);

  const drill = drills.find((d) => d.id === drillId);
  const targetType = drill?.targetTypes[0] ?? 'duration';

  async function assign() {
    if (!drill) return;
    const value = Number(targetValue) || (targetType === 'duration' ? 20 : 100);
    try {
      await m16.createAssignment(session, {
        playerId, drillId: drill.id,
        target: { type: targetType, value: targetType === 'duration' ? value * 60000 : value },
        frequencyPerWeek: Number(freq) || undefined,
        instructions: instructions.trim() || undefined,
      });
      notify(t('bt.assigned'));
      setInstructions(''); setTargetValue(''); setFreq('');
      setBump((b) => b + 1);
    } catch (e) { notify(wallMessage(e), true); }
  }

  return (
    <div className="section" aria-label={t('bt.title')}>
      <h4>🎥 {t('bt.title')} <button style={{ marginLeft: 8 }} onClick={() => setOpen((x) => !x)}>{open ? t('bt.hide') : t('bt.show')}</button></h4>
      {open && err && <div className="notice block">{err}</div>}
      {open && data && (
        <>
          <div className="dim" style={{ fontSize: 12.5 }}>{data.note}</div>
          <div className="list-rows" style={{ marginTop: 8 }}>
            {data.items.length === 0 && <div className="dim">{t('bt.none')}</div>}
            {data.items.map((a) => (
              <div key={a.id} className="list-row" style={{ flexWrap: 'wrap' }}>
                <span className="grow"><b>{a.drillTitle}</b> <span className="dim">{fmtTarget(a.target)}{a.frequencyPerWeek ? ` ×${a.frequencyPerWeek}/wk` : ''}</span>
                  {a.lastResult && <div className="dim" style={{ fontSize: 12 }}>{t('bt.boxCam')}: {a.lastResult.verifiedReps != null ? `${a.lastResult.verifiedReps}` : a.lastResult.verifiedActive} — {a.lastResult.statusLabel}</div>}
                </span>
                <span className={`pill ${a.state === 'completed' ? 'green' : a.state === 'partially_completed' ? 'gold' : ''}`}>{t(`bt.state.${a.state}`, a.state)}</span>
                {!['cancelled', 'superseded', 'completed'].includes(a.state) && <button aria-label={`${t('bt.cancel')} ${a.drillTitle}`} onClick={async () => { try { await m16.cancelAssignment(session, a.id); setBump((b) => b + 1); } catch (e) { notify(wallMessage(e), true); } }}>{t('bt.cancel')}</button>}
              </div>
            ))}
          </div>
          <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('bt.summary')}: {data.summary.completed}✓ · {data.summary.partial} {t('bt.partial')} · {data.summary.notStarted} {t('bt.notStarted')}</div>

          <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <h4 style={{ margin: '0 0 6px' }}>{t('bt.assign')}</h4>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select value={drillId} onChange={(e) => setDrillId(e.target.value)} aria-label={t('bt.drill')}>
                {drills.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
              </select>
              <input style={{ width: 90 }} placeholder={targetType === 'duration' ? t('bt.minutes') : t('bt.reps')} value={targetValue} onChange={(e) => setTargetValue(e.target.value)} aria-label={t('bt.target')} />
              <input style={{ width: 70 }} placeholder={t('bt.perWeek')} value={freq} onChange={(e) => setFreq(e.target.value)} aria-label={t('bt.perWeek')} />
              <input style={{ flex: 1, minWidth: 140 }} placeholder={t('bt.instructions')} value={instructions} onChange={(e) => setInstructions(e.target.value)} aria-label={t('bt.instructions')} />
              <button className="primary" onClick={assign}>{t('bt.assign')}</button>
            </div>
            {drill?.repSupport === 'not_configured' && <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>ⓘ {drill.repSupportNote}</div>}
            <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('bt.assignNote')}</div>
          </div>
        </>
      )}
    </div>
  );
}
