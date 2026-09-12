// M15 — the Football Passport, player/guardian surface.
// One server-built projection renders here: status with provenance, the
// career timeline, club history (trials are never employment), evidence
// summary, references, achievements, the non-shaming gap list, corrections
// and revocable sharing. Adults manage their own shares; a minor's shares
// are guardian-managed — the SERVER enforces all of it, this is only UI.
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { colors } from '../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from './ui';
import { m15, type FootballPassport, type PassportActor, type PassportEvent, type PassportShare } from '../data/m15client';
import { pt } from '../i18n';

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): [T | null, () => void, string | null] {
  const [v, setV] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let ok = true;
    setErr(null);
    fn().then((x) => ok && setV(x)).catch((e) => ok && setErr(e instanceof Error ? e.message : 'failed'));
    return () => { ok = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return [v, () => setTick((x) => x + 1), err];
}

const input = {
  backgroundColor: colors.panel2, color: colors.text, borderRadius: 8,
  paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, borderWidth: 1, borderColor: colors.line,
} as const;

// Short provenance chips; the long honest copy comes from the server.
const PROV_TONE: Record<string, 'green' | 'blue' | 'gold' | 'default'> = {
  verified_club_confirmed: 'green', authoritative_registry: 'green',
  verified_coach_confirmed: 'blue', scoutbox_reviewed: 'gold',
};
function ProvPill({ provenance }: { provenance: string }) {
  const key = `m15prov_${provenance}` as Parameters<typeof pt>[0];
  let label: string | undefined;
  try { label = pt(key); } catch { label = undefined; }
  // An unrecognised provenance used to render its raw identifier at the
  // player ("box_cam_observed"). It now says, in words, that ScoutBox cannot
  // classify the source — never a guess at which one it is.
  return <Pill label={label ?? pt('m15prov_unknown')} tone={PROV_TONE[provenance] ?? 'default'} />;
}

function eventLabel(e: PassportEvent): string {
  const org = (e.title as { org?: string }).org ?? e.org?.name ?? '';
  const map: Record<string, string> = {
    club_joined: `${pt('m15evJoined')} ${org}`,
    club_left: `${pt('m15evLeft')} ${org}`,
    club_affiliation_verified: `${pt('m15evAffVerified')} — ${org}`,
    trial_attended: `${pt('m15evTrial')} — ${org}`,
    trial_outcome: `${pt('m15evTrialOutcome')} — ${org}`,
    assessment_completed: `${pt('m15evAssessment')} — ${org}`,
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
    achievement: `🏅 ${(e.title as { label?: string }).label ?? ''}`,
    position_change: `${pt('m15evPosition')}: ${(e.title as { primary?: string }).primary ?? ''}`,
  };
  return map[e.type] ?? e.type.replace(/_/g, ' ');
}

function TimelineRow({ e }: { e: PassportEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6, marginTop: 6 }}>
      <Row>
        <Text style={{ color: colors.muted, fontSize: 12, minWidth: 74 }}>{e.when.display}</Text>
        <Text style={{ color: colors.text, fontSize: 13, flexShrink: 1 }}>{eventLabel(e)}</Text>
        <ProvPill provenance={e.provenance} />
      </Row>
      {e.provenanceCopy ? (
        <Text onPress={() => setOpen((x) => !x)} style={{ color: colors.muted, fontSize: 11.5, marginTop: 2 }} accessibilityRole="button">
          {open ? e.provenanceCopy : pt('m15whyTap')}
        </Text>
      ) : null}
    </View>
  );
}

const GAP_LABEL: Record<string, Parameters<typeof pt>[0]> = {
  'gap.full_match_recent': 'm15gapMatch', 'gap.coach_reference': 'm15gapRef',
  'gap.current_club_confirmed': 'm15gapClub', 'gap.assessment_recent': 'm15gapAssessment',
  'gap.position_declared': 'm15gapPosition', 'gap.availability_set': 'm15gapAvailability',
  'gap.identity_confirmed': 'm15gapIdentity', 'gap.career_history': 'm15gapCareer',
};

function SharesPanel({ actor }: { actor: PassportActor }) {
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
    <View style={{ marginTop: 8 }}>
      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('m15shareTitle')}</Text>
      <Muted size={12}>{actor.kind === 'guardian' ? pt('m15shareGuardianNote') : pt('m15shareNote')}</Muted>
      <Row style={{ marginTop: 6 }}>
        <Button small label={pt('m15sharePublic')} onPress={() => void create('public')} />
        <Button small label={pt('m15shareRecruitment')} onPress={() => void create('recruitment')} />
      </Row>
      {minted ? (
        <View style={{ marginTop: 6, backgroundColor: colors.panel2, borderRadius: 8, padding: 8 }}>
          <Text selectable style={{ color: colors.text, fontSize: 12, fontFamily: 'monospace' }}>{minted.url}</Text>
          <Muted size={11.5}>{pt('m15shareOnce')} {minted.note}</Muted>
        </View>
      ) : null}
      {(shares ?? []).map((s) => (
        <Row key={s.id} style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6, marginTop: 6 }}>
          <Pill label={s.mode === 'public' ? pt('m15sharePublicPill') : pt('m15shareRecruitmentPill')} tone={s.mode === 'public' ? 'blue' : 'gold'} />
          <Muted size={12}>{pt('m15shareViews')}: {s.views}</Muted>
          {s.revokedAt
            ? <Pill label={pt('m15shareRevoked')} tone="red" />
            : <Button small label={pt('m15shareRevoke')} onPress={async () => { try { await m15.revokeShare(actor, s.id); reload(); } catch { /* shown on reload */ } }} />}
        </Row>
      ))}
      {msg ? <Muted size={12}>⚠️ {msg}</Muted> : null}
    </View>
  );
}

