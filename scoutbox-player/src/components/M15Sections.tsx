// M15 — the Football Passport, player/guardian surface.
// One server-built projection renders here: status with provenance, the
// career timeline, club history (trials are never employment), evidence
// summary, references, achievements, the non-shaming gap list, corrections
// and revocable sharing. Adults manage their own shares; a minor's shares
// are guardian-managed — the SERVER enforces all of it, this is only UI.
//
// M24F.3 — the root is the essentials: the verified status, the current
// club, the availability, the evidence in one word, a short timeline. The
// disclaimer sits behind "About Passport", a conflict behind "Review", the
// counts behind "View evidence", provenance behind each event, and the three
// forms (career, correction, sharing) behind their own rows. Nothing is gone.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text, TextInput } from './Text';
import { useColors, type Palette } from '../theme';
import { Button, Card, Disclosure, EventRow, FactRow, Muted, Row, SectionTitle } from './ui';
import { HistoryList } from './Reference';
import { m15, type FootballPassport, type PassportActor, type PassportEvent, type PassportShare } from '../data/m15client';
import { pt } from '../i18n';
import { humanDate } from '../time';

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): [T | null, () => void, string | null] {
  const [v, setV] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let ok = true;
    fn().then((x) => { if (ok) { setV(x); setErr(null); } }).catch((e) => ok && setErr(e instanceof Error ? e.message : 'failed'));
    return () => { ok = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return [v, () => setTick((x) => x + 1), err];
}

const inputStyle = (colors: Palette) => ({
  backgroundColor: colors.panel2, color: colors.text, borderRadius: 8,
  paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, borderWidth: 1, borderColor: colors.line,
} as const);

/** The provenance as one short phrase ("Verified by club"), never a raw identifier. */
export function provWord(provenance: string): string {
  const key = `m15prov_${provenance}` as Parameters<typeof pt>[0];
  let label: string | undefined;
  try { label = pt(key); } catch { label = undefined; }
  return label ?? pt('m15prov_unknown');
}

function eventLabel(e: PassportEvent): string {
  const org = (e.title as { org?: string }).org ?? e.org?.name ?? '';
  const map: Record<string, string> = {
    club_joined: `${pt('m15evJoined')} ${org}`,
    club_left: `${pt('m15evLeft')} ${org}`,
    club_affiliation_verified: `${pt('m15evAffVerified')} — ${org}`,
    trial_attended: `${pt('m15evTrial')} · ${org}`,
    trial_outcome: `${pt('m15evTrialOutcome')} · ${org}`,
    assessment_completed: `${pt('m15evAssessment')} · ${org}`,
    reference_received: `${pt('m15evReference')}${(e.title as { coach?: string }).coach ? ` — ${(e.title as { coach?: string }).coach}` : ''}`,
    evidence_added: `${pt('m15evEvidence')}: ${(e.title as { label?: string }).label ?? ''}`,
    development_objective_created: pt('m15evObjective'),
    development_objective_completed: pt('m15evObjectiveDone'),
    opportunity_application: `${pt('m15evApplied')}${org ? ` — ${org}` : ''}`,
    transition_opened: pt('m15evTransition'),
    transition_completed: pt('m15evTransitionDone'),
    signed: `${pt('m15evSigned')} ${org}`,
    role_or_squad_changed: `${pt('m15evRole')}${org ? ` — ${org}` : ''}`,
    representation_started: `${pt('m15evRepStart')} — ${org}`,
    representation_ended: `${pt('m15evRepEnd')} — ${org}`,
    achievement: `${(e.title as { label?: string }).label ?? ''}`,
    position_change: `${pt('m15evPosition')}: ${(e.title as { primary?: string }).primary ?? ''}`,
  };
  return map[e.type] ?? e.type.replace(/_/g, ' ');
}

/** A timeline event: the date and the label; the source and its plain-language copy behind the row. */
function TimelineRow({ e }: { e: PassportEvent }) {
  return (
    <EventRow date={e.when.display} label={eventLabel(e)} testID={`passport-event-${e.id}`}>
      <Muted size={12.5}>{pt('m15source')}: {provWord(e.provenance)}</Muted>
      {e.provenanceCopy ? <Muted size={12.5}>{e.provenanceCopy}</Muted> : null}
    </EventRow>
  );
}

const GAP_LABEL: Record<string, Parameters<typeof pt>[0]> = {
  'gap.full_match_recent': 'm15gapMatch', 'gap.coach_reference': 'm15gapRef',
  'gap.current_club_confirmed': 'm15gapClub', 'gap.assessment_recent': 'm15gapAssessment',
  'gap.position_declared': 'm15gapPosition', 'gap.availability_set': 'm15gapAvailability',
  'gap.identity_confirmed': 'm15gapIdentity', 'gap.career_history': 'm15gapCareer',
};

function SharesPanel({ actor }: { actor: PassportActor }) {
  const colors = useColors();
  const [shares, reload] = useLoad<PassportShare[]>(() => m15.shares(actor), [actor.id]);
  const [minted, setMinted] = useState<{ url: string; note: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const create = async (mode: 'public' | 'recruitment') => {
    try {
      const r = await m15.createShare(actor, mode, 30);
      setMinted({ url: r.url, note: r.note });
      setMsg(null);
      reload();
    } catch (e) { setMsg(e instanceof Error ? e.message : 'failed'); }
  };
  return (
    <View style={{ gap: 6 }}>
      <Muted size={12.5}>{actor.kind === 'guardian' ? pt('m15shareGuardianNote') : pt('m15shareNote')}</Muted>
      <Row>
        <Button small label={pt('m15sharePublic')} onPress={() => void create('public')} />
        <Button small label={pt('m15shareRecruitment')} onPress={() => void create('recruitment')} />
      </Row>
      {minted ? (
        <View style={{ backgroundColor: colors.panel2, borderRadius: 8, padding: 8 }}>
          <Text selectable style={{ color: colors.text, fontSize: 12, fontFamily: 'monospace' }}>{minted.url}</Text>
          <Muted size={11.5}>{pt('m15shareOnce')} {minted.note}</Muted>
        </View>
      ) : null}
      {(shares ?? []).map((s) => (
        <Row key={s.id} style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6 }}>
          <Text style={{ color: colors.text, fontSize: 13 }}>{s.mode === 'public' ? pt('m15sharePublicPill') : pt('m15shareRecruitmentPill')} · {pt('m15shareViews')} {s.views}</Text>
          {s.revokedAt
            ? <Muted size={12}>{pt('m15shareRevoked')}</Muted>
            : <Button small label={pt('m15shareRevoke')} onPress={async () => { try { await m15.revokeShare(actor, s.id); reload(); } catch { /* shown on reload */ } }} />}
        </Row>
      ))}
      {msg ? <Muted size={12}>{msg}</Muted> : null}
    </View>
  );
}

