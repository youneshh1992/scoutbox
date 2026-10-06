import { GuidanceNote } from './InformationRows';
// M12 player/guardian sections, dropped into the existing tabs:
// passport (Profile), opportunity board (Home), campaigns + resumable upload
// (Upload), feedback→objectives + follow-ups + access settings (You),
// squad invites + trial safety (Inbox), and the guardian panel (guardian.tsx).
// Accessibility: accessibilityLabel/role on controls, status text announced
// via accessibilityLiveRegion.
import { useCallback, useEffect, useState } from 'react';
import { Platform, Switch, View } from 'react-native';
import { Text, TextInput } from './Text';
import { useColors, type Palette } from '../theme';
import { RecordPanel, DetailFact, InfoNote, TimelineItem, Button, Card, Disclosure, Muted, Pill, Row, SectionTitle } from './ui';
import { m12, type BoardItem, type FeedbackItem, type CampaignView, type FamilyTrial, type FollowUpView, type ObjectiveRec, type PassportView, type SafetyPack, type SquadInvite, type UploadSession } from '../data/m12client';
import { getDataSaver, getPLang, pFmtDate, pt, setDataSaver, setPLang } from '../i18n';
import { InvitationCard, InvitationDetail } from './InvitationCard';
import { humanDate } from '../time';

// M24F — presentation casing for status labels; the data value is never changed.
const cap = (v: string | null | undefined) => (v ? v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ') : '');

export type Actor = { kind: 'player'; id: string } | { kind: 'guardian'; id: string; childId: string };

const toneFor = (tier: string): 'green' | 'blue' | 'gold' | 'default' =>
  tier === 'club_assessed' ? 'green' : tier === 'coach_confirmed' ? 'blue' : tier === 'independent' ? 'gold' : 'default';

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): [T | null, () => void] {
  const [v, setV] = useState<T | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let ok = true;
    fn().then((x) => ok && setV(x)).catch(() => {});
    return () => { ok = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return [v, () => setTick((x) => x + 1)];
}

const inputStyle = (colors: Palette) => ({
  backgroundColor: colors.panel2, color: colors.text, borderRadius: 8,
  paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, borderWidth: 1, borderColor: colors.line,
} as const);

// ------------------------------------------------------------- F1 passport
export function PassportSection({ actor }: { actor: Actor }) {
  const colors = useColors();
  const [pp, reload] = useLoad<PassportView>(
    () => (actor.kind === 'player' ? m12.getPassport(actor.id) : m12.gPassport(actor.id, actor.childId)),
    [actor.id]
  );
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!pp) return null;
  return (
    <Card>
      <SectionTitle>{pt('passport')}</SectionTitle>
      <Muted size={12}>{pt('provenance')}</Muted>
      {pp.summary.insufficient && (
        <View style={{ backgroundColor: colors.panel2, borderRadius: 8, padding: 8, marginTop: 6 }}>
          <Muted size={12}>{pt('insufficient')}</Muted>
        </View>
      )}
      {pp.records.map((r) => (
        <RecordPanel key={r.id} title={r.label} subtitle={pFmtDate(r.recordedAt)} icon="file-check-2" badge={<Pill label={cap(r.verification.status)} tone={toneFor(r.verification.status)} />}>
          {r.value != null && <Text style={{ color: colors.text, fontWeight: '600', fontSize: 20 }}>{r.value}{r.units ? ` ${r.units}` : ''}</Text>}
          {r.verification.method && <DetailFact label="Verification method" value={r.verification.method} icon="shield-check" />}
          {r.verification.reviewerName && <DetailFact label="Reviewed by" value={r.verification.reviewerName} icon="user-round" />}
          {r.superseded && <InfoNote>Superseded</InfoNote>}
          {r.correctionOf && <InfoNote>Correction</InfoNote>}
        </RecordPanel>
      ))}
      {pp.legacy.map((l, i) => (
        <RecordPanel key={i} title={l.label} badge={<Pill label={cap(l.tier)} tone={toneFor(l.tier)} />}>
          {l.caveat && <InfoNote>{l.caveat}</InfoNote>}
        </RecordPanel>
      ))}
      <View style={{ marginTop: 10, gap: 6 }}>
        <TextInput style={inputStyle(colors)} placeholder="Claim (e.g. Assists this season)" placeholderTextColor={colors.muted}
          accessibilityLabel="Evidence claim label" value={label} onChangeText={setLabel} />
        <Row>
          <TextInput style={[inputStyle(colors), { flex: 1 }]} placeholder="Value" placeholderTextColor={colors.muted}
            accessibilityLabel="Evidence value" value={value} onChangeText={setValue} keyboardType="numeric" />
          <Button small label={pt('addClaim')} onPress={async () => {
            if (!label.trim()) return;
            try {
              const inputRec = { claimType: 'statistic', label, value: value ? Number(value) : undefined };
              if (actor.kind === 'player') await m12.addEvidence(actor.id, inputRec);
              else await m12.gAddEvidence(actor.id, actor.childId, inputRec);
              setLabel(''); setValue(''); setMsg('Logged as self-reported — a coach or club can corroborate it.');
              reload();
            } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
          }} />
        </Row>
        {msg && <Muted size={12}>{msg}</Muted>}
      </View>
    </Card>
  );
}

