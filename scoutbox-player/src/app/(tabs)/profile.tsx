// Profile — M24F.1. Important information first, secondary information in
// separate sections. The page is the player: a plain avatar, the name as
// the strongest element, position · place, the availability word, Verified,
// View Passport. Then four local sections — Overview, Performance, Evidence,
// Journey — deep-linked by `?section=` (the same `?tab=`-style parameter the
// other Player pages use, so back / forward and links keep working).
//
// Overview shows ONE current action (the server's next action, a pending
// request, a scheduled trial, or the account handover — in that order, never
// two), four or five essentials, and four recent activities. Everything else
// the old profile showed is one tap away in its section, or in You › Account
// when it is a control. Every value is read from the session and the client
// calls the previous profile, Home and Football already made — nothing is
// invented (see M24F_PLAYER_PROFILE_DATA_MAP.md).
import { createElement, useCallback, useEffect, useMemo, useState } from 'react';
import { Image, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { Text, TextInput } from '../../components/Text';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { client, type PlayerCV, type Benchmarks, type PlayerFeedItem } from '../../data/client';
import { m12, type FamilyTrial, type PlayerJourney, type PlayerNextActionCode } from '../../data/m12client';
import { m15 } from '../../data/m15client';
import { AVAILABILITY_LABELS, CONTRACT_LABELS, type Availability, type ContractStatus, type InboxRequest } from '../../domain/types';
import { useSession } from '../../state';
import { useColors, useStyles, type Palette } from '../../theme';
import { pt } from '../../i18n';
import { Button, Disclosure, Kicker, ListRow, Muted, Row, SectionTitle } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { combine } from '../../data/combineClient';
import { PageHeader, PageTabs, pickTab } from '../../components/PageChrome';
import { WebVideo } from '../../components/WebVideo';
import { PassportSection } from '../../components/M12Sections';
import { CATEGORY_FOR_ACTION } from '../../components/M23Journey';
import { initialsOf, TextButton } from '../../components/Reference';
import { humanDate, uiLocale } from '../../time';

type SectionKey = 'overview' | 'performance' | 'evidence' | 'journey';
const SECTION_KEYS: SectionKey[] = ['overview', 'performance', 'evidence', 'journey'];

const EVENT_LABELS: Record<string, string> = {
  view: 'viewed your profile',
  save: 'saved you',
  shortlist: 'shortlisted you',
  contact_request: 'requested contact',
  trial_request: 'requested a trial',
  contact_request_to_guardian: 'contacted your guardian',
  trial_request_to_guardian: 'sent your guardian a trial invite',
};
const evLabel = (kind: string) => { const key = `jnEv_${kind}` as Parameters<typeof pt>[0]; try { return pt(key) ?? kind.replace(/_/g, ' '); } catch { return kind.replace(/_/g, ' '); } };
const stLabel = (s: string) => { const key = `jnSt_${s}` as Parameters<typeof pt>[0]; try { return pt(key) ?? s; } catch { return s; } };
const nextLabel = (code: string) => { const key = `jnNext_${code}` as Parameters<typeof pt>[0]; try { return pt(key) ?? ''; } catch { return ''; } };
const cap = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);
const dayLabel = (ts: number) => new Date(ts).toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short' }).toUpperCase();
const when = (ts: number) => {
  const d = new Date(ts); const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(uiLocale(), { weekday: 'short' });
  return d.toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short' });
};
const dateOnly = (iso: string) => new Date(iso).toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short', year: 'numeric', ...(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? { timeZone: 'UTC' } : {}) });
const sessionLine = (startsAt: number, venue?: string | null) => `${new Date(startsAt).toLocaleDateString(uiLocale(), { day: 'numeric', month: 'long' })} · ${new Date(startsAt).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' })}${venue ? ` · ${venue}` : ''}`;

const isRequest = (r: unknown): r is InboxRequest => !!r && typeof r === 'object' && 'createdAt' in (r as object) && 'orgName' in (r as object);
const upcomingSession = (t: FamilyTrial | undefined) => {
  const wf = t?.workflow;
  if (!wf || !('schedule' in wf) || !wf.schedule) return null;
  return wf.schedule.sessions.find((s) => s.startsAt >= Date.now() - 3600e3) ?? wf.schedule.sessions[0] ?? null;
};

/** The Explore page a next-action code opens (M24B categories and their first useful page). */
const ROUTE_FOR_ACTION: Record<PlayerNextActionCode, { cta: string; tab: string } | null> = {
  RESPOND_TO_CONTACT: { cta: 'View request', tab: 'requests' },
  RESPOND_TO_TRIAL_INVITATION: { cta: 'View trial', tab: 'invitation' },
  CONFIRM_TRIAL_SCHEDULE: { cta: 'View trial', tab: 'schedule' },
  RESPOND_TO_OFFER: { cta: 'View offer', tab: 'offer-terms' },
  SIGN: { cta: 'View signing', tab: 'signing-status' },
  NONE: null,
};

/**
 * The Profile route stays (`/profile?section=…` deep links and the back
 * control still work); its body is also the first page tab of You.
 */
export default function Profile() {
  const styles = useStyles(makeStyles);
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <PageHeader title={pt('tabProfile')} back />
        <ProfileBody />
      </ScrollView>
    </SafeAreaView>
  );
}