/** The full Passport section for the Football tab (player) and guardian child view. */
export function FootballPassportSection({ actor, isMinor, childName }: { actor: PassportActor; isMinor?: boolean; childName?: string }) {
  const colors = useColors();
  const [p, reload, err] = useLoad<FootballPassport>(() => m15.passport(actor), [actor.id, actor.kind === 'guardian' ? actor.childId : '']);
  const [showAll, setShowAll] = useState(false);
  const [careerOrg, setCareerOrg] = useState('');
  const [careerFrom, setCareerFrom] = useState('');
  const [careerTo, setCareerTo] = useState('');
  const [achTitle, setAchTitle] = useState('');
  const [corrReason, setCorrReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (err) return <Card><SectionTitle>{pt('m15title')}</SectionTitle><Muted>{err}</Muted></Card>;
  if (!p) return null;
  const events = showAll ? p.timeline : p.timeline.slice(0, 4);
  const canShare = actor.kind === 'guardian' || !isMinor;
  const act = async (fn: () => Promise<unknown>, okMsg: string) => {
    try { await fn(); setMsg(okMsg); reload(); } catch (e) { setMsg(`${e instanceof Error ? e.message : 'failed'}`); }
  };
  const coverage = pt(`m15cov_${p.completeness.evidenceCoverage}` as Parameters<typeof pt>[0]);
  const club = p.status.currentClub;
  const count = (n: number, one: Parameters<typeof pt>[0], many: Parameters<typeof pt>[0]) => n === 0 ? pt('m15noneYet') : n === 1 ? pt(one) : pt(many).replace('{n}', String(n));
  // M24F.4 — the root is seven rows: the record line, three facts, then
  // Timeline / Club history / Achievements / Share / About as rows that open.
  // The forms live inside the row they belong to (add an achievement under
  // Achievements, add a club and file a correction under Club history).
  return (
    <Card testID="passport-root">
      <SectionTitle>{pt('m15title')}{childName ? ` — ${childName}` : ''}</SectionTitle>
      <Muted size={13}>{p.identity?.label ?? pt('m15verifiedRecord')}</Muted>

      {/* LEVEL 1 — the facts */}
      <View>
        <FactRow k={pt('m15currentClub')} v={club?.orgName ?? pt('m15noClub')} sub={club ? `${club.since ? `${pt('m15since')} ${humanDate(club.since)} · ` : ''}${provWord(club.provenance)}` : null} testID="passport-club" />
        {p.status.availability ? <FactRow k={pt('m15availability')} v={pt(`m15avail_${p.status.availability}` as Parameters<typeof pt>[0])} testID="passport-availability" /> : null}
        <FactRow k={pt('m15evidence')} v={pt('m15coverageWord').replace('{cov}', coverage)} testID="passport-evidence" />
      </View>

      {/* a conflict is one line and a Review; the full explanation is behind it */}
      {p.conflicts.map((c) => (
        <Disclosure key={c.code + (c.submitted.orgName ?? '')} label={pt('m15conflictShort')} testID="passport-conflict">
          <Muted size={13}>{pt('m15conflictLine')}</Muted>
          <Muted size={13}>
            {pt('m15conflict').replace('{auth}', c.authoritative.orgName ?? '?').replace('{self}', c.submitted.orgName ?? '?')}
          </Muted>
        </Disclosure>
      ))}
      {p.temporalConflicts.length > 0 ? <Muted size={12.5}>{pt('m15temporal')}</Muted> : null}

      <View style={{ marginTop: 10 }}>
        {/* LEVEL 2 — the evidence counts and the gaps */}
        <Disclosure label={pt('m15viewEvidence')} testID="passport-evidence-detail">
          <Muted size={13}>{pt('m15checks').replace('{n}', String(p.completeness.eligibility.satisfied)).replace('{total}', String(p.completeness.eligibility.total))}</Muted>
          <Muted size={13}>
            {pt('m15evidenceLine')
              .replace('{matches}', String(p.evidence.fullMatches)).replace('{clips}', String(p.evidence.clips))
              .replace('{refs}', String(p.evidence.references))}
          </Muted>
          {p.completeness.gaps.slice(0, 4).map((g) => (
            <Muted key={g.id} size={12.5}>· {pt(GAP_LABEL[g.id] ?? 'm15gapCareer')}</Muted>
          ))}
        </Disclosure>

        {/* Timeline — behind one row with its count; date and label per event, the source behind each */}
        <Disclosure label={pt('m15timelineRow')} hint={count(p.timeline.length, 'm15eventCount', 'm15events')} testID="passport-timeline">
          {events.map((e) => <TimelineRow key={e.id} e={e} />)}
          {p.timeline.length > 4 ? (
            <Row style={{ marginTop: 6 }}><Button small tertiary label={showAll ? pt('m15less') : pt('m15showAll').replace('{n}', String(p.timeline.length))} onPress={() => setShowAll((x) => !x)} testID="passport-timeline-more" /></Row>
          ) : null}
        </Disclosure>

        {/* Club history — trials never appear here; adding a club and filing a correction sit under it */}
        <Disclosure label={pt('m15history')} hint={count(p.clubHistory.length, 'm15clubCount', 'm15clubsCount')} testID="passport-history">
          {p.clubHistory.length > 0 ? (
            <HistoryList
              testID="passport-history-list"
              rows={p.clubHistory.map((r2, i) => ({
                index: String(i + 1).padStart(2, '0'),
                title: `${r2.orgName}${r2.role ? ` · ${r2.role}` : ''}`,
                sub: `${r2.from ?? '—'} → ${r2.current ? pt('m15now') : r2.to ?? '—'} · ${provWord(r2.provenance)}`,
              }))}
            />
          ) : null}
          <Disclosure label={pt('m15careerTitle')} testID="passport-add-career">
            <Muted size={12.5}>{pt('m15careerNote')}</Muted>
            <Row>
              <TextInput style={[inputStyle(colors), { flex: 2, minWidth: 120 }]} value={careerOrg} onChangeText={setCareerOrg} placeholder={pt('m15careerOrg')} placeholderTextColor={colors.muted} accessibilityLabel={pt('m15careerOrg')} />
              <TextInput style={[inputStyle(colors), { flex: 1, minWidth: 70 }]} value={careerFrom} onChangeText={setCareerFrom} placeholder={pt('m15careerFrom')} placeholderTextColor={colors.muted} accessibilityLabel={pt('m15careerFrom')} />
              <TextInput style={[inputStyle(colors), { flex: 1, minWidth: 70 }]} value={careerTo} onChangeText={setCareerTo} placeholder={pt('m15careerTo')} placeholderTextColor={colors.muted} accessibilityLabel={pt('m15careerTo')} />
              <Button small label={pt('m15add')} onPress={() => {
                if (!careerOrg.trim() || !careerFrom.trim()) { setMsg(pt('m15careerNeedYear')); return; }
                void act(async () => {
                  const r = await m15.addCareer(actor, { orgName: careerOrg.trim(), from: careerFrom.trim(), to: careerTo.trim() || undefined });
                  setCareerOrg(''); setCareerFrom(''); setCareerTo('');
                  if (r.note) setMsg(r.note);
                }, pt('m15careerAdded'));
              }} />
            </Row>
          </Disclosure>
          <Disclosure label={pt('m15corrTitle')} testID="passport-correction">
            <Muted size={12.5}>{pt('m15corrNote')}</Muted>
            <Row>
              <TextInput style={[inputStyle(colors), { flex: 1 }]} value={corrReason} onChangeText={setCorrReason} placeholder={pt('m15corrPlaceholder')} placeholderTextColor={colors.muted} accessibilityLabel={pt('m15corrPlaceholder')} />
              <Button small label={pt('m15corrFile')} onPress={() => {
                if (corrReason.trim()) void act(async () => { const r = await m15.fileCorrection(actor, { targetType: 'club_history', reason: corrReason.trim() }); setCorrReason(''); setMsg(r.note); }, pt('m15corrFiled'));
              }} />
            </Row>
          </Disclosure>
        </Disclosure>

        {/* Achievements — simple rows; the source and the withdrawal behind each; adding one under the row */}
        <Disclosure label={pt('m15achievementsRow')} hint={count(p.achievements.length, 'm15achievementCount', 'm15achievementsCount')} testID="passport-achievements">
          {p.achievements.map((a) => (
            <EventRow key={a.id} date={a.when ?? ''} label={a.title} testID={`passport-achievement-${a.id}`}>
              <Muted size={12.5}>{pt('m15source')}: {provWord(a.provenance)}{a.confirmedBy ? ` · ${pt('m15confirmedBy')} ${a.confirmedBy}` : ''}</Muted>
              {actor.kind === 'player' && a.withdrawable ? (
                <Row><Button small tertiary label={pt('m15withdraw')} onPress={() => void act(() => m15.withdrawAchievement(actor.id, a.id), pt('m15withdrawn'))} /></Row>
              ) : null}
            </EventRow>
          ))}
          <Disclosure label={pt('m15addAchievement')} testID="passport-add-achievement">
            <Row>
              <TextInput style={[inputStyle(colors), { flex: 1 }]} value={achTitle} onChangeText={setAchTitle} placeholder={pt('m15achPlaceholder')} placeholderTextColor={colors.muted} accessibilityLabel={pt('m15achPlaceholder')} />
              <Button small label={pt('m15add')} onPress={() => { if (achTitle.trim()) void act(async () => { await m15.addAchievement(actor, { title: achTitle.trim() }); setAchTitle(''); }, pt('m15achAdded')); }} />
            </Row>
          </Disclosure>
        </Disclosure>

        {canShare ? (
          <Disclosure label={pt('m15shareTitle')} testID="passport-share"><SharesPanel actor={actor} /></Disclosure>
        ) : <Muted size={12.5}>{pt('m15shareMinor')}</Muted>}
        <Disclosure label={pt('m15about')} testID="passport-about">
          <Muted size={13}>{p.note}</Muted>
        </Disclosure>
      </View>
      {msg ? <View accessibilityLiveRegion="polite"><Muted size={12.5}>{msg}</Muted></View> : null}
    </Card>
  );
}