// --------------------------------------------------------------- F5 board
export function BoardSection({ actor }: { actor: Actor }) {
  const colors = useColors();
  const [board, reload] = useLoad<{ items: BoardItem[]; minor?: boolean; note?: string | null }>(
    () => (actor.kind === 'player' ? m12.getBoard(actor.id) : m12.gBoard(actor.id, actor.childId)),
    [actor.id]
  );
  const [msg, setMsg] = useState<string | null>(null);
  if (!board) return null;
  // M24F.3 — one row per opportunity: the title, then club · date · distance,
  // and the one state word. The description, the schedule, what to bring and
  // the actions sit behind "View".
  const appliedWord = (s: string) => (s === 'accepted' ? pt('boardAccepted') : s === 'declined' || s === 'rejected' ? pt('boardDeclinedApp') : s === 'withdrawn' ? pt('boardWithdrawn') : pt('boardApplied'));
  return (
    <Card testID="board">
      <SectionTitle icon="opportunity-board">{pt('board')}</SectionTitle>
      {board.items.map((o: BoardItem) => (
        <View key={o.id} testID={`board-item-${o.id}`}>
          <Disclosure label={o.title} hint={`${o.orgName} · ${humanDate(o.deadline)}${o.distance ? ` · ${o.distance}` : ''}${o.applied ? ` · ${appliedWord(o.applied.status)}` : ''}`} testID={`board-view-${o.id}`}>
            <Row><Text style={{ color: colors.muted, fontSize: 12.5 }}>{cap(o.type)}</Text>{o.schedule ? <Muted size={12.5}>· {o.schedule}</Muted> : null}</Row>
            {o.description && <Text style={{ color: colors.text, fontSize: 13.5, lineHeight: 20 }}>{o.description}</Text>}
            {(o.requirements ?? []).length > 0 && <RecordPanel title={pt('boardRequirements')} icon="list-checks">{o.requirements!.map((requirement, i) => <DetailFact key={i} label={`${i + 1}`} value={requirement} icon="list-checks" />)}</RecordPanel>}
            <Row style={{ marginTop: 4 }}>
              {o.applied ? (
                <>
                  <Text style={{ color: o.applied.status === 'accepted' ? colors.accentText : colors.text, fontSize: 13.5, fontWeight: '600' }} testID={`board-status-${o.id}`}>{appliedWord(o.applied.status)}</Text>
                  {o.applied.status === 'submitted' && o.applied.id && actor.kind === 'player' && (
                    <Button small tertiary label={pt('withdraw')} onPress={async () => { await m12.withdrawApplication(actor.id, o.applied!.id!); reload(); }} />
                  )}
                </>
              ) : o.via === 'open_trial' ? (
                <Muted size={12.5}>{pt('boardOpenDay')}</Muted>
              ) : (
                <Button small primary label={pt('apply')} testID={`board-apply-${o.id}`} onPress={async () => {
                  try {
                    if (actor.kind === 'player') await m12.applyToOpportunity(actor.id, o.id);
                    else await m12.gApply(actor.id, actor.childId, o.id);
                    setMsg('Application submitted — the club must answer it.');
                    reload();
                  } catch (e) { setMsg(e instanceof Error ? e.message : 'Not eligible'); }
                }} />
              )}
            </Row>
          </Disclosure>
        </View>
      ))}
      {board.items.length === 0 && <GuidanceNote icon="info" size={13}>Nothing open near you right now.</GuidanceNote>}
      {msg && <View accessibilityLiveRegion="polite"><Muted size={12.5}>{msg}</Muted></View>}
      {actor.kind === 'player' && board.minor && <GuidanceNote icon="users" size={12.5}>{pt('guardianApplies')}</GuidanceNote>}
      {board.note ? <Disclosure label={pt('boardAbout')} testID="board-note"><GuidanceNote size={12.5}>{board.note}</GuidanceNote></Disclosure> : null}
    </Card>
  );
}