export function ProfileBody() {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const { playerId, me, isMinor, refresh, inbox, notifications } = useSession();
  const params = useLocalSearchParams<{ section?: string }>();
  const SECTIONS = useMemo(() => [
    { key: 'overview', label: pt('profOverview') },
    { key: 'performance', label: pt('profPerformance') },
    { key: 'evidence', label: pt('profEvidence') },
    { key: 'journey', label: pt('profJourney') },
  ], []);
  // the section is derived: the URL's `?section=` when it names one, else the last tap — no effect, no cascading render
  const [chosen, setChosen] = useState<SectionKey | null>(null);
  const fromParams = params.section && SECTION_KEYS.includes(pickTab(SECTIONS, params.section) as SectionKey) && params.section === pickTab(SECTIONS, params.section) ? (params.section as SectionKey) : null;
  const section: SectionKey = chosen ?? fromParams ?? 'overview';
  const go = (k: string) => {
    const key = SECTION_KEYS.includes(k as SectionKey) ? (k as SectionKey) : 'overview';
    setChosen(key);
    try { router.setParams({ section: key }); } catch { /* the parameter is a convenience for links; the state is already set */ }
  };
  // a new deep link wins over an earlier tap
  const [seenParam, setSeenParam] = useState(params.section);
  if (params.section !== seenParam) { setSeenParam(params.section); if (fromParams) setChosen(fromParams); }

  const [journeys, setJourneys] = useState<PlayerJourney[] | null>(null);
  const [trials, setTrials] = useState<FamilyTrial[]>([]);
  const [feed, setFeed] = useState<PlayerFeedItem[]>([]);
  const [currentClub, setCurrentClub] = useState<string | null>(null);
  const [benchmarks, setBenchmarks] = useState<Benchmarks | null>(null);
  const [tick, setTick] = useState(0);
  useFocusEffect(useCallback(() => { setTick((x) => x + 1); }, []));
  useEffect(() => {
    if (!playerId) return;
    let on = true;
    m12.getJourneys(playerId).then((x) => on && setJourneys(x)).catch(() => on && setJourneys([]));
    m12.getTrials(playerId).then((x) => on && setTrials(x)).catch(() => on && setTrials([]));
    client.getFeed(playerId).then((x) => on && setFeed(x)).catch(() => {});
    m15.passport({ kind: 'player', id: playerId }).then((p) => on && setCurrentClub(p.status.currentClub?.orgName ?? null)).catch(() => {});
    return () => { on = false; };
  }, [playerId, tick, notifications]);
  useEffect(() => {
    if (playerId && me?.pathway) client.getBenchmarks(playerId).then(setBenchmarks).catch(() => setBenchmarks(null));
  }, [playerId, me?.pathway]);

  if (!playerId) return null;
  if (!me) return <ProfileLoading onRetry={() => void refresh()} />;

  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await refresh(); } catch { /* surfaced through unrefreshed UI */ } };
  const availability = pt(`avail_${me.availability}` as Parameters<typeof pt>[0]);
  const place = isMinor ? me.country : (me.city || me.country);
  const summary = [me.position ?? pt('fbNoPosition'), place].filter(Boolean).join(' · ');

  // ---- ONE current action, in priority order; never two.
  type Next = { club: string | null; title: string; line?: string | null; cta: string; onPress: () => void };
  const next: Next | null = (() => {
    const j = (journeys ?? []).find((x) => x.journey.nextAction.code !== 'NONE');
    if (j) {
      const route = ROUTE_FOR_ACTION[j.journey.nextAction.code];
      const cat = CATEGORY_FOR_ACTION[j.journey.nextAction.code];
      const session = upcomingSession(trials.find((t) => t.orgName === j.club.name));
      const invite = inbox.filter(isRequest).find((r) => r.status === 'pending' && r.orgName === j.club.name && r.type === 'trial');
      const line = session ? sessionLine(session.startsAt, session.venue?.name) : invite?.trialDetails?.proposedDate ? `${invite.trialDetails.proposedDate}${invite.trialDetails.venue ? ` · ${invite.trialDetails.venue}` : ''}` : null;
      return { club: j.club.name, title: stLabel(j.journey.stage), line: line ?? nextLabel(j.journey.nextAction.code), cta: route?.cta ?? 'View', onPress: () => router.push(cat ? `/opportunities?cat=${cat}&tab=${route?.tab ?? ''}` : '/opportunities') };
    }
    const pending = inbox.filter(isRequest).filter((r) => r.status === 'pending').sort((a, b) => (a.type === b.type ? b.createdAt - a.createdAt : a.type === 'trial' ? -1 : 1))[0];
    if (pending) {
      const d = pending.trialDetails;
      return { club: pending.orgName, title: pending.type === 'trial' ? 'Trial invitation' : 'Contact request', line: d?.proposedDate ? `${d.proposedDate}${d.venue ? ` · ${d.venue}` : ''}` : pending.subject ?? null, cta: pending.type === 'trial' ? 'View invitation' : 'View request', onPress: () => router.push('/inbox') };
    }
    const scheduled = (journeys ?? []).find((x) => x.journey.stage === 'trial_scheduled');
    if (scheduled) {
      const session = upcomingSession(trials.find((t) => t.orgName === scheduled.club.name));
      return { club: scheduled.club.name, title: stLabel('trial_scheduled'), line: session ? sessionLine(session.startsAt, session.venue?.name) : null, cta: 'View trial', onPress: () => router.push('/opportunities?cat=trial&tab=schedule') };
    }
    if (me.agingUp?.eligible) {
      return { club: null, title: 'Your account can become fully yours', line: 'You are 18: completing the handover moves availability, medical sharing and club contact to you. Your history stays as it is.', cta: 'Complete the handover', onPress: () => void act(() => client.agingUpComplete(playerId)) };
    }
    return null;
  })();

  // ---- recent activity: the scouting feed and the journeys' events, newest first, four at most.
  const activity = [
    ...feed.filter((i): i is Extract<PlayerFeedItem, { type: 'scouting_event' }> => i.type === 'scouting_event').map((i) => ({ ts: i.ts, text: `${i.orgName} ${EVENT_LABELS[i.eventType] ?? i.eventType.replace(/_/g, ' ')}` })),
    ...(journeys ?? []).flatMap((j) => j.journey.timeline.map((e) => ({ ts: e.at, text: `${j.club.name ?? pt('jnClub')} · ${cap(evLabel(e.kind))}` }))),
  ].sort((a, b) => b.ts - a.ts).slice(0, 4);

  const essentials: [string, string][] = [];
  essentials.push(['Age', String(me.age)]);
  if (me.position) essentials.push(['Position', me.position]);
  if (me.foot) essentials.push(['Preferred foot', cap(me.foot)]);
  if (place) essentials.push(['Location', isMinor ? me.country : [me.city, me.country].filter(Boolean).join(', ')]);
  if (currentClub) essentials.push(['Current club', currentClub]);

  return (
    <>
      {/* ---- identity: the subject of the page, not a record on it */}
      <View style={styles.header} testID="profile-header">
        <Avatar name={me.name} />
        <Text role="heading" aria-level={1} style={styles.name} testID="profile-name">{me.name}</Text>
        <Text style={styles.summary} testID="profile-line">{summary}</Text>
        <Text style={styles.availability} testID="profile-availability">{availability}</Text>
        <View style={styles.headerRow}>
          <View style={styles.verified} testID="profile-verified" accessibilityLabel={me.identityVerified ? 'Identity verified' : 'Identity not verified'}>
            <View style={[styles.marker, !me.identityVerified && { backgroundColor: colors.line }]} />
            <Text style={[styles.verifiedText, !me.identityVerified && { color: colors.muted }]}>{me.identityVerified ? 'Verified' : 'Not verified'}</Text>
            {isMinor ? <Text style={styles.quietWord}>· Guardian-managed</Text> : null}
          </View>
          <TextButton label={pt('profViewPassport')} onPress={() => router.push('/football?tab=passport')} testID="profile-passport-link" size={13} />
        </View>
      </View>

      <View testID="profile-tabs">
        <PageTabs tabs={SECTIONS} value={section} onChange={go} />
      </View>

      {section === 'overview' && (
        <View testID="profile-section-overview" style={styles.body}>
          {/* ONE current action — a subtle contained surface, the only object on the page */}
          {next ? (
            <View style={styles.next} testID="profile-next">
              <Kicker tone="accent">{pt('profNext')}</Kicker>
              {next.club ? <Text style={styles.nextClub}>{next.club}</Text> : null}
              <Text style={[styles.nextTitle, !next.club && { fontSize: 17 }]}>{next.title}</Text>
              {next.line ? <Text style={styles.nextLine}>{next.line}</Text> : null}
              <View style={{ marginTop: 10, alignSelf: 'flex-start' }}>
                <Button primary small label={next.cta} onPress={next.onPress} testID="profile-next-cta" />
              </View>
            </View>
          ) : (
            <View style={styles.calm} testID="profile-up-to-date">
              <Text style={styles.calmText}>{pt('profUpToDate')}</Text>
            </View>
          )}

          {/* essentials — a short list, no box, no icon, no pill */}
          <View style={styles.block} testID="profile-essentials">
            {essentials.map(([k, v]) => (
              <View key={k} style={styles.fact}>
                <Text style={styles.factKey}>{k}</Text>
                <Text style={styles.factValue}>{v}</Text>
              </View>
            ))}
          </View>

          {/* recent activity — a short preview; the fuller timeline is Journey */}
          <View style={styles.block} testID="profile-activity">
            <SectionTitle>{pt('profRecentActivity')}</SectionTitle>
            {activity.length === 0 ? <Muted size={13.5}>{pt('profNoActivity')}</Muted> : activity.map((a, i) => (
              <View key={`${a.ts}-${i}`} style={styles.activityRow}>
                <Text style={styles.activityText}>{a.text}</Text>
                <Text style={styles.activityWhen}>{when(a.ts)}</Text>
              </View>
            ))}
            <TextButton label={pt('profViewActivity')} onPress={() => router.push('/opportunities?cat=journey&tab=activity')} testID="profile-activity-link" size={13} />
          </View>
        </View>
      )}

      {section === 'performance' && (
        <View testID="profile-section-performance" style={styles.body}>
          <PerformanceSection me={me} benchmarks={benchmarks} onCombine={() => router.push('/football?tab=combine')} />
        </View>
      )}

      {section === 'evidence' && (
        <View testID="profile-section-evidence" style={styles.body}>
          <EvidenceSection me={me} playerId={playerId} isMinor={isMinor} refresh={refresh} onUpload={() => router.push('/upload')} onBoxCam={() => router.push('/football?tab=boxcam')} onCombine={() => router.push('/football?tab=combine')} />
        </View>
      )}

      {section === 'journey' && (
        <View testID="profile-section-journey" style={styles.body}>
          <JourneyTimeline journeys={journeys ?? []} requests={inbox.filter(isRequest)} earlier={me.timeline} onExplore={() => router.push('/opportunities?cat=journey&tab=activity')} />
        </View>
      )}
    </>
  );
}

