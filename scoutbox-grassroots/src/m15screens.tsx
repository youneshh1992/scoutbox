// M15 org screens — the recruitment Football Passport.
// Everything rendered here is the SERVER's projection for this organisation:
// own-org assessments/trials only, provenance on every item, and honest
// wall messages when the standing gates refuse access (agency/minor wall,
// grassroots radius, blocks). A share link locates a passport; it never
// authorises — the same gates run again on resolution.
import { useEffect, useState } from 'react';
import { ApiError, type Session } from './api';
import { m15, shareTokenFrom, type FpEvent, type FpSummary, type RecruitmentPassport } from './m15api';
import { t } from './i18n';

const PROV_PILL: Record<string, string> = {
  verified_club_confirmed: 'green', authoritative_registry: 'green',
  verified_coach_confirmed: 'blue', scoutbox_reviewed: 'gold',
  player_submitted: '', guardian_submitted: '', system_recorded: '', historical_migration: '',
};
const PROV_KEY: Record<string, string> = {
  player_submitted: 'fp.provPlayer', guardian_submitted: 'fp.provGuardian',
  system_recorded: 'fp.provSystem', historical_migration: 'fp.provHistoric',
  scoutbox_reviewed: 'fp.provReviewed', verified_coach_confirmed: 'fp.provCoach',
  verified_club_confirmed: 'fp.provClub', authoritative_registry: 'fp.provRegistry',
};
export function ProvPill({ provenance, copy }: { provenance: string; copy?: string | null }) {
  return (
    <span className={`pill ${PROV_PILL[provenance] ?? ''}`} title={copy ?? undefined}>
      {t(PROV_KEY[provenance] ?? 'fp.provPlayer')}
    </span>
  );
}

function wallMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'UNDER_18_WALL') return t('fp.wallAgency');
    if (e.code === 'NOT_VISIBLE') return t('fp.wallNotVisible');
    if (e.code === 'PASSPORT_NOT_FOUND') return t('fp.wallShareDead');
    return e.message;
  }
  return e instanceof Error ? e.message : 'failed';
}

function eventLine(e: FpEvent): string {
  const org = (e.title as { org?: string }).org ?? e.org?.name ?? '';
  switch (e.type) {
    case 'club_joined': return `${t('fp.evJoined')} ${org}`;
    case 'club_left': return `${t('fp.evLeft')} ${org}`;
    case 'club_affiliation_verified': return `${t('fp.evAffVerified')} — ${org}`;
    case 'trial_attended': return `${t('fp.evTrial')} — ${org}`;
    case 'trial_outcome': return `${t('fp.evTrialOutcome')} — ${org}`;
    case 'assessment_completed': return `${t('fp.evAssessment')} — ${org}`;
    case 'reference_received': return `${t('fp.evReference')}${(e.title as { coach?: string }).coach ? ` — ${(e.title as { coach?: string }).coach}` : ''}`;
    case 'evidence_added': return `${t('fp.evEvidence')}: ${(e.title as { label?: string }).label ?? ''}`;
    case 'signed': return `${t('fp.evSigned')} ${org}`;
    case 'role_or_squad_changed': return `${t('fp.evRole')}${org ? ` — ${org}` : ''}`;
    case 'representation_started': return `${t('fp.evRepStart')} — ${org}`;
    case 'representation_ended': return `${t('fp.evRepEnd')} — ${org}`;
    case 'achievement': return `🏅 ${(e.title as { label?: string }).label ?? ''}`;
    case 'position_change': return `${t('fp.evPosition')}: ${(e.title as { primary?: string }).primary ?? ''}`;
    default: return e.type.replace(/_/g, ' ');
  }
}