// ----------------------------------------------------------- F6 campaigns
export function CampaignsSection({ actor, mediaOptions }: { actor: Actor; mediaOptions: { id: string; title: string }[] }) {
  const colors = useColors();
  const [camps, reload] = useLoad<CampaignView[]>(
    () => (actor.kind === 'player' ? m12.getCampaigns(actor.id) : m12.gCampaigns(actor.id, actor.childId)),
    [actor.id]
  );
  const [msg, setMsg] = useState<string | null>(null);
  if (!camps || camps.length === 0) return null;
  return (
    <Card>
      <SectionTitle>{pt('campaigns')}</SectionTitle>
      <Muted size={12}>{pt('fileVsHuman')}</Muted>
      {camps.map((c) => (
        <View key={c.id} style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13.5 }}>{c.title}</Text>
          <Muted size={12}>{c.orgName} · deadline {c.deadline} · {c.attemptsAllowed} attempts</Muted>
          {c.drills.map((d, i) => (
            <View key={i} style={{ marginTop: 6 }}>
              <Text style={{ color: colors.text, fontSize: 12.5 }}>{d.name}: {d.instructions}</Text>
              <Muted size={11.5}>{pt('recording')}: {Object.values(d.recording).join(' · ')}</Muted>
            </View>
          ))}
          {(c.mySubmission?.attempts ?? []).map((a) => (
            <View key={a.id} style={{ marginTop: 6 }}>
              <Row><Muted size={12}>{a.drillName}</Muted><Pill label={cap(a.status)} tone={a.status === 'accepted' ? 'green' : a.status === 'returned' || a.status === 'failed_checks' ? 'red' : 'blue'} /></Row>
              {!a.fileChecks.passed && <GuidanceNote icon="info" size={11.5}>File check: {a.fileChecks.issues.join('; ')}</GuidanceNote>}
              {a.review?.reasons && <GuidanceNote icon="info" size={11.5}>Coach: {a.review.reasons}</GuidanceNote>}
            </View>
          ))}
          <AttemptForm actor={actor} campaign={c} mediaOptions={mediaOptions} onDone={(m) => { setMsg(m); reload(); }} />
        </View>
      ))}
      {msg && <View accessibilityLiveRegion="polite"><Muted size={12}>{msg}</Muted></View>}
    </Card>
  );
}

