// M24F.2 — the Grassroots Home, recomposed.
//
// Hierarchy (§36): a welcome line, ONE primary action, a small row of
// counts, Needs your attention, Club progress, Recent activity, Quick
// actions. Every number is read from the workspace's own endpoints
// (shortlist, requests, trials, squad, feed); nothing is estimated, no
// percentage is invented, and a count the server refuses is simply absent.
import { useEffect, useState } from 'react';
import { Icon } from '../../design-system/icons';
import { api, type FeedItem, type OrgRequest, type Player, type Session, type Squad, type Trial } from './api';
import { pressable } from './dialog';
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
  const quick: { label: string; target: ScreenId }[] = [
    { label: t('home.quickSearch'), target: 'search' }, { label: t('home.quickOpenDays'), target: 'opendays' },
    { label: t('home.quickSquad'), target: 'squad' }, { label: t('home.quickShortlist'), target: 'shortlist' },
  ];

  return (
    <div className="home" data-testid="grass-home">
      <AgencyWall session={session} />
      <p className="home-welcome" data-testid="home-welcome">{t('home.welcome').replace('{name}', firstName)} <span className="dim">{org.name} · {session.role}</span></p>
      <div className="home-primary" data-testid="home-primary">
        <button className="primary" onClick={() => onNavigate(primary.target)}>{primary.label}</button>
        <span className="dim">{primary.why}</span>
      </div>
      {summary.length > 0 && (
        <div className="home-summary" data-testid="home-summary" role="list">
          {summary.map((s) => (
            <button key={s.key} role="listitem" className="home-sum" onClick={() => onNavigate(s.target)}>
              <b>{s.n}</b><span>{s.label}</span>
            </button>
          ))}
        </div>
      )}
      <NeedsAttention session={session} tick={tick} unreadMessages={unreadMessages} verLevel={verLevel} onNavigate={onNavigate} />
      <section className="home-section" aria-labelledby="home-progress-title" data-testid="home-progress">
        <div className="attn-title" id="home-progress-title">{t('home.progressTitle')}</div>
        <div className="list-rows">
          {progress.map((p) => (
            <button key={p.key} className="list-row home-row" onClick={() => onNavigate(p.target)}>
              <span className={`home-state ${p.done ? 'done' : ''}`} aria-hidden="true"><Icon name={p.done ? 'check' : 'chevron-right'} size={12} /></span>
              <span className="grow">{p.label}</span>
              <span className={p.done ? 'home-ok' : 'dim'}>{p.state}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="home-section" aria-labelledby="home-activity-title" data-testid="home-activity">
        <div className="attn-title" id="home-activity-title">{t('home.activityTitle')}</div>
        {feed.length === 0 && <div className="notice">{t('home.quiet')}</div>}
        <div className="list-rows">
          {feed.slice(0, 8).map((it, i) => (
            <div key={i} className="list-row home-row" style={{ cursor: 'pointer' }} {...pressable(() => openPlayer(it.playerId))}>
              <span className={`feed-kind ${it.type === 'report_due' ? 'urgent' : ''}`}>{FEED_LABELS[it.type]}</span>
              <span className="grow">
                <b>{it.playerName}</b>
                {it.type === 'new_player' && <span className="dim"> — {it.position}, {it.age}{it.guardianManaged ? ' · U18 (guardian-managed)' : ''}</span>}
                {(it.type === 'new_clip' || it.type === 'shortlist_new_clip') && (
                  <span className="dim"> — “{it.title}”{it.verifiedClip ? ' · Verified Clip' : ''}{it.hasVideo ? ' · Playable' : ''}</span>
                )}
                {it.type === 'report_due' && <span className="dim"> — mandatory trial report due {it.dueAt ? fmtDate(it.dueAt) : 'soon'}</span>}
              </span>
              <span className="dim">{fmtDate(it.ts)}</span>
            </div>
          ))}
        </div>
        {feed.length > 8 && <p className="dim home-more">{t('home.more').replace('{n}', String(feed.length - 8))}</p>}
      </section>
      <section className="home-section" aria-labelledby="home-quick-title" data-testid="home-quick">
        <div className="attn-title" id="home-quick-title">{t('home.quickTitle')}</div>
        <div className="home-quick">
          {quick.map((q) => <button key={q.target} className="f-textbtn" onClick={() => onNavigate(q.target)}>{q.label}<Icon name="arrow-right" size={12} /></button>)}
        </div>
      </section>
    </div>
  );
}
