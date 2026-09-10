// M16.2 org screen — the Trust Profile panel in the player drawer.
//
// The Trust Score is EVIDENCE CONFIDENCE: how strongly this player's football
// record is supported by trustworthy, current, attributable evidence. It is
// not ability, potential, character or recruitment suitability, and a low
// score means limited evidence — nothing about the player themselves.
//
// The club projection is intentionally narrow: score, band, the safe component
// levels and the safe evidence signals. Component internals, evidence gaps and
// source records are not in the payload and are never rendered here. The score
// grants no access: every standing gate has already run server-side.
import { useEffect, useState } from 'react';
import { ApiError, type Session } from './api';
import { trust, type TrustClub } from './trustApi';
import { t } from './i18n';

// Component display names, keyed by the server's component ids.
const COMPONENT_KEYS: Record<string, string> = {
  identity: 'trs.compIdentity',
  footballHistory: 'trs.compFootballHistory',
  relationships: 'trs.compRelationships',
  evidence: 'trs.compEvidence',
  combine: 'trs.compCombine',
  references: 'trs.compReferences',
};
const componentLabel = (id: string) => (COMPONENT_KEYS[id] ? t(COMPONENT_KEYS[id]) : id);

function wallMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'NOT_VISIBLE') return t('trs.wallNotVisible');
    if (e.code === 'PLAYER_NOT_FOUND') return t('trs.wallNotVisible');
    return e.message;
  }
  return e instanceof Error ? e.message : 'failed';
}

export function TrustPanel({ session, playerId }: { session: Session; playerId: string }) {
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<TrustClub | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setErr(null);
    trust.player(session, playerId)
      .then((p) => { if (live) setProfile(p); })
      .catch((e) => { if (live) setErr(wallMessage(e)); });
    return () => { live = false; };
  }, [session, playerId, open]);

  const note = profile?.note || t('trs.note');

  return (
    <div className="section" aria-label="Trust Profile">
      <h4>
        {t('trs.title')}
        <button style={{ marginLeft: 8 }} onClick={() => setOpen((x) => !x)}>{open ? t('trs.hide') : t('trs.show')}</button>
      </h4>
      {open && err && <div className="notice block">{err}</div>}
      {open && !profile && !err && <div className="dim">{t('trs.loading')}</div>}
      {open && profile && (
        <>
          {/* Score + band + the mandatory disclaimer, always together. */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }} title={note}>
            <span style={{ fontSize: 30, fontWeight: 800 }}>{profile.score}</span>
            <span className="dim">/ 100</span>
            <span className="pill blue">{profile.bandLabel}</span>
            {profile.simulatedEvidenceIncluded && <span className="pill gold">{t('trs.demo')}</span>}
          </div>
          <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>{profile.disclaimer || t('trs.disclaimer')}</div>
          <div className="dim" style={{ fontSize: 12.5 }} title={note}>{note}</div>

          {/* Safe component levels — the level only, never the records behind it. */}
          <div style={{ marginTop: 10 }}>
            <h4 style={{ margin: '0 0 6px' }}>{t('trs.evidenceConfidence')}</h4>
            <div className="list-rows">
              {profile.explanations.map((e) => (
                <div key={e.component} className="list-row">
                  <span className="grow"><b>{componentLabel(e.component)}</b></span>
                  <span className="pill">{e.levelLabel}</span>
                  <span className="dim" style={{ fontSize: 12 }}>{t('trs.weight')} {e.weight}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Safe evidence signals. Anything absent is simply not listed — it is
              never rendered as a warning, a risk or a mark against the player. */}
          <div style={{ marginTop: 10 }}>
            <h4 style={{ margin: '0 0 6px' }}>{t('trs.signals')}</h4>
            {profile.signals.length > 0 ? (
              <div className="list-rows">
                {profile.signals.map((s, i) => (
                  <div key={`${s.code}-${i}`} className="list-row"><span className="grow">✓ {s.text}</span></div>
                ))}
              </div>
            ) : <div className="dim">{t('trs.noSignals')}</div>}
          </div>

          <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('trs.policy')} {profile.policyVersion} · {t('trs.noRanking')}</div>
        </>
      )}
    </div>
  );
}