/**
 * Loading: the composition's own shapes — an avatar disc, a name bar, a line —
 * never a grid of grey cards. After a few seconds without a profile the same
 * place says so and offers a retry; a phone is never left blank.
 */
function ProfileLoading({ onRetry }: { onRetry: () => void }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const [slow, setSlow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSlow(true), 6000); return () => clearTimeout(t); }, []);
  if (slow) {
    return (
      <View style={styles.header} testID="profile-error">
        <Text style={styles.calmText}>Your profile could not be loaded.</Text>
        <Muted size={13.5}>Check your connection and try again.</Muted>
        <View style={{ marginTop: 10, alignSelf: 'flex-start' }}><Button small primary label="Retry" onPress={onRetry} /></View>
      </View>
    );
  }
  return (
    <View style={styles.header} testID="profile-loading" accessibilityLabel="Loading your profile" accessible>
      <View style={[styles.avatar, { backgroundColor: colors.panel2 }]} />
      <View style={{ width: '62%', height: 24, borderRadius: 6, backgroundColor: colors.panel2, marginTop: 4 }} />
      <View style={{ width: '40%', height: 14, borderRadius: 6, backgroundColor: colors.panel2, marginTop: 10 }} />
      <View style={{ width: '30%', height: 12, borderRadius: 6, backgroundColor: colors.panel2, marginTop: 10 }} />
    </View>
  );
}