/** Renders one recruitment passport body (drawer panel and share opener). */
export function PassportBody({ session, p, notify, reload }: { session: Session; p: RecruitmentPassport; notify: (text: string, error?: boolean) => void; reload?: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const events = showAll ? p.timeline : p.timeline.slice(0, 8);
  return (
    <>
      <div className="badges" style={{ marginBottom: 8 }}>
        {p.identity && <span className="pill outline-green" title={t('fp.identityCopy')}>{p.identity.label}</span>}
        {p.status.currentClub
          ? <span className={`pill ${PROV_PILL[p.status.currentClub.provenance] ?? ''}`}>{p.status.currentClub.orgName}{p.status.currentClub.since ? ` · ${t('fp.since')} ${p.status.currentClub.since}` : ''}</span>
          : <span className="pill">{t('fp.noClub')}</span>}
        {p.availability && <span className="pill blue">{p.availability.replace(/_/g, ' ')}</span>}
        {p.representation && <span className="pill gold">{t('fp.represented')}: {p.representation.agencyName}</span>}
      </div>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{p.note}</div>

      <div className="stat-grid" aria-label={t('fp.evidence')}>
        <div className="stat"><div className="v">{p.evidence.fullMatches}</div><div className="k">{t('fp.fullMatches')}</div></div>
        <div className="stat"><div className="v">{p.evidence.clips}</div><div className="k">{t('fp.clips')}</div></div>
        <div className="stat"><div className="v">{p.evidence.references}</div><div className="k">{t('fp.references')}</div></div>
        <div className="stat"><div className="v">{p.evidence.lastEvidenceDays ?? '—'}</div><div className="k">{t('fp.lastEvidence')}</div></div>
      </div>
      <div className="dim" style={{ fontSize: 12 }}>{p.evidence.note}</div>

      {p.clubHistory.length > 0 && (
        <div className="section">
          <h4>{t('fp.history')}</h4>
          <div className="list-rows">
            {p.clubHistory.map((r) => (
              <div key={`${r.orgName}-${r.from}`} className="list-row">
                <span className="grow">{r.orgName}{r.role ? ` · ${r.role}` : ''}</span>
                <span className="dim">{r.from ?? '—'} → {r.current ? t('fp.now') : r.to ?? '—'}</span>
                <ProvPill provenance={r.provenance} copy={r.provenanceCopy} />
              </div>
            ))}
          </div>
        </div>
      )}

      {(p.assessments.length > 0 || p.trials.length > 0) && (
        <div className="section">
          <h4>{t('fp.ownOrg')}</h4>
          <div className="dim" style={{ fontSize: 12.5, marginBottom: 6 }}>{t('fp.ownOrgNote')}</div>
          <div className="list-rows">
            {p.assessments.map((a) => (
              <div key={a.id} className="list-row"><span className="grow">{t('fp.assessment')} · {a.at ?? '—'}</span><span className="pill">{a.state}</span></div>
            ))}
            {p.trials.map((tr) => (
              <div key={tr.id} className="list-row"><span className="grow">{t('fp.trial')} · {tr.date ?? '—'}</span><span className="pill">{tr.hasReport ? t('fp.reportFiled') : t('fp.reportPending')}</span></div>
            ))}
          </div>
        </div>
      )}

      {p.references.length > 0 && (
        <div className="section">
          <h4>{t('fp.refTitle')}</h4>
          <div className="list-rows">
            {p.references.map((r) => (
              <div key={r.id} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span className="grow"><b>{r.coachName}</b> <span className="dim">{r.roleAtTime ?? ''} · {r.orgName}{r.fromYear ? ` · ${r.fromYear}–${r.toYear ?? ''}` : ''}</span></span>
                  <span className="pill blue" title={r.provenanceCopy}>{t('fp.provCoach')}</span>
                </div>
                {r.structured && <div className="dim" style={{ fontSize: 12.5 }}>“{r.structured.summary}”</div>}
                <div className="dim" style={{ fontSize: 11.5 }}>{r.provenanceCopy}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {p.achievements.length > 0 && (
        <div className="section">
          <h4>{t('fp.achievements')}</h4>
          <div className="list-rows">
            {p.achievements.map((a) => (
              <div key={a.id} className="list-row">
                <span className="grow">🏅 {a.title}{a.when ? ` (${a.when})` : ''}</span>
                <ProvPill provenance={a.provenance} copy={a.provenanceCopy} />
                {!a.confirmedBy && reload && (
                  <button aria-label={`${t('fp.confirm')} ${a.title}`} onClick={async () => {
                    try {
                      await m15.confirmAchievement(session, p.player.id, a.id);
                      notify(t('fp.confirmed'));
                      reload();
                    } catch (e) { notify(wallMessage(e), true); }
                  }}>{t('fp.confirm')}</button>
                )}
              </div>
            ))}
          </div>
          <div className="dim" style={{ fontSize: 12 }}>{t('fp.confirmNote')}</div>
        </div>
      )}

      <div className="section">
        <h4>{t('fp.timeline')}</h4>
        <div className="list-rows">
          {events.map((e) => (
            <div key={e.id} className="list-row">
              <span className="dim" style={{ minWidth: 84 }}>{e.when.display}</span>
              <span className="grow">{eventLine(e)}</span>
              <ProvPill provenance={e.provenance} copy={e.provenanceCopy} />
            </div>
          ))}
        </div>
        {p.timeline.length > 8 && (
          <button style={{ marginTop: 6 }} onClick={() => setShowAll((x) => !x)}>
            {showAll ? t('fp.less') : `${t('fp.more')} (${p.timeline.length})`}
          </button>
        )}
      </div>
    </>
  );
}

/** Drawer panel: loads this org's projection for one player. */
export function FootballPassportPanel({ session, playerId, notify }: { session: Session; playerId: string; notify: (text: string, error?: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [p, setP] = useState<RecruitmentPassport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setErr(null);
    m15.passport(session, playerId).then((x) => live && setP(x)).catch((e) => live && setErr(wallMessage(e)));
    return () => { live = false; };
  }, [session, playerId, open, bump]);
  return (
    <div className="section" aria-label={t('fp.title')}>
      <h4>
        🛂 {t('fp.title')}{' '}
        <button style={{ marginLeft: 8 }} onClick={() => setOpen((x) => !x)}>{open ? t('fp.hide') : t('fp.show')}</button>
      </h4>
      {open && err && <div className="notice block">{err}</div>}
      {open && !err && !p && <div className="dim">…</div>}
      {open && p && <PassportBody session={session} p={p} notify={notify} reload={() => setBump((b) => b + 1)} />}
    </div>
  );
}

/** Search-card chips from the batch summary endpoint (no N+1, no timelines). */
export function SummaryChips({ s }: { s: FpSummary | undefined }) {
  if (!s) return null;
  return (
    <>
      {s.currentClub?.name && (
        <span className={`pill ${PROV_PILL[s.currentClub.provenance] ?? ''}`} title={t(PROV_KEY[s.currentClub.provenance] ?? 'fp.provPlayer')}>
          {s.currentClub.name}
        </span>
      )}
      <span className={`pill ${s.evidenceCoverage === 'strong' ? 'green' : s.evidenceCoverage === 'moderate' ? 'blue' : ''}`}>
        {t('fp.coverage')}: {t(`fp.cov.${s.evidenceCoverage}`)}
      </span>
      {s.references > 0 && <span className="pill">{s.references} {t('fp.refsShort')}</span>}
    </>
  );
}

/** Batches passport summaries for a list of visible players. */
export function usePassportSummaries(session: Session, ids: string[]): Map<string, FpSummary> {
  const [map, setMap] = useState<Map<string, FpSummary>>(new Map());
  const key = ids.slice(0, 100).join(',');
  useEffect(() => {
    let live = true;
    if (!key) { setMap(new Map()); return; }
    m15.summaries(session, key.split(','))
      .then((items) => { if (live) setMap(new Map(items.map((i) => [i.playerId, i]))); })
      .catch(() => { /* summaries are progressive enhancement */ });
    return () => { live = false; };
  }, [session, key]);
  return map;
}

/** Opens a recruitment share link pasted by a scout. The server re-runs
 *  every visibility gate — the link locates, it never authorises. */
export function SharedPassportOpener({ session, notify }: { session: Session; notify: (text: string, error?: boolean) => void }) {
  const [input, setInput] = useState('');
  const [p, setP] = useState<RecruitmentPassport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="section" aria-label={t('fp.shareOpen')}>
      <h4>🔗 {t('fp.shareOpen')}</h4>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 6 }}>{t('fp.shareOpenNote')}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input style={{ flex: 1 }} placeholder={t('fp.sharePlaceholder')} value={input} onChange={(e) => setInput(e.target.value)} aria-label={t('fp.sharePlaceholder')} />
        <button className="primary" onClick={async () => {
          setErr(null); setP(null);
          try { setP(await m15.openShared(session, shareTokenFrom(input))); } catch (e) { setErr(wallMessage(e)); }
        }}>{t('fp.open')}</button>
        {p && <button onClick={() => { setP(null); setInput(''); }}>{t('fp.close')}</button>}
      </div>
      {err && <div className="notice block" style={{ marginTop: 8 }}>{err}</div>}
      {p && (
        <div style={{ marginTop: 10 }}>
          <h4>{p.player.name} <span className="dim">· {p.player.age}{p.player.position ? ` · ${p.player.position}` : ''}</span></h4>
          <PassportBody session={session} p={p} notify={notify} />
        </div>
      )}
    </div>
  );
}