function AttemptForm({ actor, campaign, mediaOptions, onDone }: { actor: Actor; campaign: CampaignView; mediaOptions: { id: string; title: string }[]; onDone: (msg: string) => void }) {
  const [mediaId, setMediaId] = useState<string | undefined>(mediaOptions[0]?.id);
  return (
    <Row style={{ marginTop: 6, flexWrap: 'wrap' }}>
      {mediaOptions.slice(0, 3).map((m) => (
        <Button key={m.id} small primary={mediaId === m.id} label={`${m.title.slice(0, 18)}`} onPress={() => setMediaId(m.id)} />
      ))}
      <Button small primary label={pt('submitAttempt')} onPress={async () => {
        try {
          const r = actor.kind === 'player'
            ? await m12.submitCampaignAttempt(actor.id, campaign.id, mediaId, campaign.drills[0]?.name ?? 'drill')
            : await m12.gSubmitCampaignAttempt(actor.id, actor.childId, campaign.id, mediaId, campaign.drills[0]?.name ?? 'drill');
          onDone(r.status === 'submitted' ? 'File checks passed — now waiting for a HUMAN coach review.' : `File checks failed: ${r.issues.join('; ')}`);
        } catch (e) { onDone(e instanceof Error ? e.message : 'Failed'); }
      }} />
    </Row>
  );
}

// -------------------------------------------- F2 feedback + F8 development
export function FeedbackDevSection({ actor }: { actor: Actor }) {
  const colors = useColors();
  const [fb] = useLoad<{ guardianManaged?: boolean; count?: number; items: FeedbackItem[] }>(
    () => (actor.kind === 'player' ? m12.getFeedback(actor.id) : m12.gFeedback(actor.id, actor.childId)),
    [actor.id]
  );
  const [objectives, reload] = useLoad<ObjectiveRec[]>(
    () => (actor.kind === 'player' ? m12.getObjectives(actor.id) : m12.gObjectives(actor.id, actor.childId)),
    [actor.id]
  );
  const [msg, setMsg] = useState<string | null>(null);
  const [progressNote, setProgressNote] = useState('');
  const say = (m: string) => setMsg(m);
  return (
    <Card>
      <SectionTitle>{pt('feedback')} & {pt('objectives')}</SectionTitle>
      {fb?.guardianManaged ? (
        <Muted size={12}>Your parent/guardian holds {fb.count} published feedback note{(fb.count ?? 0) === 1 ? '' : 's'} from clubs — ask them to go through it with you.</Muted>
      ) : (
        (fb?.items ?? []).map((f) => (
          <RecordPanel key={f.id} title={f.orgName} subtitle={`${f.byName} · ${pFmtDate(f.at)}`} icon="message-circle">

            <Text style={{ color: colors.text, fontSize: 13 }}>{f.text}</Text>
            {!(objectives ?? []).some((o) => o.objectives.length) && (
              <Button small label={pt('makeObjective')} onPress={async () => {
                try {
                  const text = f.text.split(/[.!]/)[1]?.trim() || 'Work on the published focus area';
                  if (actor.kind === 'player') await m12.createObjective(actor.id, f.id, [text]);
                  else await m12.gCreateObjective(actor.id, actor.childId, f.id, [text]);
                  say('Objective agreed from the published feedback.');
                  reload();
                } catch (e) { say(e instanceof Error ? e.message : 'Failed'); }
              }} />
            )}
          </RecordPanel>
        ))
      )}
      {(objectives ?? []).map((o) => (
        <RecordPanel key={o.id} icon="target">
          {o.objectives.map((x) => <Text key={x.id} style={{ color: colors.text, fontWeight: '600', fontSize: 13 }}>{x.text}</Text>)}
          <Muted size={12}>with {o.reviewer.name}{o.reviewer.orgName ? ` · ${o.reviewer.orgName}` : ''} · {o.progress.length} progress entries</Muted>
          {o.reassessments.map((r) => (
            <InfoNote key={r.id}>{pt('reassess')}: {cap(r.status)}{r.outcome ? ` — ${r.outcome.note}` : ''}</InfoNote>
          ))}
          <Row style={{ marginTop: 6, flexWrap: 'wrap' }}>
            <TextInput style={[inputStyle(colors), { flex: 1, minWidth: 120 }]} placeholder={pt('logProgress')} placeholderTextColor={colors.muted}
              accessibilityLabel={pt('logProgress')} value={progressNote} onChangeText={setProgressNote} />
            {actor.kind === 'player' && (
              <Button small label="＋" onPress={async () => {
                if (!progressNote.trim()) return;
                await m12.addObjectiveProgress(actor.id, o.id, progressNote);
                setProgressNote(''); say('Progress logged.'); reload();
              }} />
            )}
          </Row>
          <Row style={{ marginTop: 6, flexWrap: 'wrap' }}>
            <Button small label={o.sharing.orgIds.length ? pt('unshare') : pt('share')} onPress={async () => {
              const enabled = o.sharing.orgIds.length === 0;
              try {
                if (actor.kind === 'player') await m12.shareObjective(actor.id, o.id, o.orgId, enabled);
                else await m12.gShareObjective(actor.id, o.id, o.orgId, enabled);
                say(enabled ? 'Progress now visible to the club — your choice, reversible any time.' : 'Sharing stopped — the club no longer sees this.');
                reload();
              } catch (e) { say(e instanceof Error ? e.message : 'Failed'); }
            }} />
            {!o.reassessments.some((r) => r.status === 'requested') && (
              <Button small primary label={pt('reassess')} onPress={async () => {
                try {
                  if (actor.kind === 'player') await m12.requestReassessment(actor.id, o.id);
                  else await m12.gRequestReassessment(actor.id, o.id);
                  say('Reassessment requested — the reviewer will answer with evidence.');
                  reload();
                } catch (e) { say(e instanceof Error ? e.message : 'Share with the club first.'); }
              }} />
            )}
          </Row>
        </RecordPanel>
      ))}
      {msg && <View accessibilityLiveRegion="polite"><Muted size={12}>{msg}</Muted></View>}
    </Card>
  );
}