/** A plain 72px avatar: the photograph when one exists, otherwise initials — never a broken image, never a layout shift. */
function Avatar({ name, photoUrl }: { name: string; photoUrl?: string | null }) {
  const styles = useStyles(makeStyles);
  const [broken, setBroken] = useState(false);
  if (photoUrl && !broken) {
    return <Image source={{ uri: photoUrl }} onError={() => setBroken(true)} style={styles.avatar} accessibilityLabel={name} accessible />;
  }
  return (
    <View style={styles.avatar} testID="profile-avatar" accessibilityLabel={name} accessible>
      <Text style={styles.avatarText}>{initialsOf(name)}</Text>
    </View>
  );
}

function FactRow({ k, v, sub }: { k: string; v: string; sub?: string | null }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.fact}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.factKey}>{k}</Text>
        {sub ? <Text style={styles.factSub}>{sub}</Text> : null}
      </View>
      <Text style={styles.factValue}>{v}</Text>
    </View>
  );
}

function PerformanceSection({ me, benchmarks, onCombine }: { me: NonNullable<ReturnType<typeof useSession>['me']>; benchmarks: Benchmarks | null; onCombine: () => void }) {
  const styles = useStyles(makeStyles);
  const drills = me.drillResults ?? [];
  const hasStats = !!me.stats;
  const hasBench = !!benchmarks && (benchmarks.drills.length > 0 || benchmarks.stats.length > 0);
  const empty = drills.length === 0 && !hasStats && !me.heightCm && !me.weightKg && !hasBench && me.trialReports.length === 0;
  if (empty) {
    return (
      <View style={styles.block} testID="perf-empty">
        <Text style={styles.calmText}>{pt('profNoPerformance')}</Text>
        <Muted size={13.5}>{pt('profNoPerformanceHint')}</Muted>
        <TextButton label={pt('profViewCombine')} onPress={onCombine} size={13} />
      </View>
    );
  }
  return (
    <>
      <View style={styles.block} testID="perf-combine">
        <SectionTitle>{pt('profCombine')}</SectionTitle>
        {drills.length === 0 ? <Muted size={13.5}>{pt('profNoCombine')}</Muted> : drills.map((r) => (
          <FactRow key={r.id} k={r.drillName} sub={`${r.metric} · ${r.verified ? 'Verified' : 'Self-reported'}`} v={`${r.value}${r.unit}`} />
        ))}
        <TextButton label={pt('profViewCombine')} onPress={onCombine} size={13} testID="perf-combine-link" />
      </View>

      {hasStats && (
        <View style={styles.block} testID="perf-season">
          <SectionTitle>{pt('profSeason')}</SectionTitle>
          <FactRow k="Appearances" v={String(me.stats!.appearances)} />
          {me.position === 'GK'
            ? <FactRow k="Clean sheets" v={String(me.stats!.cleanSheets ?? 0)} />
            : (<><FactRow k="Goals" v={String(me.stats!.goals)} /><FactRow k="Assists" v={String(me.stats!.assists)} /></>)}
          {me.stats!.paceKmh != null && <FactRow k="Top speed" v={`${me.stats!.paceKmh} km/h`} />}
          {me.stats!.passCompletionPct != null && <FactRow k="Pass accuracy" v={`${me.stats!.passCompletionPct}%`} />}
          {me.stats!.duelSuccessPct != null && <FactRow k="Duels won" v={`${me.stats!.duelSuccessPct}%`} />}
          {(me.seasonHistory?.length ?? 0) > 0 && (
            <View style={{ marginTop: 14, gap: 0 }}>
              <Text style={styles.subhead}>Season by season</Text>
              {me.seasonHistory!.map((s) => <FactRow key={s.season} k={s.season} sub={`${s.appearances} appearances`} v={`${s.goals} goals · ${s.assists} assists`} />)}
            </View>
          )}
        </View>
      )}

      {(me.heightCm || me.weightKg) ? (
        <View style={styles.block} testID="perf-physical">
          <SectionTitle>{pt('profPhysical')}</SectionTitle>
          {me.heightCm ? <FactRow k="Height" v={`${me.heightCm} cm`} /> : null}
          {me.weightKg ? <FactRow k="Weight" v={`${me.weightKg} kg`} /> : null}
        </View>
      ) : null}

      {hasBench && (
        <View style={styles.block} testID="perf-benchmarks">
          <SectionTitle>Where you stand — your cohort, not the pros</SectionTitle>
          <Muted size={12.5}>{benchmarks!.note}</Muted>
          {benchmarks!.stats.map((b) => (
            <FactRow key={b.stat} k={b.stat.replace(/Pct$/, ' %').replace(/([A-Z])/g, ' $1').toLowerCase().replace(/^./, (c) => c.toUpperCase())} v={String(b.value)} sub={b.percentile !== null ? `Top ${Math.max(1, 100 - b.percentile)}%` : 'Cohort too small'} />
          ))}
          {benchmarks!.drills.map((b) => (
            <FactRow key={b.drillId} k={b.name} v={`${b.value}${b.unit}`} sub={b.percentile !== null ? `Top ${Math.max(1, 100 - b.percentile)}%` : 'Cohort too small'} />
          ))}
        </View>
      )}

      {me.trialReports.length > 0 && (
        <View style={styles.block} testID="perf-reports">
          <SectionTitle>{pt('profTrialReports')}</SectionTitle>
          {me.trialReports.map((r) => (
            <View key={r.id} style={styles.fact}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.factKey}>{r.orgName}</Text>
                <Text style={styles.factSub}>{`Acceleration ${r.acceleration}/10 · ${r.sprintSpeedKmh} km/h · ${r.distanceKm} km · passing ${r.passCompletionPct}% · duels ${r.duelSuccessPct}%`}</Text>
                {r.strengthNote ? <Text style={styles.factSub}>Strength: {r.strengthNote}</Text> : null}
                {r.focusNote ? <Text style={styles.factSub}>Work on: {r.focusNote}</Text> : null}
              </View>
              <Text style={styles.factValue}>{`Coach ${r.coachRating}/10`}</Text>
            </View>
          ))}
          <Muted size={12.5}>Filed by clubs after your trials.</Muted>
        </View>
      )}
    </>
  );
}

