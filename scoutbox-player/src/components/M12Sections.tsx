// M12 player/guardian sections, dropped into the existing tabs:
// passport (Profile), opportunity board (Home), campaigns + resumable upload
// (Upload), feedback→objectives + follow-ups + access settings (You),
// squad invites + trial safety (Inbox), and the guardian panel (guardian.tsx).
// Accessibility: accessibilityLabel/role on controls, status text announced
// via accessibilityLiveRegion.
import { useCallback, useEffect, useState } from 'react';
import { Platform, Switch, Text, TextInput, View } from 'react-native';
import { colors } from '../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from './ui';
import { m12, type BoardItem, type FeedbackItem, type CampaignView, type FamilyTrial, type FollowUpView, type ObjectiveRec, type PassportView, type SafetyPack, type SquadInvite, type UploadSession } from '../data/m12client';
import { getDataSaver, getPLang, pFmtDate, pt, setDataSaver, setPLang } from '../i18n';

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

const input = {
  backgroundColor: colors.panel2, color: colors.text, borderRadius: 8,
  paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, borderWidth: 1, borderColor: colors.line,
} as const;

// ------------------------------------------------------------- F1 passport
export function PassportSection({ actor }: { actor: Actor }) {
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
      <SectionTitle>🛂 {pt('passport')}</SectionTitle>
      <Muted size={12}>{pt('provenance')}</Muted>
      {pp.summary.insufficient && (
        <View style={{ backgroundColor: colors.panel2, borderRadius: 8, padding: 8, marginTop: 6 }}>
          <Muted size={12}>⚠️ {pt('insufficient')}</Muted>
        </View>
      )}
      {pp.records.map((r) => (
        <View key={r.id} style={{ marginTop: 8, opacity: r.superseded ? 0.5 : 1 }}>
          <Row style={{ flexWrap: 'wrap' }}>
            <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13, flex: 1 }}>
              {r.label}{r.value != null ? ` — ${r.value}${r.units ? ` ${r.units}` : ''}` : ''}
            </Text>
            <Pill label={r.verification.status.replace('_', ' ')} tone={toneFor(r.verification.status)} />
          </Row>
          <Muted size={11.5}>
            {r.verification.method ?? ''}{r.verification.reviewerName ? ` · ${r.verification.reviewerName}` : ''}
            {r.superseded ? ' · superseded' : ''}{r.correctionOf ? ' · correction' : ''} · {pFmtDate(r.recordedAt)}
          </Muted>
        </View>
      ))}
      {pp.legacy.map((l, i) => (
        <View key={i} style={{ marginTop: 8 }}>
          <Row><Text style={{ color: colors.text, fontSize: 13, flex: 1 }}>{l.label}</Text><Pill label={l.tier.replace('_', ' ')} tone={toneFor(l.tier)} /></Row>
          {l.caveat && <Muted size={11.5}>⚠︎ {l.caveat}</Muted>}
        </View>
      ))}
      <View style={{ marginTop: 10, gap: 6 }}>
        <TextInput style={input} placeholder="Claim (e.g. Assists this season)" placeholderTextColor={colors.muted}
          accessibilityLabel="Evidence claim label" value={label} onChangeText={setLabel} />
        <Row>
          <TextInput style={[input, { flex: 1 }]} placeholder="Value" placeholderTextColor={colors.muted}
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
  const [board, reload] = useLoad<{ items: BoardItem[]; minor?: boolean; note?: string | null }>(
    () => (actor.kind === 'player' ? m12.getBoard(actor.id) : m12.gBoard(actor.id, actor.childId)),
    [actor.id]
  );
  const [msg, setMsg] = useState<string | null>(null);
  if (!board) return null;
  return (
    <Card>
      <SectionTitle>📋 {pt('board')}</SectionTitle>
      {board.note && <Muted size={12}>{board.note}</Muted>}
      {board.items.map((o: BoardItem) => (
        <View key={o.id} style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 }}>
          <Row style={{ flexWrap: 'wrap' }}>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13.5, flex: 1 }}>{o.title}</Text>
            <Pill label={o.type.replace('_', ' ')} tone="blue" />
          </Row>
          <Muted size={12}>{o.orgName} · deadline {o.deadline}{o.distance ? ` · ${o.distance}` : ''}{o.schedule ? ` · ${o.schedule}` : ''}</Muted>
          {o.description && <Muted size={12}>{o.description}</Muted>}
          {(o.requirements ?? []).length > 0 && <Muted size={11.5}>Bring: {o.requirements!.join(' · ')}</Muted>}
          <Row style={{ marginTop: 6 }}>
            {o.applied ? (
              <>
                <Pill label={`${pt('applied')}: ${o.applied.status}`} tone={o.applied.status === 'accepted' ? 'green' : 'default'} />
                {o.applied.status === 'submitted' && o.applied.id && actor.kind === 'player' && (
                  <Button small label={pt('withdraw')} onPress={async () => { await m12.withdrawApplication(actor.id, o.applied!.id!); reload(); }} />
                )}
              </>
            ) : o.via === 'open_trial' ? (
              <Muted size={12}>Register through Open days on your Home tab.</Muted>
            ) : (
              <Button small primary label={pt('apply')} onPress={async () => {
                try {
                  if (actor.kind === 'player') await m12.applyToOpportunity(actor.id, o.id);
                  else await m12.gApply(actor.id, actor.childId, o.id);
                  setMsg('Application submitted — the club must answer it.');
                  reload();
                } catch (e) { setMsg(e instanceof Error ? e.message : 'Not eligible'); }
              }} />
            )}
          </Row>
        </View>
      ))}
      {board.items.length === 0 && <Muted size={12}>Nothing open near you right now.</Muted>}
      {msg && <View accessibilityLiveRegion="polite"><Muted size={12}>{msg}</Muted></View>}
      {actor.kind === 'player' && board.minor && <Muted size={12}>👨‍👩‍👧 {pt('guardianApplies')}</Muted>}
    </Card>
  );
}