// ---------------------------------------------------------- F9 trial days
export function TrialSafetySection({ actor }: { actor: Actor }) {
  const colors = useColors();
  const [trials, reload] = useLoad<FamilyTrial[]>(
    () => (actor.kind === 'player' ? m12.getTrials(actor.id) : m12.gTrials(actor.id)),
    [actor.id]
  );
  const [packView, setPackView] = useState<SafetyPack | null>(null);
  const [emName, setEmName] = useState('');
  const [emPhone, setEmPhone] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!trials || trials.length === 0) return null;
  const scope = actor.kind === 'player' ? 'player_event_consent' : 'guardian_event_consent';
  return (
    <Card>
      <SectionTitle>{pt('trialDay')}</SectionTitle>
      {trials.map((tr) => (
        <InvitationCard key={tr.id} title={tr.orgName ?? tr.playerName} subtitle={pt('trialDay')} date={tr.proposedDate ?? null} actions={<>
          <Row style={{ marginTop: 6, flexWrap: 'wrap' }}>
            {tr.consents.some((c) => c.scope === scope)
              ? <Pill label={pt('consented')} tone="green" />
              : <Button small primary label={pt('consent')} onPress={async () => {
                  try {
                    if (actor.kind === 'player') await m12.giveTrialConsent(actor.id, tr.id);
                    else await m12.gGiveTrialConsent(actor.id, tr.id);
                    setMsg('Consent recorded for this event only.');
                    reload();
                  } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
                }} />}
            <Button small label={pt('safetyPack')} onPress={async () => {
              setPackView(actor.kind === 'player' ? await m12.getSafetyPack(actor.id, tr.id) : await m12.gSafetyPack(actor.id, tr.id));
            }} />
          </Row>
          <Row style={{ marginTop: 6, flexWrap: 'wrap' }}>
            <TextInput style={[inputStyle(colors), { flex: 1, minWidth: 100 }]} placeholder="Contact name" placeholderTextColor={colors.muted} accessibilityLabel="Emergency contact name" value={emName} onChangeText={setEmName} />
            <TextInput style={[inputStyle(colors), { flex: 1, minWidth: 100 }]} placeholder="Phone" placeholderTextColor={colors.muted} accessibilityLabel="Emergency contact phone" value={emPhone} onChangeText={setEmPhone} />
            <Button small label={pt('emergency').split(' (')[0]} onPress={async () => {
              if (!emName || !emPhone) return;
              try {
                if (actor.kind === 'player') await m12.setEmergencyContact(actor.id, tr.id, emName, emPhone);
                else await m12.gSetEmergencyContact(actor.id, tr.id, emName, emPhone);
                setMsg('Held for the event’s safety staff only — never on your profile.');
              } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
            }} />
          </Row>
        </>}>
          {tr.cancelled && <Pill label="Cancelled" tone="red" />}
          {tr.staff.map((s, i) => (
            <Row key={i}><View style={{ flex: 1 }}><DetailFact label={s.role} value={s.name} icon="users" /></View>
              <Pill label={s.check.status === 'reviewed' ? 'Check reviewed' : `Check ${s.check.status}`} tone={s.check.status === 'reviewed' ? 'green' : 'gold'} /></Row>
          ))}
          {tr.arrival?.address && <InvitationDetail icon="map-pin" title={pt('invBeforeArrival')}>{[tr.arrival.time, tr.arrival.address].filter(Boolean).join(' · ')}</InvitationDetail>}
        </InvitationCard>
      ))}
      {packView && (
        <View style={{ marginTop: 10, backgroundColor: colors.panel2, borderRadius: 10, padding: 10 }}>
          <Row><Text style={{ color: colors.gold, fontWeight: '700', fontSize: 13, flex: 1 }}>Safety pack</Text>
            <Button small label="Close" onPress={() => setPackView(null)} /></Row>
          <GuidanceNote title="Event overview" icon="calendar-days">{packView.pack.headline}</GuidanceNote>
          <GuidanceNote title="Staff checks" icon="shield-check">{packView.pack.checksExplained}</GuidanceNote>
          {packView.pack.collection && <GuidanceNote title="Collection arrangements" icon="users">{packView.pack.collection.policy}</GuidanceNote>}
          <GuidanceNote title="Reporting a concern" icon="flag">{packView.pack.reportRoute}</GuidanceNote>
          {packView.pack.feedbackDue && <DetailFact label="Mandatory club feedback due" value={packView.pack.feedbackDue} icon="calendar-days" />}
        </View>
      )}
      {msg && <View accessibilityLiveRegion="polite"><Muted size={12}>{msg}</Muted></View>}
    </Card>
  );
}