function CvBlock({ playerId }: { playerId: string }) {
  const styles = useStyles(makeStyles);
  const [cv, setCv] = useState<PlayerCV | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { client.getCv(playerId).then(setCv).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load')); }, [playerId]);
  if (err) return <Muted size={13}>{err}</Muted>;
  if (!cv) return <Muted size={13}>Loading…</Muted>;
  return (
    <View style={{ gap: 6 }} testID="profile-cv">
      <Text style={styles.subhead}>{cv.player.name} — Verified Sports CV</Text>
      <Muted size={12.5}>{cv.player.position ?? '—'} · {cv.player.age} · {cv.player.foot ?? '—'} foot · {cv.player.country}{cv.player.identityVerified ? ' · identity verified' : ''}</Muted>
      <Muted size={12.5}>Evidence confidence {cv.trust.score}/100 ({cv.trust.tier}) — not a rating of you as a player</Muted>
      {cv.seasonStats && <Muted size={12.5}>Season: {cv.seasonStats.appearances} apps · {cv.seasonStats.goals} goals · {cv.seasonStats.assists} assists</Muted>}
      <Muted size={12.5}>Verified attendance ({cv.verifiedAttendance.length}): {cv.verifiedAttendance.map((a) => `${a.fixture} (${a.date})`).join(' · ') || '—'}</Muted>
      <Muted size={12.5}>Verified clips: {cv.verifiedClips.map((c) => c.title).join(' · ') || '—'}</Muted>
      <Muted size={12.5}>Trial reports ({cv.trialReports.length}): {cv.trialReports.map((r) => `${r.orgName} — coach ${r.coachRating}/10`).join(' · ') || '—'}</Muted>
      {cv.combine.length > 0 && <Muted size={12.5}>Combine: {cv.combine.map((r) => `${r.metric} ${r.value}${r.unit}${r.verified ? ' (verified)' : ''}`).join(' · ')}</Muted>}
      <Muted size={11.5}>{cv.note}</Muted>
    </View>
  );
}

/** M24F.4 — a clip as a picture, not a player: the browser's first frame, no controls, tap to open. */
function ClipThumb({ src, onPress, testID }: { src: string | null; onPress?: () => void; testID?: string }) {
  const colors = useColors();
  // No playable file (the demo's sample clips carry none): a quiet frame with the
  // video mark, never a stock picture.
  const frame = src && Platform.OS === 'web'
    ? createElement('video', { src, muted: true, playsInline: true, preload: 'metadata', 'aria-hidden': true, tabIndex: -1, style: { width: '100%', height: 200, objectFit: 'cover', borderRadius: 14, background: colors.panel2, display: 'block', pointerEvents: 'none' } })
    : <View style={{ width: '100%', height: src ? 200 : 132, borderRadius: 14, backgroundColor: colors.training, alignItems: 'center', justifyContent: 'center' }}><View style={{ backgroundColor: colors.trainingDisc, borderRadius: 999, padding: 12 }}><Icon name="video" size={22} color={colors.iconFg} /></View></View>;
  return <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined} testID={testID} style={({ pressed }) => [{ borderRadius: 14, overflow: 'hidden' }, pressed && { opacity: 0.85 }]}>{frame}</Pressable>;
}