// ----------------------------------------------------------- F6 campaigns
export function CampaignsSection({ actor, mediaOptions }: { actor: Actor; mediaOptions: { id: string; title: string }[] }) {
  const [camps, reload] = useLoad<CampaignView[]>(
    () => (actor.kind === 'player' ? m12.getCampaigns(actor.id) : m12.gCampaigns(actor.id, actor.childId)),
    [actor.id]
  );
  const [msg, setMsg] = useState<string | null>(null);
  if (!camps || camps.length === 0) return null;
  return (
    <Card>
      <SectionTitle>🎬 {pt('campaigns')}</SectionTitle>
      <Muted size={12}>{pt('fileVsHuman')}</Muted>
      {camps.map((c) => (
        <View key={c.id} style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13.5 }}>{c.title}</Text>
          <Muted size={12}>{c.orgName} · deadline {c.deadline} · {c.attemptsAllowed} attempts</Muted>
          {c.drills.map((d, i) => (
            <View key={i} style={{ marginTop: 6 }}>
              <Text style={{ color: colors.text, fontSize: 12.5 }}>{d.name}: {d.instructions}</Text>
              <Muted size={11.5}>📹 {pt('recording')}: {Object.values(d.recording).join(' · ')}</Muted>
            </View>
          ))}
          {(c.mySubmission?.attempts ?? []).map((a) => (
            <View key={a.id} style={{ marginTop: 6 }}>
              <Row><Muted size={12}>{a.drillName}</Muted><Pill label={a.status.replace('_', ' ')} tone={a.status === 'accepted' ? 'green' : a.status === 'returned' || a.status === 'failed_checks' ? 'red' : 'blue'} /></Row>
              {!a.fileChecks.passed && <Muted size={11.5}>File check: {a.fileChecks.issues.join('; ')}</Muted>}
              {a.review?.reasons && <Muted size={11.5}>↩️ Coach: {a.review.reasons}</Muted>}
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
        <Button key={m.id} small primary={mediaId === m.id} label={`📎 ${m.title.slice(0, 18)}`} onPress={() => setMediaId(m.id)} />
      ))}
      <Button small primary label={pt('submitAttempt')} onPress={async () => {
        try {
          const r = actor.kind === 'player'
            ? await m12.submitCampaignAttempt(actor.id, campaign.id, mediaId, campaign.drills[0]?.name ?? 'drill')
            : await m12.gSubmitCampaignAttempt(actor.id, actor.childId, campaign.id, mediaId, campaign.drills[0]?.name ?? 'drill');
          onDone(r.status === 'submitted' ? '✅ File checks passed — now waiting for a HUMAN coach review.' : `File checks failed: ${r.issues.join('; ')}`);
        } catch (e) { onDone(e instanceof Error ? e.message : 'Failed'); }
      }} />
    </Row>
  );
}

// -------------------------------------------- F2 feedback + F8 development
export function FeedbackDevSection({ actor }: { actor: Actor }) {
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
      <SectionTitle>📋 {pt('feedback')} & {pt('objectives')}</SectionTitle>
      {fb?.guardianManaged ? (
        <Muted size={12}>Your parent/guardian holds {fb.count} published feedback note{(fb.count ?? 0) === 1 ? '' : 's'} from clubs — ask them to go through it with you.</Muted>
      ) : (
        (fb?.items ?? []).map((f) => (
          <View key={f.id} style={{ marginTop: 8 }}>
            <Muted size={12}>{f.orgName} · {f.byName} · {pFmtDate(f.at)}</Muted>
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
          </View>
        ))
      )}
      {(objectives ?? []).map((o) => (
        <View key={o.id} style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 }}>
          {o.objectives.map((x) => <Text key={x.id} style={{ color: colors.text, fontWeight: '600', fontSize: 13 }}>🎯 {x.text}</Text>)}
          <Muted size={12}>with {o.reviewer.name}{o.reviewer.orgName ? ` · ${o.reviewer.orgName}` : ''} · {o.progress.length} progress entries</Muted>
          {o.reassessments.map((r) => (
            <Muted key={r.id} size={12}>🔁 reassessment {r.status}{r.outcome ? ` — ${r.outcome.note}` : ''}</Muted>
          ))}
          <Row style={{ marginTop: 6, flexWrap: 'wrap' }}>
            <TextInput style={[input, { flex: 1, minWidth: 120 }]} placeholder={pt('logProgress')} placeholderTextColor={colors.muted}
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
        </View>
      ))}
      {msg && <View accessibilityLiveRegion="polite"><Muted size={12}>{msg}</Muted></View>}
    </Card>
  );
}