// ------------------------------------------------------- F10 squad invites
export function SquadInvitesSection({ actor }: { actor: Actor }) {
  const colors = useColors();
  const [invites, reload] = useLoad<SquadInvite[]>(
    () => (actor.kind === 'player' ? m12.getSquadInvites(actor.id) : m12.gSquadInvites(actor.id)),
    [actor.id]
  );
  if (!invites || invites.length === 0) return null;
  return (
    <Card>
      <SectionTitle>{pt('squadInvites')}</SectionTitle>
      {invites.map((i) => (
        <InvitationCard key={i.id} title={i.orgName} subtitle={pt('detailInviteTo')} icon="users" testID={`squad-invite-${i.id}`} actions={<Row>
            <Button grow primary label={pt('accept')} onPress={async () => {
              if (actor.kind === 'player') await m12.respondSquadInvite(actor.id, i.id, true);
              else await m12.gRespondSquadInvite(actor.id, i.id, true);
              reload();
            }} />
            <Button grow label={pt('decline')} onPress={async () => {
              if (actor.kind === 'player') await m12.respondSquadInvite(actor.id, i.id, false);
              else await m12.gRespondSquadInvite(actor.id, i.id, false);
              reload();
            }} />
          </Row>}>
          {actor.kind === 'guardian' && <DetailFact label={pt('detailInvitePlayer')} value={i.playerName} />}
          {i.note && <InvitationDetail icon="users" title={pt('detailSquad')}>{i.note}</InvitationDetail>}
        </InvitationCard>
      ))}
    </Card>
  );
}