function EvidenceSection({ me, playerId, isMinor, refresh, onUpload, onBoxCam, onCombine }: { me: NonNullable<ReturnType<typeof useSession>['me']>; playerId: string; isMinor: boolean; refresh: () => Promise<unknown>; onUpload: () => void; onBoxCam: () => void; onCombine: () => void }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const [vouchCoach, setVouchCoach] = useState('');
  const [vouchEmail, setVouchEmail] = useState('');
  const [vouchNote, setVouchNote] = useState<string | null>(null);
  const [page, setPage] = useState<'video' | 'references' | 'attendance' | 'record' | null>(null);
  // The Combine count is the server's (verified results); read once, never derived.
  const [combineCount, setCombineCount] = useState<number | null>(null);
  useEffect(() => { let on = true; combine.overview({ kind: 'player', id: playerId }).then((o) => on && setCombineCount(o.verifiedResults.length)).catch(() => on && setCombineCount(null)); return () => { on = false; }; }, [playerId]);

  // M24F.4 — the root is visual: the latest clip as a picture, then one row
  // per kind of evidence with its count. The clips, the references, the
  // attendance and the record itself each open one tap deep.
  const clips = [...me.media].sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  const latest = clips.find((m) => !!client.mediaUrl(m.url)) ?? clips[0] ?? null;
  const latestSrc = latest ? client.mediaUrl(latest.url) : null;
  const vouches = me.vouches ?? [];
  const back = (label: string) => (
    <Pressable onPress={() => setPage(null)} accessibilityRole="button" accessibilityLabel={pt('evBack')} testID="evidence-back" hitSlop={8} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, alignSelf: 'flex-start' }, pressed && { opacity: 0.7 }]}>
      <Icon name="chevron-left" size={16} color={colors.accent2} /><Text style={{ color: colors.accent2, fontSize: 13, fontWeight: '500' }}>{label}</Text>
    </Pressable>
  );

  if (page === 'video') {
    return (
      <View style={styles.block} testID="evidence-footage">
        {back(pt('evBack'))}
        <SectionTitle>{pt('profFootage')}</SectionTitle>
        {clips.length === 0 ? <Muted size={13.5}>{pt('profNoEvidence')}</Muted> : clips.map((m) => {
          const src = client.mediaUrl(m.url);
          const tags = Object.entries(m.tags ?? {}).map(([t, n]) => `${t.replace(/_/g, ' ')} ×${n}`).join(' · ');
          return (
            <View key={m.id} style={styles.clip} testID={`evidence-clip-${m.id}`}>
              {src ? <WebVideo src={src} /> : null}
              <Text style={styles.factKey}>{m.title}</Text>
              <Text style={styles.factSub}>{[dateOnly(m.uploadedAt), m.verifiedClip ? 'Verified clip' : cap(m.kind), `${m.views ?? 0} view${(m.views ?? 0) === 1 ? '' : 's'}`].join(' · ')}</Text>
              {tags ? <Text style={styles.factSub}>Scouts noticed: {tags}</Text> : null}
            </View>
          );
        })}
        <TextButton label={pt('profAddEvidence')} onPress={onUpload} size={13} testID="evidence-upload-link" />
      </View>
    );
  }
  if (page === 'attendance') {
    return (
      <View style={styles.block} testID="evidence-attendance">
        {back(pt('evBack'))}
        <SectionTitle>{pt('profAttendance')}</SectionTitle>
        {me.attendance.map((a) => (
          <FactRow key={a.id} k={a.fixture} sub={`${a.venue} · ${dateOnly(a.date)}${a.corroboratedBy ? ` · coach-signed by ${a.corroboratedBy}` : a.gps ? ' · GPS' : ''}`} v={a.verified ? 'Verified' : 'Logged'} />
        ))}
      </View>
    );
  }
  if (page === 'references') {
    return (
      <View style={styles.block} testID="evidence-references">
        {back(pt('evBack'))}
        <SectionTitle>{pt('profReferences')}</SectionTitle>
        {vouches.length === 0 && <Muted size={13.5}>{isMinor ? 'Your parent or guardian requests references for you.' : 'A named coach vouching for you is the strongest credential an amateur can hold.'}</Muted>}
        {vouches.map((v) => (
          <View key={v.id} style={styles.fact}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.factKey}>{v.coachName} · {v.role}</Text>
              {v.text ? <Text style={styles.factSub}>“{v.text}”{v.seasons ? ` — ${v.seasons}` : ''}</Text> : null}
            </View>
            <Text style={[styles.factValue, v.status === 'published' && { color: colors.accentText }]}>{v.status === 'published' ? 'Verified' : cap(v.status)}</Text>
          </View>
        ))}
        {!isMinor && (
          <Disclosure label="Request a coach reference" testID="evidence-request-reference">
            <TextInput style={styles.input} placeholder="Coach name" placeholderTextColor={colors.muted} value={vouchCoach} onChangeText={setVouchCoach} accessibilityLabel="Coach name" />
            <TextInput style={styles.input} placeholder="Coach email" placeholderTextColor={colors.muted} value={vouchEmail} onChangeText={setVouchEmail} autoCapitalize="none" accessibilityLabel="Coach email" />
            <Row>
              <Button small primary label="Request reference" onPress={async () => {
                try {
                  await client.requestVouch(playerId, vouchCoach.trim(), vouchEmail.trim(), 'Coach');
                  setVouchCoach(''); setVouchEmail(''); setVouchNote('Sent — your coach gets an email with a one-time code.');
                  await refresh();
                } catch (e) { setVouchNote(e instanceof Error ? e.message : 'Could not send'); }
              }} />
            </Row>
            {vouchNote && <Muted size={12.5}>{vouchNote}</Muted>}
          </Disclosure>
        )}
      </View>
    );
  }
  if (page === 'record') {
    return (
      <View style={styles.block} testID="evidence-record">
        {back(pt('evBack'))}
        <SectionTitle>{pt('evRecord')}</SectionTitle>
        {/* the evidence record itself (M12): tiers, records, the add-evidence form — unchanged */}
        <View style={styles.block} testID="evidence-passport">
          <PassportSection actor={{ kind: 'player', id: playerId }} />
        </View>
        <Disclosure label="Verified sports CV" testID="evidence-cv">
          <CvBlock playerId={playerId} />
        </Disclosure>
        <Disclosure label={`Profile ${me.trustScore}% complete`} testID="evidence-completeness">
          <Muted size={12.5}>Base {me.trust.base} · Identity +{me.trust.identityVerified} · Attendance +{me.trust.verifiedAttendance} · Trial reports +{me.trust.trialReports} · Media +{me.trust.media} · Profile +{me.trust.profileComplete}</Muted>
          {(me.nextActions ?? []).map((a) => <Muted key={a.id} size={12.5}>{a.label}{a.gain ? ` (+${a.gain})` : ''}</Muted>)}
          <Muted size={12}>How complete your profile is. It is not a rating of you as a player and it never moves through payments.</Muted>
        </Disclosure>
      </View>
    );
  }

  return (
    <View style={styles.block} testID="evidence-root">
      {latest ? (
        <View style={{ marginBottom: 6 }} testID="evidence-latest">
          <View style={{ marginBottom: 8 }}><Kicker>{pt('evLatest')}</Kicker></View>
          <ClipThumb src={latestSrc} onPress={() => setPage('video')} testID="evidence-latest-thumb" />
          <ListRow label={latest.title} value={[humanDate(latest.uploadedAt.slice(0, 10)), latest.verifiedClip ? 'Verified clip' : cap(latest.kind)].join(' · ')} onPress={() => setPage('video')} testID="evidence-latest-row" />
        </View>
      ) : (
        <View style={{ paddingVertical: 12 }}><Muted size={13.5}>{pt('evNoClips')}</Muted></View>
      )}
      <View style={{ marginTop: 18, marginBottom: 2 }}><Kicker>{pt('evCategories')}</Kicker></View>
      <ListRow label={pt('evVideo')} count={clips.length} onPress={() => setPage('video')} testID="evidence-video-row" />
      <ListRow label={pt('evCombine')} count={combineCount == null ? undefined : combineCount} onPress={onCombine} testID="evidence-combine-row" />
      {me.pathway ? <ListRow label={pt('profReferences')} count={vouches.length} onPress={() => setPage('references')} testID="evidence-references-row" /> : null}
      {me.attendance.length > 0 ? <ListRow label={pt('profAttendance')} count={me.attendance.length} onPress={() => setPage('attendance')} testID="evidence-attendance-row" /> : null}
      <ListRow label={pt('evBoxCam')} onPress={onBoxCam} testID="evidence-boxcam-link" />
      <ListRow label={pt('evRecord')} onPress={() => setPage('record')} testID="evidence-record-row" />
      <TextButton label={pt('profAddEvidence')} onPress={onUpload} size={13} testID="evidence-upload-link" />
    </View>
  );
}