// ---------------------------------------------------------- F9 trial days
export function TrialSafetySection({ actor }: { actor: Actor }) {
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
      <SectionTitle>🛡️ {pt('trialDay')}</SectionTitle>
      {trials.map((tr) => (
        <View key={tr.id} style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 }}>
          <Row><Text style={{ color: colors.text, fontWeight: '700', fontSize: 13.5, flex: 1 }}>{tr.orgName ?? tr.playerName}</Text>
            {tr.cancelled ? <Pill label="cancelled" tone="red" /> : <Pill label={tr.proposedDate ?? 'TBC'} />}</Row>
          {tr.staff.map((s, i) => (
            <Row key={i}><Muted size={12}>{s.name} · {s.role}</Muted>
              <Pill label={s.check.status === 'reviewed' ? 'check reviewed' : `check ${s.check.status}`} tone={s.check.status === 'reviewed' ? 'green' : 'gold'} /></Row>
          ))}
          {tr.arrival?.address && <Muted size={12}>📍 {tr.arrival.time ?? ''} · {tr.arrival.address}</Muted>}
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
            <TextInput style={[input, { flex: 1, minWidth: 100 }]} placeholder="Contact name" placeholderTextColor={colors.muted} accessibilityLabel="Emergency contact name" value={emName} onChangeText={setEmName} />
            <TextInput style={[input, { flex: 1, minWidth: 100 }]} placeholder="Phone" placeholderTextColor={colors.muted} accessibilityLabel="Emergency contact phone" value={emPhone} onChangeText={setEmPhone} />
            <Button small label={pt('emergency').split(' (')[0]} onPress={async () => {
              if (!emName || !emPhone) return;
              try {
                if (actor.kind === 'player') await m12.setEmergencyContact(actor.id, tr.id, emName, emPhone);
                else await m12.gSetEmergencyContact(actor.id, tr.id, emName, emPhone);
                setMsg('Held for the event’s safety staff only — never on your profile.');
              } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
            }} />
          </Row>
        </View>
      ))}
      {packView && (
        <View style={{ marginTop: 10, backgroundColor: colors.panel2, borderRadius: 10, padding: 10 }}>
          <Row><Text style={{ color: colors.gold, fontWeight: '700', fontSize: 13, flex: 1 }}>Safety pack</Text>
            <Button small label="✕" onPress={() => setPackView(null)} /></Row>
          <Muted size={12}>{packView.pack.headline}</Muted>
          <Muted size={12}>{packView.pack.checksExplained}</Muted>
          {packView.pack.collection && <Muted size={12}>🚸 {packView.pack.collection.policy}</Muted>}
          <Muted size={12}>{packView.pack.reportRoute}</Muted>
          {packView.pack.feedbackDue && <Muted size={12}>Club feedback due by {packView.pack.feedbackDue} — it is mandatory.</Muted>}
        </View>
      )}
      {msg && <View accessibilityLiveRegion="polite"><Muted size={12}>{msg}</Muted></View>}
    </Card>
  );
}