// ---------------------------------------------------------- F11 follow-ups
export function FollowUpsSection({ actor }: { actor: Actor }) {
  const colors = useColors();
  const [ups, reload] = useLoad<FollowUpView[]>(
    () => (actor.kind === 'player' ? m12.getFollowUps(actor.id) : m12.gFollowUps(actor.id)),
    [actor.id]
  );
  const answerable = (ups ?? []).filter((f) => f.report);
  if (answerable.length === 0) return null;
  return (
    <Card>
      <SectionTitle>{pt('followUps')}</SectionTitle>
      {answerable.map((f) => (
        <RecordPanel key={f.id} title={f.orgName ?? 'The club'} icon="clipboard-list" testID={`placement-checkin-${f.id}`} actions={f.outcomeState === 'reported' ? (
            <Row style={{ marginTop: 4 }}>
              <Button small primary label={pt('confirm')} onPress={async () => {
                if (actor.kind === 'player') await m12.respondFollowUp(actor.id, f.id, true, undefined, 4);
                else await m12.gRespondFollowUp(actor.id, f.id, true);
                reload();
              }} />
              <Button small label={pt('dispute')} onPress={async () => {
                if (actor.kind === 'player') await m12.respondFollowUp(actor.id, f.id, false, 'That does not match my experience.');
                else await m12.gRespondFollowUp(actor.id, f.id, false, 'That does not match our experience.');
                reload();
              }} />
            </Row>
          ) : <Pill label={cap(f.outcomeState)} tone={f.outcomeState === 'confirmed' ? 'green' : 'red'} />}>
          <DetailFact label={pt('detailMilestone')} value={/^\d+m$/.test(f.milestone) ? `${parseInt(f.milestone, 10)} ${getPLang() === 'fr' ? 'mois' : 'months'}` : f.milestone} icon="calendar-days" />
          <DetailFact label={pt('detailRegistration')} value={cap(f.report!.registrationStatus)} icon="file-check-2" />
          {f.report!.progression && <DetailFact label={pt('detailProgression')} value={f.report!.progression} icon="activity" />}
        </RecordPanel>
      ))}
    </Card>
  );
}

// -------------------------------------- F12 access & inclusion (You tab)
export function AccessSection({ playerId, mediaOptions, isMinor }: { playerId: string; mediaOptions: { id: string; title: string }[]; isMinor: boolean }) {
  const colors = useColors();
  const [lang, setLangState] = useState(getPLang());
  const [saver, setSaver] = useState(getDataSaver());
  const [msg, setMsg] = useState<string | null>(null);
  const [vtt, setVtt] = useState('');
  return (
    <Card>
      <SectionTitle>Access & language</SectionTitle>
      <Row>
        <Text style={{ color: colors.text, fontSize: 13, flex: 1 }}>{pt('language')}</Text>
        <Button small primary={lang === 'en'} label="EN" onPress={() => { setPLang('en'); setLangState('en'); }} />
        <Button small primary={lang === 'fr'} label="FR" onPress={() => { setPLang('fr'); setLangState('fr'); }} />
      </Row>
      {/* M24F.2 — the machine-translation note only once French is the chosen language. */}
      {lang === 'fr' && <Muted size={11.5}>{pt('machineNote')}</Muted>}
      <Row style={{ marginTop: 8 }}>
        <Text style={{ color: colors.text, fontSize: 13, flex: 1 }}>{pt('dataSaver')}</Text>
        <Switch accessibilityLabel={pt('dataSaver')} value={saver} onValueChange={(v) => { setDataSaver(v); setSaver(v); }} />
      </Row>
      {!isMinor && (
        <Row style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <Text style={{ color: colors.text, fontSize: 13, flex: 1 }}>{pt('category')}</Text>
          {(['mens', 'womens', 'mixed'] as const).map((c) => (
            <Button key={c} small label={c} onPress={async () => { await m12.setFootballCategory(playerId, c); setMsg(`Category set: ${c}.`); }} />
          ))}
        </Row>
      )}
      {mediaOptions.length > 0 && (
        <View style={{ marginTop: 8 }}>
          <Muted size={12}>{pt('captions')} — for “{mediaOptions[0].title}”. Uncaptioned video is labelled as such, never passed off as covered.</Muted>
          <TextInput style={[inputStyle(colors), { minHeight: 60, marginTop: 4 }]} multiline placeholder={'WEBVTT\n\n00:00.000 --> 00:04.000\n…'}
            placeholderTextColor={colors.muted} accessibilityLabel={pt('captions')} value={vtt} onChangeText={setVtt} />
          <Button small label="Save captions" onPress={async () => {
            try { await m12.setCaptions(playerId, mediaOptions[0].id, vtt); setMsg('Caption track saved.'); }
            catch (e) { setMsg(e instanceof Error ? e.message : 'Captions must start with WEBVTT'); }
          }} />
        </View>
      )}
      {msg && <View accessibilityLiveRegion="polite"><Muted size={12}>{msg}</Muted></View>}
    </Card>
  );
}