function JourneyTimeline({ journeys, requests, earlier, onExplore }: { journeys: PlayerJourney[]; requests: InboxRequest[]; earlier: { year: string; event: string }[]; onExplore: () => void }) {
  const styles = useStyles(makeStyles);
  // the server's journey events (one line per club, only what reached this person) plus the
  // requests in the Inbox — received, and answered when they were — newest first
  const events = [
    ...journeys.flatMap((j) => j.journey.timeline.map((e) => ({ at: e.at, label: cap(evLabel(e.kind)), club: j.club.name ?? pt('jnClub') }))),
    ...requests.flatMap((r) => [
      { at: r.createdAt, label: r.type === 'trial' ? 'Trial invitation received' : 'Contact request received', club: r.orgName },
      ...(r.respondedAt && (r.status === 'accepted' || r.status === 'declined') ? [{ at: r.respondedAt, label: r.status === 'accepted' ? (r.type === 'trial' ? 'Trial invitation accepted' : 'Contact accepted') : (r.type === 'trial' ? 'Trial invitation declined' : 'Contact declined'), club: r.orgName }] : []),
    ]),
  ].sort((a, b) => b.at - a.at);
  const stages = journeys.filter((j) => j.journey.stage !== 'none');
  return (
    <>
      {stages.length > 0 && (
        <View style={styles.block} testID="journey-current">
          {stages.map((j) => <FactRow key={j.club.id} k={j.club.name ?? pt('jnClub')} v={stLabel(j.journey.stage)} />)}
        </View>
      )}
      <View style={styles.block} testID="journey-events">
        {events.length === 0 ? <Text style={styles.calmText}>{pt('profNoJourney')}</Text> : events.map((e, i) => {
          const showDay = i === 0 || dayLabel(events[i - 1].at) !== dayLabel(e.at);
          return (
            <View key={`${e.at}-${e.label}-${i}`} style={styles.event} testID="journey-event">
              {showDay ? <Kicker>{dayLabel(e.at)}</Kicker> : null}
              <Text style={styles.factKey}>{e.club}</Text>
              <Text style={styles.factSub}>{e.label}</Text>
            </View>
          );
        })}
        {(journeys.length > 0 || requests.length > 0) && <TextButton label={pt('profOpenExplore')} onPress={onExplore} size={13} testID="journey-explore-link" />}
      </View>
      {earlier.length > 0 && (
        <View style={styles.block} testID="journey-earlier">
          <SectionTitle>{pt('profEarlier')}</SectionTitle>
          {earlier.map((t, i) => <FactRow key={`${t.year}-${i}`} k={t.event} v={t.year} />)}
        </View>
      )}
    </>
  );
}

/**
 * The controls that used to sit on the profile: availability, first-team
 * seeker, contract status, Academy+, the contract facts and medical sharing.
 * They live in You › Account now (M24F.1 §52, §16 of the audit); the words,
 * the calls and the rules are the ones they always had.
 */
export function ProfileSettings() {
  return (<><AvailabilitySettings /><MedicalSettings /></>);
}