/** The full Passport section for the You tab (player) and guardian child view. */
export function FootballPassportSection({ actor, isMinor, childName }: { actor: PassportActor; isMinor?: boolean; childName?: string }) {
  const [p, reload, err] = useLoad<FootballPassport>(() => m15.passport(actor), [actor.id, actor.kind === 'guardian' ? actor.childId : '']);
  const [showAll, setShowAll] = useState(false);
  const [careerOrg, setCareerOrg] = useState('');
  const [careerFrom, setCareerFrom] = useState('');
  const [careerTo, setCareerTo] = useState('');
  const [achTitle, setAchTitle] = useState('');
  const [corrReason, setCorrReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (err) return <Card><SectionTitle>{pt('m15title')}</SectionTitle><Muted>⚠️ {err}</Muted></Card>;
  if (!p) return null;
  const events = showAll ? p.timeline : p.timeline.slice(0, 6);
  const canShare = actor.kind === 'guardian' || !isMinor;
  const act = async (fn: () => Promise<unknown>, okMsg: string) => {
    try { await fn(); setMsg(okMsg); reload(); } catch (e) { setMsg(`⚠️ ${e instanceof Error ? e.message : 'failed'}`); }
  };
  return (
    <Card>
      <SectionTitle>{pt('m15title')}{childName ? ` — ${childName}` : ''}</SectionTitle>
      <Muted size={12}>{p.note}</Muted>

      {/* Current status */}
      <Row style={{ marginTop: 6 }}>
        {p.identity ? <Pill label={p.identity.label} tone="gold" /> : null}
        {p.status.currentClub
          ? <Pill label={`${p.status.currentClub.orgName}${p.status.currentClub.since ? ` · ${pt('m15since')} ${p.status.currentClub.since}` : ''}`} tone={PROV_TONE[p.status.currentClub.provenance] ?? 'default'} />
          : <Pill label={pt('m15noClub')} />}
        {p.status.availability ? <Pill label={pt(`m15avail_${p.status.availability}` as Parameters<typeof pt>[0])} tone="blue" /> : null}
      </Row>

      {/* Conflicts are explained to the player, never silently resolved */}
      {p.conflicts.map((c) => (
        <View key={c.code + (c.submitted.orgName ?? '')} style={{ backgroundColor: colors.panel2, borderRadius: 8, padding: 8, marginTop: 6 }}>
          <Text style={{ color: colors.text, fontSize: 12.5 }}>
            {pt('m15conflict')
              .replace('{auth}', c.authoritative.orgName ?? '?')
              .replace('{self}', c.submitted.orgName ?? '?')}
          </Text>
        </View>
      ))}
      {p.temporalConflicts.length > 0 ? (
        <Muted size={12}>⏱ {pt('m15temporal')}</Muted>
      ) : null}

      {/* Evidence coverage + gaps (non-shaming) */}
      <Row style={{ marginTop: 6 }}>
        <Pill label={`${pt('m15coverage')}: ${pt(`m15cov_${p.completeness.evidenceCoverage}` as Parameters<typeof pt>[0])}`} tone={p.completeness.evidenceCoverage === 'strong' ? 'green' : 'default'} />
        <Muted size={12}>{pt('m15checks').replace('{n}', String(p.completeness.eligibility.satisfied)).replace('{total}', String(p.completeness.eligibility.total))}</Muted>
      </Row>
      <Muted size={12}>
        {pt('m15evidenceLine')
          .replace('{matches}', String(p.evidence.fullMatches)).replace('{clips}', String(p.evidence.clips))
          .replace('{refs}', String(p.evidence.references))}
      </Muted>
      {p.completeness.gaps.slice(0, 4).map((g) => (
        <Muted key={g.id} size={12}>· {pt(GAP_LABEL[g.id] ?? 'm15gapCareer')}</Muted>
      ))}

      {/* Club history — provenance per row, trials never appear here */}
      {p.clubHistory.length > 0 ? (
        <View style={{ marginTop: 8 }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('m15history')}</Text>
          {p.clubHistory.map((r2) => (
            <Row key={`${r2.orgName}-${r2.from}`} style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6, marginTop: 6 }}>
              <Text style={{ color: colors.text, fontSize: 13, flexShrink: 1 }}>{r2.orgName}{r2.role ? ` · ${r2.role}` : ''}</Text>
              <Muted size={12}>{r2.from ?? '—'} → {r2.current ? pt('m15now') : r2.to ?? '—'}</Muted>
              <ProvPill provenance={r2.provenance} />
            </Row>
          ))}
        </View>
      ) : null}

      {/* Timeline */}
      <View style={{ marginTop: 8 }}>
        <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('m15timeline')}</Text>
        {events.map((e) => <TimelineRow key={e.id} e={e} />)}
        {p.timeline.length > 6 ? (
          <Row style={{ marginTop: 6 }}><Button small label={showAll ? pt('m15less') : pt('m15more').replace('{n}', String(p.timeline.length))} onPress={() => setShowAll((x) => !x)} /></Row>
        ) : null}
      </View>

      {/* Achievements */}
      <View style={{ marginTop: 8 }}>
        <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('m15achievements')}</Text>
        {p.achievements.map((a) => (
          <Row key={a.id} style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6, marginTop: 6 }}>
            <Text style={{ color: colors.text, fontSize: 13, flexShrink: 1 }}>🏅 {a.title}{a.when ? ` (${a.when})` : ''}</Text>
            <ProvPill provenance={a.provenance} />
            {a.confirmedBy ? <Muted size={11.5}>{pt('m15confirmedBy')} {a.confirmedBy}</Muted> : null}
            {actor.kind === 'player' && a.withdrawable ? (
              <Button small label={pt('m15withdraw')} onPress={() => void act(() => m15.withdrawAchievement(actor.id, a.id), pt('m15withdrawn'))} />
            ) : null}
          </Row>
        ))}
        <Row style={{ marginTop: 6 }}>
          <TextInput style={[input, { flex: 1 }]} value={achTitle} onChangeText={setAchTitle} placeholder={pt('m15achPlaceholder')} placeholderTextColor={colors.muted} accessibilityLabel={pt('m15achPlaceholder')} />
          <Button small label={pt('m15add')} onPress={() => { if (achTitle.trim()) void act(async () => { await m15.addAchievement(actor, { title: achTitle.trim() }); setAchTitle(''); }, pt('m15achAdded')); }} />
        </Row>
      </View>

      {/* Self-submitted career history */}
      <View style={{ marginTop: 8 }}>
        <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('m15careerTitle')}</Text>
        <Muted size={12}>{pt('m15careerNote')}</Muted>
        <Row style={{ marginTop: 6 }}>
          <TextInput style={[input, { flex: 2, minWidth: 120 }]} value={careerOrg} onChangeText={setCareerOrg} placeholder={pt('m15careerOrg')} placeholderTextColor={colors.muted} accessibilityLabel={pt('m15careerOrg')} />
          <TextInput style={[input, { flex: 1, minWidth: 70 }]} value={careerFrom} onChangeText={setCareerFrom} placeholder={pt('m15careerFrom')} placeholderTextColor={colors.muted} accessibilityLabel={pt('m15careerFrom')} />
          <TextInput style={[input, { flex: 1, minWidth: 70 }]} value={careerTo} onChangeText={setCareerTo} placeholder={pt('m15careerTo')} placeholderTextColor={colors.muted} accessibilityLabel={pt('m15careerTo')} />
          <Button small label={pt('m15add')} onPress={() => {
            if (!careerOrg.trim() || !careerFrom.trim()) { setMsg(pt('m15careerNeedYear')); return; }
            void act(async () => {
              const r = await m15.addCareer(actor, { orgName: careerOrg.trim(), from: careerFrom.trim(), to: careerTo.trim() || undefined });
              setCareerOrg(''); setCareerFrom(''); setCareerTo('');
              if (r.note) setMsg(r.note);
            }, pt('m15careerAdded'));
          }} />
        </Row>
      </View>

      {/* Corrections — the record is never edited directly */}
      <View style={{ marginTop: 8 }}>
        <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('m15corrTitle')}</Text>
        <Muted size={12}>{pt('m15corrNote')}</Muted>
        <Row style={{ marginTop: 6 }}>
          <TextInput style={[input, { flex: 1 }]} value={corrReason} onChangeText={setCorrReason} placeholder={pt('m15corrPlaceholder')} placeholderTextColor={colors.muted} accessibilityLabel={pt('m15corrPlaceholder')} />
          <Button small label={pt('m15corrFile')} onPress={() => {
            if (corrReason.trim()) void act(async () => { const r = await m15.fileCorrection(actor, { targetType: 'club_history', reason: corrReason.trim() }); setCorrReason(''); setMsg(r.note); }, pt('m15corrFiled'));
          }} />
        </Row>
      </View>

      {/* Sharing */}
      {canShare ? <SharesPanel actor={actor} /> : <Muted size={12}>{pt('m15shareMinor')}</Muted>}
      {msg ? <Muted size={12}>{msg}</Muted> : null}
    </Card>
  );
}
