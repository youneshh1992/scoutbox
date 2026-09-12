// M16.1 org screen — the At-Home Combine panel in the player drawer. A
// verified, non-agency org requests standardized Combine tests, tracks their
// completion, and reads the player's Combine Verified RESULTS only — never raw
// home footage, DOB or notes. The comparison shows verified numbers with blank
// (never zero) cells and no overall ranking. Honest wall copy when the standing
// gates refuse (agency, unverified/suspended org, radius, blocks).
import { useEffect, useState } from 'react';
import { ApiError, type Session } from './api';
import { combine, STANDARD_PROTOCOLS, type CombineRequestRow, type PlayerCombine, type CompareMatrix } from './combineApi';
import { t } from './i18n';

function wallMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'AGENCY_NOT_ELIGIBLE') return t('cmb.wallAgency');
    if (e.code === 'ORG_NOT_ELIGIBLE') return t('cmb.wallUnverified');
    if (e.code === 'ORG_SUSPENDED') return t('cmb.wallSuspended');
    if (e.code === 'NOT_VISIBLE') return t('cmb.wallNotVisible');
    if (e.code === 'PROTOCOLS_REQUIRED') return t('cmb.needProtocols');
    return e.message;
  }
  return e instanceof Error ? e.message : 'failed';
}

export function CombinePanel({ session, playerId, notify }: { session: Session; playerId: string; notify: (text: string, error?: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [player, setPlayer] = useState<PlayerCombine | null>(null);
  const [requests, setRequests] = useState<CombineRequestRow[]>([]);
  const [compare, setCompare] = useState<CompareMatrix | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set(['combine-box-control-60']));
  const [title, setTitle] = useState('');
  const [deadline, setDeadline] = useState('');
  const [instructions, setInstructions] = useState('');

  useEffect(() => {
    if (!open) return;
    let live = true;
    setErr(null);
    combine.player(session, playerId).then((p) => live && setPlayer(p)).catch((e) => live && setErr(wallMessage(e)));
    combine.requests(session, playerId).then((r) => live && setRequests(r)).catch((e) => live && setErr(wallMessage(e)));
    combine.compare(session, [playerId]).then((c) => live && setCompare(c)).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, playerId, open, bump]);

  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function requestCombine() {
    const protocolIds = [...selected];
    if (protocolIds.length === 0) { notify(t('cmb.needProtocols'), true); return; }
    try {
      const r = await combine.createRequest(session, { title: title.trim() || undefined, protocolIds, playerId, deadline: deadline || undefined, instructions: instructions.trim() || undefined });
      if (r.requests.length === 0) { notify(t('cmb.notCreated'), true); return; }
      notify(t('cmb.requested'));
      setTitle(''); setDeadline(''); setInstructions('');
      setBump((b) => b + 1);
    } catch (e) { notify(wallMessage(e), true); }
  }

  return (
    <div className="section" aria-label={t('cmb.title')}>
      <h4>{t('cmb.title')} <button style={{ marginLeft: 8 }} onClick={() => setOpen((x) => !x)}>{open ? t('cmb.hide') : t('cmb.show')}</button></h4>
      {open && <div className="dim" style={{ fontSize: 12.5 }}>{t('cmb.tagline')} {t('cmb.poweredBy')}</div>}
      {open && err && <div className="notice block">{err}</div>}
      {open && (
        <>
          {/* Combine Verified results — results only, never footage */}
          <div style={{ marginTop: 8 }}>
            <h4 style={{ margin: '0 0 6px' }}>{t('cmb.results')}</h4>
            {player && player.shared ? (
              player.results.length > 0 ? (
                <div className="list-rows">
                  {player.results.map((r) => (
                    <div key={r.protocolId} className="list-row">
                      <span className="grow"><b>{r.protocolTitle}</b></span>
                      <span><b>{r.display}</b> <span className="dim">{r.metricUnit}</span></span>
                      {r.combineVerified && <span className="pill green">{t('cmb.verified')}</span>}
                    </div>
                  ))}
                </div>
              ) : <div className="dim">{t('cmb.noResults')}</div>
            ) : <div className="dim">{player?.note ?? t('cmb.notShared')}</div>}
            {player && player.shared && <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{player.note}</div>}
          </div>

          {/* Comparison — verified numbers only, blank (never 0), no ranking */}
          {compare && compare.rows.length > 0 && (
            <div style={{ marginTop: 10, overflowX: 'auto' }}>
              <h4 style={{ margin: '0 0 6px' }}>{t('cmb.compare')}</h4>
              <div style={{ overflowX: 'auto' }}>
                <table className="data">
                  <thead><tr><th>{t('cmb.player')}</th>{compare.protocols.map((p) => <th key={p.id}>{p.title} <span className="dim">({p.metricUnit})</span></th>)}</tr></thead>
                  <tbody>
                    {compare.rows.map((row) => (
                      <tr key={row.playerId}>
                        <td>{row.playerName}</td>
                        {row.cells.map((c, i) => <td key={i}>{c ? <>{c.display}{c.verified ? ' ✓' : ''}</> : <span className="dim">—</span>}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{compare.note}</div>
            </div>
          )}

          {/* Existing requests + completion */}
          <div style={{ marginTop: 10 }}>
            <h4 style={{ margin: '0 0 6px' }}>{t('cmb.requests')}</h4>
            {requests.length === 0 && <div className="dim">{t('cmb.noRequests')}</div>}
            <div className="list-rows">
              {requests.map((r) => (
                <div key={r.id} className="list-row" style={{ flexWrap: 'wrap' }}>
                  <span className="grow"><b>{r.title || t('cmb.title')}</b> <span className="dim">{r.protocols.map((p) => p.protocolTitle).join(', ')}{r.deadline ? ` · ${t('cmb.deadline')} ${r.deadline}` : ''}</span></span>
                  <span className={`pill ${r.state === 'completed' ? 'green' : r.completedCount > 0 ? 'gold' : ''}`}>{r.completedCount}/{r.requiredCount}</span>
                  {r.state !== 'completed' && r.state !== 'cancelled' && <button aria-label={`${t('cmb.cancel')} ${r.title ?? ''}`} onClick={async () => { try { await combine.cancelRequest(session, r.id); setBump((b) => b + 1); } catch (e) { notify(wallMessage(e), true); } }}>{t('cmb.cancel')}</button>}
                </div>
              ))}
            </div>
          </div>

          {/* Request a Club Combine — standardized protocols only */}
          <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <h4 style={{ margin: '0 0 6px' }}>{t('cmb.requestTitle')}</h4>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
              {STANDARD_PROTOCOLS.map((p) => (
                <label key={p.id} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13 }}>
                  <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label={p.title} />
                  {p.title}{!p.productionSupported && <span className="dim" title={t('cmb.notSupported')}> ⓘ</span>}
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input style={{ minWidth: 160 }} placeholder={t('cmb.titlePlaceholder')} value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t('cmb.titlePlaceholder')} />
              <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} aria-label={t('cmb.deadline')} />
              <input style={{ flex: 1, minWidth: 160 }} placeholder={t('cmb.instructions')} value={instructions} onChange={(e) => setInstructions(e.target.value)} aria-label={t('cmb.instructions')} />
              <button className="primary" onClick={requestCombine}>{t('cmb.requestBtn')}</button>
            </div>
            <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('cmb.notSupported')}</div>
            <div className="dim" style={{ fontSize: 12, marginTop: 2 }}>{t('cmb.requestNote')}</div>
          </div>
        </>
      )}
    </div>
  );
}