export function AvailabilitySettings() {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const { playerId, me, isMinor, refresh } = useSession();
  if (!playerId || !me) return null;
  const set = async (fn: () => Promise<unknown>) => { try { await fn(); await refresh(); } catch { /* surfaced through unrefreshed UI */ } };
  return (
    <>
      <Disclosure label="Availability and status" hint={`${pt(`avail_${me.availability}` as Parameters<typeof pt>[0])} · ${CONTRACT_LABELS[me.contractStatus]}`} testID="account-availability">
        {isMinor ? (
          <Muted size={13}>Availability and club interactions are managed by your parent or guardian. You focus on playing — uploads, stats and drills are all yours.</Muted>
        ) : (
          <>
            <Text style={styles.subhead}>Availability</Text>
            <Row>
              {(Object.keys(AVAILABILITY_LABELS) as Availability[]).map((a) => (
                <Button key={a} small primary={me.availability === a} label={AVAILABILITY_LABELS[a]} onPress={() => set(() => client.setAvailability(playerId, a, undefined))} />
              ))}
            </Row>
            {me.pathway && (
              <Row style={{ justifyContent: 'space-between', marginTop: 6 }}>
                <View style={{ flex: 1, paddingRight: 10 }}>
                  <Text style={styles.factKey}>Looking for my first team</Text>
                  <Muted size={12}>First Team Seekers surface first to local grassroots clubs. Need-based, free, never purchasable.</Muted>
                </View>
                <Switch value={!!me.firstTeamSeeker} onValueChange={(v) => set(() => client.setFirstTeamSeeker(playerId, v))} trackColor={{ true: colors.accent, false: colors.line }} thumbColor="#fff" />
              </Row>
            )}
            <Text style={[styles.subhead, { marginTop: 10 }]}>Contract status</Text>
            {/* M23 P8 §26 — "Under contract" is recorded by a signing completed in ScoutBox and cannot be declared here. */}
            {me.contractStatus === 'under_contract' ? (
              <View testID="contract-status-canonical">
                <Row><Button small primary label={CONTRACT_LABELS.under_contract} onPress={() => undefined} /></Row>
                <Muted size={12}>Recorded when your signing completed in ScoutBox. It updates from your contract, not from this screen.</Muted>
              </View>
            ) : (
              <Row>
                {(Object.keys(CONTRACT_LABELS) as ContractStatus[]).filter((c) => c !== 'unknown' && c !== 'under_contract').map((c) => (
                  <Button key={c} small primary={me.contractStatus === c} label={CONTRACT_LABELS[c]} onPress={() => set(() => client.setAvailability(playerId, undefined, c))} />
                ))}
              </Row>
            )}
            <Row style={{ justifyContent: 'space-between', marginTop: 10 }}>
              <View style={{ flex: 1, paddingRight: 10 }}>
                <Text style={styles.factKey}>Academy+</Text>
                <Muted size={12}>Opt-in cohort for released and late-developing players — surfaced first in club searches. Player-controlled.</Muted>
              </View>
              <Switch value={me.academyPlus} onValueChange={(v) => set(() => client.setAcademyPlus(playerId, v))} trackColor={{ true: colors.accent, false: colors.line }} thumbColor="#fff" />
            </Row>
            {me.contractUntil ? <FactRow k="Contracted until" v={dateOnly(me.contractUntil)} /> : null}
            {me.marketValueRange ? <FactRow k="Market value range" v={me.marketValueRange} /> : null}
            {me.agentName ? <FactRow k="Agent" v={me.agentName} /> : null}
          </>
        )}
      </Disclosure>
    </>
  );
}

export function MedicalSettings() {
  const colors = useColors();
  const { playerId, me, isMinor, refresh } = useSession();
  if (!playerId || !me) return null;
  const set = async (fn: () => Promise<unknown>) => { try { await fn(); await refresh(); } catch { /* surfaced through unrefreshed UI */ } };
  return (
    <>
      <Disclosure label="Medical sharing" hint={me.medical.shared ? 'On — visible to organisations' : 'Off — invisible to every organisation'} testID="account-medical">
        <Row style={{ justifyContent: 'space-between' }}>
          <View style={{ flex: 1, paddingRight: 10 }}>
            <Muted size={13}>
              {isMinor
                ? 'Your parent or guardian controls this. Nothing is visible to any organisation unless they switch it on.'
                : 'Your medical history is invisible to every organisation unless you switch this on. Sharing never changes your Trust Score.'}
            </Muted>
          </View>
          {!isMinor && <Switch value={me.medical.shared} onValueChange={(v) => set(() => client.setMedicalShared(playerId, v))} trackColor={{ true: colors.gold, false: colors.line }} thumbColor="#fff" />}
        </Row>
        {me.medical.records.map((r) => <FactRow key={r.id} k={r.title} sub={`${cap(r.type)} · ${r.date}${r.layoffWeeks ? ` · ${r.layoffWeeks} wks` : ''}`} v={r.cleared ? 'Cleared' : ''} />)}
        {me.medical.records.length === 0 && <Muted size={12.5}>No records logged.</Muted>}
      </Disclosure>
    </>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: 22, paddingTop: 8, paddingBottom: 32, gap: 0 },
  // identity
  header: { paddingTop: 10, paddingBottom: 18, gap: 4 },
  avatar: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  avatarText: { color: colors.accentInk, fontSize: 24, fontWeight: '700', letterSpacing: -0.5 },
  name: { color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.8, lineHeight: 33 },
  summary: { color: colors.text, fontSize: 15.5, fontWeight: '500', marginTop: 2 },
  availability: { color: colors.muted, fontSize: 14, marginTop: 6 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginTop: 8 },
  verified: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 32 },
  marker: { width: 8, height: 8, backgroundColor: colors.accent },
  verifiedText: { color: colors.safetyText, fontSize: 13, fontWeight: '600' },
  quietWord: { color: colors.muted, fontSize: 13 },
  // sections
  body: { paddingTop: 22, gap: 34 },
  block: { gap: 0 },
  next: { backgroundColor: colors.panel, borderRadius: 14, padding: 18, gap: 4, borderWidth: 1, borderColor: colors.line },
  nextClub: { color: colors.text, fontSize: 19, fontWeight: '700', letterSpacing: -0.4, marginTop: 6 },
  nextTitle: { color: colors.text, fontSize: 15, fontWeight: '500' },
  nextLine: { color: colors.muted, fontSize: 13.5, lineHeight: 19, marginTop: 2 },
  calm: { paddingVertical: 4 },
  calmText: { color: colors.text, fontSize: 16, fontWeight: '500' },
  fact: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: colors.line },
  factKey: { color: colors.text, fontSize: 14.5, fontWeight: '500', flexShrink: 1 },
  factValue: { color: colors.text, fontSize: 14.5, fontWeight: '600', textAlign: 'right', flexShrink: 1, maxWidth: '55%' },
  factSub: { color: colors.muted, fontSize: 12.5, lineHeight: 17, marginTop: 2 },
  subhead: { color: colors.text, fontSize: 14, fontWeight: '600', paddingBottom: 4 },
  activityRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: colors.line },
  activityText: { color: colors.text, fontSize: 14, flex: 1, lineHeight: 19 },
  activityWhen: { color: colors.muted, fontSize: 12.5, paddingTop: 2 },
  clip: { gap: 4, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line },
  event: { gap: 2, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, color: colors.text, backgroundColor: colors.bg2, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14, marginTop: 8 },
});
