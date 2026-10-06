// Grassroots Clubhouse — Home with live club facts.
//
// Hierarchy: a welcome, one primary action, a row of
// counts, Needs your attention, Club progress, Recent activity, Quick
// actions. Every number is read from the workspace's own endpoints
// (shortlist, requests, trials, squad, feed); nothing is estimated, no
// percentage is invented, and a count the server refuses is simply absent.
import { useEffect, useState } from 'react';
import { initials } from '../../design-system/text';
import { Icon } from '../../design-system/icons';
import { api, type FeedItem, type OrgRequest, type Player, type Session, type Squad, type Trial } from './api';
import { fmtDate, t } from './i18n';
import { NeedsAttention } from './navui';
import type { ScreenId } from './App';

const FEED_LABELS: Record<FeedItem['type'], string> = {
  new_player: 'New on ScoutBox',
  new_clip: 'New footage',
  shortlist_new_clip: 'Your shortlist posted',
  report_due: 'Report due',
};

interface Facts {
  shortlist: Player[] | null;
  requests: OrgRequest[] | null;
  trials: Trial[] | null;
  squad: Squad | null;
  feed: FeedItem[] | null;
  verRequests: number | null;
}

function AgencyWall({ session }: { session: Session }) {
  if (session.org.type !== 'agency') return null;
  return (
    <div className="wall">
      <b>The under-18 wall is active for this account.</b>
      <p>
        Under-18 players are on ScoutBox now — and agency accounts can never list, view or contact
        any of them. The API refuses on every endpoint, regardless of what this interface asks for.
        Under-18 representation rules apply: no agent access, no exceptions.
      </p>
    </div>
  );
}