// ------------------------------------------------ F12A resumable uploads
export function ResumableUploadCard({ playerId, onDone }: { playerId: string; onDone: () => void }) {
  const colors = useColors();
  const [session, setSession] = useState<UploadSession | null>(null);
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [pending, setPending] = useState<{ file: File; up: UploadSession } | null>(null);

  const pump = useCallback(async (file: File, up: UploadSession, from: number) => {
    for (let i = from; i < up.totalChunks; i++) {
      if (getPaused()) { setPending({ file, up }); setStatus(`Paused at chunk ${i}/${up.totalChunks} — resume any time, nothing is lost.`); return; }
      const start = i * up.chunkSize;
      const blob = file.slice(start, Math.min(start + up.chunkSize, file.size));
      const b64 = await blobToBase64(blob);
      await m12.putChunk(playerId, up.id, i, b64);
      setProgress(Math.round(((i + 1) / up.totalChunks) * 100));
    }
    const r = await m12.finaliseUpload(playerId, up.id);
    setStatus(`Upload finalised — media ${r.mediaId}. (Success is only reported AFTER integrity checks.)`);
    setSession(null); setPending(null); onDone();
  }, [playerId, onDone]);

  const pausedRef = { current: paused };
  const getPaused = () => pausedRef.current;
  pausedRef.current = paused;

  if (Platform.OS !== 'web') {
    return <Card><SectionTitle>{pt('uploadLarge')}</SectionTitle><Muted size={12}>Resumable uploads are verified on web; native file access ships with the store builds.</Muted></Card>;
  }
  return (
    <Card>
      <SectionTitle>{pt('uploadLarge')}</SectionTitle>
      <Muted size={12}>Chunked with integrity checks: interruptions resume without duplicates, and nothing counts as uploaded until finalisation passes.</Muted>
      {!session && (
        // eslint-disable-next-line react/no-unknown-property
        <input
          type="file" accept="video/webm,video/mp4,image/jpeg,image/png" aria-label="Choose a large video to upload"
          style={{ marginTop: 8, color: colors.muted }}
          onChange={async (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              const up = await m12.startUpload(playerId, { size: file.size, mime: file.type || 'video/webm', title: file.name.slice(0, 60) });
              setSession(up); setProgress(0); setStatus('Uploading…');
              void pump(file, up, 0);
            } catch (err) { setStatus(err instanceof Error ? err.message : 'Refused'); }
          }}
        />
      )}
      {session && (
        <View style={{ marginTop: 8 }}>
          <View style={{ height: 8, backgroundColor: colors.panel2, borderRadius: 4 }} accessibilityLabel={`Upload ${progress}%`}>
            <View style={{ height: 8, width: `${progress}%`, backgroundColor: colors.accent, borderRadius: 4 }} />
          </View>
          <Row style={{ marginTop: 6 }}>
            <Button small label={paused ? 'Resume' : 'Pause'} onPress={() => {
              const next = !paused;
              setPaused(next);
              if (!next && pending) { setStatus('Resuming…'); void pump(pending.file, pending.up, pending.up.received.length); }
            }} />
            <Button small danger label="Abort" onPress={async () => { await m12.abortUpload(playerId, session.id); setSession(null); setPending(null); setStatus('Aborted — partial chunks cleaned up server-side.'); }} />
          </Row>
        </View>
      )}
      {!!status && <View accessibilityLiveRegion="polite"><Muted size={12}>{status}</Muted></View>}
    </Card>
  );
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