// ------------------------------------------------------- F10 squad invites
export function SquadInvitesSection({ actor }: { actor: Actor }) {
  const [invites, reload] = useLoad<SquadInvite[]>(
    () => (actor.kind === 'player' ? m12.getSquadInvites(actor.id) : m12.gSquadInvites(actor.id)),
    [actor.id]
  );
  if (!invites || invites.length === 0) return null;
  return (
    <Card>
      <SectionTitle>🏟️ {pt('squadInvites')}</SectionTitle>
      {invites.map((i) => (
        <View key={i.id} style={{ marginTop: 6 }}>
          <Text style={{ color: colors.text, fontSize: 13 }}>{i.orgName} invites {actor.kind === 'guardian' ? i.playerName : 'you'} to their squad list{i.note ? ` — “${i.note}”` : ''}.</Text>
          <Row style={{ marginTop: 4 }}>
            <Button small primary label={pt('accept')} onPress={async () => {
              if (actor.kind === 'player') await m12.respondSquadInvite(actor.id, i.id, true);
              else await m12.gRespondSquadInvite(actor.id, i.id, true);
              reload();
            }} />
            <Button small label={pt('decline')} onPress={async () => {
              if (actor.kind === 'player') await m12.respondSquadInvite(actor.id, i.id, false);
              else await m12.gRespondSquadInvite(actor.id, i.id, false);
              reload();
            }} />
          </Row>
        </View>
      ))}
    </Card>
  );
}

// ---------------------------------------------------------- F11 follow-ups
export function FollowUpsSection({ actor }: { actor: Actor }) {
  const [ups, reload] = useLoad<FollowUpView[]>(
    () => (actor.kind === 'player' ? m12.getFollowUps(actor.id) : m12.gFollowUps(actor.id)),
    [actor.id]
  );
  const answerable = (ups ?? []).filter((f) => f.report);
  if (answerable.length === 0) return null;
  return (
    <Card>
      <SectionTitle>📈 {pt('followUps')}</SectionTitle>
      {answerable.map((f) => (
        <View key={f.id} style={{ marginTop: 6 }}>
          <Text style={{ color: colors.text, fontSize: 13 }}>
            {f.orgName ?? 'The club'} · {f.milestone}: “{f.report!.registrationStatus}{f.report!.progression ? ` — ${f.report!.progression}` : ''}”
          </Text>
          {f.outcomeState === 'reported' ? (
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
          ) : <Pill label={f.outcomeState} tone={f.outcomeState === 'confirmed' ? 'green' : 'red'} />}
        </View>
      ))}
    </Card>
  );
}

// -------------------------------------- F12 access & inclusion (You tab)
export function AccessSection({ playerId, mediaOptions, isMinor }: { playerId: string; mediaOptions: { id: string; title: string }[]; isMinor: boolean }) {
  const [lang, setLangState] = useState(getPLang());
  const [saver, setSaver] = useState(getDataSaver());
  const [msg, setMsg] = useState<string | null>(null);
  const [vtt, setVtt] = useState('');
  return (
    <Card>
      <SectionTitle>♿ Access & language</SectionTitle>
      <Row>
        <Text style={{ color: colors.text, fontSize: 13, flex: 1 }}>{pt('language')}</Text>
        <Button small primary={lang === 'en'} label="EN" onPress={() => { setPLang('en'); setLangState('en'); }} />
        <Button small primary={lang === 'fr'} label="FR" onPress={() => { setPLang('fr'); setLangState('fr'); }} />
      </Row>
      <Muted size={11.5}>{pt('machineNote')}</Muted>
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
          <TextInput style={[input, { minHeight: 60, marginTop: 4 }]} multiline placeholder={'WEBVTT\n\n00:00.000 --> 00:04.000\n…'}
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
    setStatus(`✅ Upload finalised — media ${r.mediaId}. (Success is only reported AFTER integrity checks.)`);
    setSession(null); setPending(null); onDone();
  }, [playerId, onDone]);

  const pausedRef = { current: paused };
  const getPaused = () => pausedRef.current;
  pausedRef.current = paused;

  if (Platform.OS !== 'web') {
    return <Card><SectionTitle>⤴️ {pt('uploadLarge')}</SectionTitle><Muted size={12}>Resumable uploads are verified on web; native file access ships with the store builds.</Muted></Card>;
  }
  return (
    <Card>
      <SectionTitle>⤴️ {pt('uploadLarge')}</SectionTitle>
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