export function HomeScreen({ session, tick, openPlayer, unreadMessages, verLevel, onNavigate }: {
  session: Session; tick: number; openPlayer: (id: string) => void;
  unreadMessages: number; verLevel: string | null; onNavigate: (id: ScreenId) => void;
}) {
  const [activityFilter, setActivityFilter] = useState<'all' | 'footage' | 'players' | 'reports'>('all');
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [facts, setFacts] = useState<Facts | null>(null);
  useEffect(() => {
    let gone = false;
    const settle = <T,>(p: Promise<T>) => p.then((v) => v as T | null).catch(() => null);
    Promise.all([
      settle(api.getShortlist(session)), settle(api.getRequests(session)), settle(api.getTrials(session)),
      settle(api.getSquad(session)), settle(api.getFeed(session)),
    ]).then(([shortlist, requests, trials, squad, feed]) => {
      if (!gone) setFacts({ shortlist, requests, trials, squad, feed, verRequests: null });
    });
    return () => { gone = true; };
  }, [session, tick]);

  if (facts === null) {
    return <div className="list-rows" aria-busy="true">{[1, 2, 3, 4].map((i) => <div key={i} className="list-row skeleton" style={{ height: 48 }} />)}</div>;
  }

  const pendingRequests = facts.requests?.filter((r) => r.status === 'pending').length ?? null;
  const awaitingReport = facts.trials?.filter((x) => x.status === 'awaiting_report').length ?? null;
  const shortlisted = facts.shortlist?.length ?? null;
  const squadSize = facts.squad?.entries.length ?? null;
  const org = session.org;
  const firstName = session.scoutName.trim().split(/\s+/)[0] || session.scoutName;

  // ONE primary action — the first that applies.
  const primary: { label: string; target: ScreenId; why: string } =
    awaitingReport ? { label: t('home.fileReport'), target: 'trials', why: t('home.fileReportWhy').replace('{n}', String(awaitingReport)) }
      : unreadMessages > 0 ? { label: t('home.openInbox'), target: 'messages', why: t('home.openInboxWhy').replace('{n}', String(unreadMessages)) }
        : !org.verified ? { label: t('home.completeVerification'), target: 'verification', why: t('home.completeVerificationWhy') }
          : { label: t('home.findPlayers'), target: 'search', why: t('home.findPlayersWhy') };

  const summary: { key: string; n: number; label: string; target: ScreenId }[] = [];
  if (shortlisted !== null) summary.push({ key: 'shortlist', n: shortlisted, label: t('home.sumShortlisted'), target: 'shortlist' });
  if (pendingRequests !== null) summary.push({ key: 'requests', n: pendingRequests, label: t('home.sumRequests'), target: 'requests' });
  if (awaitingReport !== null) summary.push({ key: 'trials', n: awaitingReport, label: t('home.sumTrials'), target: 'trials' });
  if (squadSize !== null) summary.push({ key: 'squad', n: squadSize, label: t('home.sumSquad'), target: 'squad' });

  // Club progress — facts the club can act on, each with its honest state word.
  const progress: { key: string; label: string; state: string; done: boolean; target: ScreenId }[] = [
    { key: 'verified', label: t('home.progVerification'), state: org.verified ? t('home.stateVerified') : t('home.statePending'), done: org.verified, target: 'verification' },
    { key: 'safeguarding', label: t('home.progSafeguarding'), state: org.safeguardingCertified ? t('home.stateHeld') : t('home.stateNotHeld'), done: !!org.safeguardingCertified, target: 'verification' },
    { key: 'domain', label: t('home.progDomain'), state: org.emailDomainVerified ? (org.emailDomain ?? t('home.stateProven')) : t('home.stateNotYet'), done: !!org.emailDomainVerified, target: 'verification' },
    { key: 'lookingFor', label: t('home.progLookingFor'), state: org.lookingFor?.length ? org.lookingFor.join(' · ') : t('home.stateNotSet'), done: !!org.lookingFor?.length, target: 'squad' },
  ];
  if (facts.squad) progress.push({ key: 'coverage', label: t('home.progCoverage'), state: facts.squad.gaps.length ? `${t('home.stateThin')} ${facts.squad.gaps.join(', ')}` : t('home.stateCovered'), done: facts.squad.gaps.length === 0, target: 'squad' });

  const feed = facts.feed ?? [];
  const activityGroups = [
    { id: 'all' as const, label: t('desk.all'), items: feed },
    { id: 'footage' as const, label: t('desk.footage'), items: feed.filter(x => x.type === 'new_clip' || x.type === 'shortlist_new_clip') },
    { id: 'players' as const, label: t('desk.newPlayers'), items: feed.filter(x => x.type === 'new_player') },
    { id: 'reports' as const, label: t('desk.reports'), items: feed.filter(x => x.type === 'report_due') },
  ];
  const filteredActivity = activityGroups.find(x => x.id === activityFilter)!.items;
  const visibleActivity = showAllActivity ? filteredActivity : filteredActivity.slice(0, 8);
  const quick: { label: string; target: ScreenId }[] = [
    { label: t('home.quickSearch'), target: 'search' }, { label: t('home.quickOpenDays'), target: 'opendays' },
    { label: t('home.quickSquad'), target: 'squad' }, { label: t('home.quickShortlist'), target: 'shortlist' },
  ];

  return (
    <div className="home" data-testid="grass-home">
      <AgencyWall session={session} />
      <div className="club-welcome">
        <div><span className="club-eyebrow">{t('home.clubhouse')}</span><p className="home-welcome" data-testid="home-welcome">{t('home.welcome').replace('{name}', firstName)}</p></div>
        <span className="club-identity"><Icon name="map-pin" size={15} />{org.name}<span className="club-role">{session.role}</span></span>
      </div>
      <section className="club-hero" aria-labelledby="club-hero-title">
        <div className="club-hero-copy"><span className="club-eyebrow">{t('home.localGame')}</span>
          <h2 id="club-hero-title">{t('home.localRoots')}<br /><span>{t('home.bigAmbitions')}</span></h2>
        </div>
        <div className="home-primary" data-testid="home-primary"><p>{primary.why}</p><button className="primary" onClick={() => onNavigate(primary.target)}>{primary.label}<Icon name="arrow-right" size={18} /></button></div>
      </section>
      {summary.length > 0 && (
        <div className="home-summary" data-testid="home-summary" role="list">
          {summary.map((s) => (
            <div key={s.key} role="listitem"><button className="home-sum" onClick={() => onNavigate(s.target)}>
              <span className="home-sum-top"><Icon name={({ shortlist: 'list-checks', requests: 'mail', trials: 'clipboard', squad: 'users' } as Record<string, string>)[s.key]} size={19} /><Icon name="arrow-up-right" size={15} /></span><b>{s.n}</b><span>{s.label}</span>
            </button></div>
          ))}
        </div>
      )}
      <div className="desk-lower">
      <NeedsAttention session={session} tick={tick} unreadMessages={unreadMessages} verLevel={verLevel} onNavigate={onNavigate} />
      <div className="club-dashboard desk-dashboard">
      <div className="club-main-column">
      <section className="home-section desk-activity" aria-labelledby="home-activity-title" data-testid="home-activity">
        <div className="desk-panel-heading"><div><span className="club-eyebrow">{t('desk.scouting')}</span><h3 id="home-activity-title">{t('desk.activity')}</h3></div><Icon name="activity" size={20} /></div>
        <div className="desk-feed-filters" role="group" aria-label={t('desk.filterActivity')}>
          {activityGroups.map(g => <button key={g.id} aria-pressed={activityFilter === g.id} onClick={() => { setActivityFilter(g.id); setShowAllActivity(false); }}>{g.label}<span>{g.items.length}</span></button>)}
        </div>
        <div className="desk-feed-columns" aria-hidden="true"><span>{t('desk.player')}</span><span>{t('desk.update')}</span><span>{t('desk.logged')}</span><span /></div>
        <div className="desk-feed-records" aria-live="polite">
          {visibleActivity.map((it, i) => (
            <button key={`${it.playerId}-${it.type}-${it.ts}-${i}`} className="desk-feed-record" onClick={() => openPlayer(it.playerId)}>
              <span className="desk-feed-person"><span className="club-feed-avatar" aria-hidden="true">{initials(it.playerName)}</span><b>{it.playerName}</b></span>
              <span className="desk-feed-update"><span className={`desk-event-kind ${it.type === 'report_due' ? 'urgent' : ''}`}><Icon name={it.type === 'new_player' ? 'user-plus' : it.type === 'report_due' ? 'clipboard' : 'video'} size={13} />{FEED_LABELS[it.type]}</span>
                {it.type === 'new_player' && <span className="desk-feed-detail">{it.position} · {it.age}{it.guardianManaged ? ' · U18 (guardian-managed)' : ''}</span>}
                {(it.type === 'new_clip' || it.type === 'shortlist_new_clip') && <><span className="desk-feed-detail">{it.title}</span><span className="desk-feed-evidence">{it.verifiedClip && <span><Icon name="badge-check" size={12} />Verified Clip</span>}{it.hasVideo && <span>Playable</span>}</span></>}
                {it.type === 'report_due' && <span className="desk-feed-detail">Mandatory report · due {it.dueAt ? fmtDate(it.dueAt) : 'soon'}</span>}
              </span>
              <span className="desk-feed-date">{fmtDate(it.ts)}</span><Icon name="arrow-up-right" size={16} />
            </button>
          ))}
          {filteredActivity.length === 0 && <p className="desk-empty">{t('desk.noActivity')}</p>}
        </div>
        {filteredActivity.length > 8 && <button className="desk-show-more" onClick={() => setShowAllActivity(!showAllActivity)}>{showAllActivity ? t('desk.showLess') : t('desk.showAll')}</button>}
      </section>
      </div>
      <aside className="club-side-column">
      <section className="home-section desk-readiness" aria-labelledby="home-progress-title" data-testid="home-progress">
        <div className="desk-panel-heading"><div><span className="club-eyebrow">{t('desk.operations')}</span><h3 id="home-progress-title">{t('desk.readiness')}</h3></div><Icon name="shield-check" size={20} /></div>
        <div className="list-rows">
          {progress.map((p) => (
            <button key={p.key} className="list-row home-row desk-readiness-row" onClick={() => onNavigate(p.target)}>
              <span className={`home-state ${p.done ? 'done' : ''}`} aria-hidden="true"><Icon name={p.done ? 'check' : 'chevron-right'} size={12} /></span>
              <span className="grow">{p.label}</span>
              <span className={p.done ? 'home-ok' : 'dim'}>{p.state}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="home-section desk-tools" aria-labelledby="home-quick-title" data-testid="home-quick">
        <div className="desk-panel-heading"><h3 id="home-quick-title">{t('desk.tools')}</h3><Icon name="compass" size={20} /></div>
        <div className="home-quick">
          {quick.map((q) => <button key={q.target} className="f-textbtn" onClick={() => onNavigate(q.target)}><Icon name={({ search: 'search', opendays: 'calendar-days', squad: 'users', shortlist: 'list-checks' } as Record<string, string>)[q.target]} size={18} /><span>{q.label}</span><Icon name="arrow-up-right" size={14} /></button>)}
        </div>
      </section>
      </aside></div></div>
    </div>
  );
}
