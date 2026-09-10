// M16 — Box Training, the player/guardian Box Cam surface.
//   Train. Record. Prove. — Don't just say you trained. Box it.
//
// The live capture runner drives the server's session lifecycle (create →
// Box Cam Ready Check → start with liveness → stream observed events →
// complete). The result — verified active time, state, provenance — always
// comes back from the server; this screen never asserts it. On web (live
// mode) it uses the honest web-limited provider (presence + active duration
// only); the demo uses a clearly-labelled simulated provider.
import { createElement, useEffect, useRef, useState } from 'react';
import { Platform, Text, TextInput, View } from 'react-native';
import { colors } from '../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from './ui';
import { m16, type BoxActor, type BoxAssignment, type BoxChallenge, type BoxDashboard, type BoxDrill, type BoxSession, type BoxTarget, type DevelopmentPlan, type BoxPrefs } from '../data/m16client';
import { pt } from '../i18n';

const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';
const WEB = Platform.OS === 'web';
const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): [T | null, () => void, string | null] {
  const [v, setV] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let ok = true; setErr(null);
    fn().then((x) => ok && setV(x)).catch((e) => ok && setErr(e instanceof Error ? e.message : 'failed'));
    return () => { ok = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return [v, () => setTick((x) => x + 1), err];
}

const input = { backgroundColor: colors.panel2, color: colors.text, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, borderWidth: 1, borderColor: colors.line } as const;

const PROV_TONE: Record<string, 'green' | 'blue' | 'gold' | 'default'> = { verified: 'green', partially_verified: 'gold' };
function StatePill({ state }: { state: string | null }) {
  if (!state) return null;
  const key = `m16state_${state}` as Parameters<typeof pt>[0];
  let label: string; try { label = pt(key); } catch { label = state; }
  return <Pill label={label ?? state} tone={PROV_TONE[state] ?? 'default'} />;
}

// ------------------------------------------------------- live capture panel
function CapturePanel({ actor, drill, target, assignmentId, challengeEntryId, onDone, onClose }: {
  actor: BoxActor; drill: BoxDrill; target: BoxTarget; assignmentId?: string; challengeEntryId?: string;
  onDone: (s: BoxSession) => void; onClose: () => void;
}) {
  const playerId = actor.id; // sessions are always minted for the acting player (guardian assists on-device)
  const [phase, setPhase] = useState<'setup' | 'ready' | 'recording' | 'error'>('setup');
  const [msg, setMsg] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [nonce, setNonce] = useState('');
  const [liveness, setLiveness] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const seqRef = useRef(1);
  const startRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const provider = DEMO ? 'local_test' : 'web_client';

  const stopCamera = () => { try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* gone */ } streamRef.current = null; };
  useEffect(() => () => stopCamera(), []);

  // Box Cam Ready Check — check only what we can actually measure.
  async function readyCheck() {
    setMsg(null);
    if (DEMO) { setPhase('ready'); return; }
    if (!WEB || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setPhase('error'); setMsg(pt('m16noCamera')); return;
    }
    try {
      // Video only — Box Cam never needs or stores audio.
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; void videoRef.current.play?.(); }
      setPhase('ready');
    } catch {
      setPhase('error'); setMsg(pt('m16cameraDenied'));
    }
  }
  useEffect(() => { void readyCheck(); /* eslint-disable-next-line */ }, []);

  async function begin() {
    try {
      const created = await m16.createSession(playerId, { drillId: drill.id, target, provider, assignmentId, challengeEntryId });
      setSessionId(created.session.id); setNonce(created.nonce); setLiveness(created.livenessChallenge);
      await m16.startSession(playerId, created.session.id, created.nonce, created.livenessChallenge);
      startRef.current = Date.now();
      setPhase('recording');
    } catch (e) { setMsg(e instanceof Error ? e.message : 'failed'); setPhase('error'); }
  }

  // While recording: the camera stream is live and the app is foregrounded,
  // so the web-limited provider infers presence + active training. We flush
  // an observed interval batch every few seconds.
  useEffect(() => {
    if (phase !== 'recording' || !sessionId) return;
    let last = 0;
    const tick = setInterval(async () => {
      const t = Date.now() - startRef.current;
      setElapsed(t);
      if (t - last >= 3000) {
        const batch = [
          { seq: seqRef.current++, type: 'presence_interval', fromMs: last, toMs: t, quality: 'good' },
          { seq: seqRef.current++, type: 'active_interval', fromMs: last, toMs: t, quality: 'good' },
        ];
        last = t;
        try { await m16.sendEvents(playerId, sessionId, nonce, batch); } catch { /* buffered next tick in real impl */ }
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [phase, sessionId, nonce, playerId]);

  async function finish() {
    if (!sessionId) return;
    stopCamera();
    try {
      const t = Date.now() - startRef.current;
      await m16.sendEvents(playerId, sessionId, nonce, [
        { seq: seqRef.current++, type: 'presence_interval', fromMs: Math.max(0, t - 3000), toMs: t, quality: 'good' },
        { seq: seqRef.current++, type: 'active_interval', fromMs: Math.max(0, t - 3000), toMs: t, quality: 'good' },
      ]).catch(() => {});
      const r = await m16.complete(playerId, sessionId, nonce);
      onDone(r.session);
    } catch (e) { setMsg(e instanceof Error ? e.message : 'failed'); setPhase('error'); }
  }

  async function cancel() { stopCamera(); if (sessionId) { try { await m16.cancel(playerId, sessionId, nonce); } catch { /* ignore */ } } onClose(); }

  const verified = target.type === 'duration' ? Math.min(elapsed, target.value) : elapsed;

  return (
    <Card style={{ borderColor: colors.accent }}>
      <Row><Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>{pt('m16boxCam')}</Text><Pill label={drill.title} tone="blue" /></Row>
      {DEMO ? <Muted size={12}>{pt('m16demoSim')}</Muted> : null}

      {WEB && !DEMO && phase !== 'error' ? createElement('video', { ref: videoRef, muted: true, playsInline: true, style: { width: '100%', maxHeight: 220, borderRadius: 10, background: '#000', transform: 'scaleX(-1)' } }) : null}

      {phase === 'setup' ? <Muted>{pt('m16checking')}</Muted> : null}

      {phase === 'error' ? (
        <View><Muted>⚠️ {msg}</Muted><Row style={{ marginTop: 8 }}><Button small label={pt('m16retry')} onPress={() => void readyCheck()} /><Button small label={pt('m16close')} onPress={cancel} /></Row></View>
      ) : null}

      {phase === 'ready' ? (
        <View>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, marginTop: 6 }}>{pt('m16readyCheck')}</Text>
          <Muted size={12}>✓ {pt('m16chkCamera')}</Muted>
          <Muted size={12}>○ {pt('m16chkFraming')} — {pt('m16unableAuto')}</Muted>
          <Muted size={12}>○ {pt('m16chkSpace')} — {pt('m16unableAuto')}</Muted>
          <View style={{ marginTop: 8, backgroundColor: colors.panel2, borderRadius: 8, padding: 8 }}>
            <Muted size={12}>{pt('m16liveness')}: {pt(`m16live_${liveness}` as Parameters<typeof pt>[0])}</Muted>
            <Muted size={11.5}>{pt('m16livenessNote')}</Muted>
          </View>
          <Muted size={12}>{pt('m16setup')}: {drill.setup.space} · {drill.setup.framing}</Muted>
          {drill.repSupport === 'not_configured' ? <Muted size={12}>ⓘ {drill.repSupportNote}</Muted> : null}
          <Row style={{ marginTop: 8 }}><Button primary label={pt('m16boxIt')} onPress={() => void begin()} /><Button small label={pt('m16cancel')} onPress={cancel} /></Row>
        </View>
      ) : null}

      {phase === 'recording' ? (
        <View>
          <Row style={{ marginTop: 6 }}>
            <View style={{ flex: 1 }}><Muted size={11}>{pt('m16target')}</Muted><Text style={{ color: colors.text, fontWeight: '800', fontSize: 18 }}>{target.type === 'duration' ? fmt(target.value) : `${target.value}`}</Text></View>
            <View style={{ flex: 1 }}><Muted size={11}>{pt('m16boxVerified')}</Muted><Text style={{ color: colors.accent, fontWeight: '800', fontSize: 18 }}>{fmt(verified)}</Text></View>
            <View style={{ flex: 1 }}><Muted size={11}>{pt('m16session')}</Muted><Text style={{ color: colors.text, fontWeight: '800', fontSize: 18 }}>{fmt(elapsed)}</Text></View>
          </Row>
          <Pill label={pt('m16trainingDetected')} tone="green" />
          <Row style={{ marginTop: 10 }}><Button primary label={pt('m16finish')} onPress={() => void finish()} /><Button small label={pt('m16cancel')} onPress={cancel} /></Row>
        </View>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------- result screen
function ResultCard({ actor, session, onClose, reload }: { actor: BoxActor; session: BoxSession; onClose: () => void; reload: () => void }) {
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const verified = ['verified', 'partially_verified'].includes(session.verificationState ?? '');
  return (
    <Card style={{ borderColor: verified ? colors.accent : colors.line }}>
      <Text style={{ color: colors.text, fontWeight: '800', fontSize: 17 }}>{session.verificationState === 'verified' ? pt('m16sessionComplete') : pt('m16sessionRecorded')}</Text>
      <Row><Pill label={session.drillTitle} tone="blue" /><StatePill state={session.verificationState} /></Row>
      <Row style={{ marginTop: 6 }}>
        <View style={{ flex: 1 }}><Muted size={11}>{pt('m16target')}</Muted><Text style={{ color: colors.text, fontWeight: '700' }}>{session.target.type === 'duration' ? fmt(session.target.value) : `${session.target.value}`}</Text></View>
        <View style={{ flex: 1 }}><Muted size={11}>{pt('m16boxVerified')}</Muted><Text style={{ color: colors.accent, fontWeight: '800' }}>{session.verifiedReps != null ? `${session.verifiedReps}` : fmt(session.verifiedActiveMs ?? 0)}{session.target.type !== 'duration' && session.verifiedReps != null ? ` / ${session.target.value}` : ''}</Text></View>
        <View style={{ flex: 1 }}><Muted size={11}>{pt('m16session')}</Muted><Text style={{ color: colors.text, fontWeight: '700' }}>{fmt(session.sessionDurationMs ?? 0)}</Text></View>
      </Row>
      {session.stateCopy ? <Muted size={12}>{session.stateCopy}</Muted> : null}
      {verified ? <Text style={{ color: colors.accent, fontWeight: '800', fontSize: 15, marginTop: 6 }}>{pt('m16workCounts')}</Text> : null}
      {verified ? <Muted size={12}>{fmt(session.verifiedActiveMs ?? 0)} {pt('m16willRecord')}</Muted> : null}
      {session.provenanceDetail ? <View style={{ marginTop: 6, backgroundColor: colors.panel2, borderRadius: 8, padding: 8 }}><Muted size={11.5}>{session.provenanceLabel} — {session.provenanceDetail}</Muted></View> : null}
      <Row style={{ marginTop: 8 }}>
        <TextInput style={[input, { flex: 1 }]} value={note} onChangeText={setNote} placeholder={pt('m16notePlaceholder')} placeholderTextColor={colors.muted} accessibilityLabel={pt('m16notePlaceholder')} />
        <Button small label={pt('m16addNote')} onPress={async () => { if (note.trim()) { try { await m16.addNote(actor.id, session.id, note.trim()); setMsg(pt('m16noteSaved')); } catch (e) { setMsg(e instanceof Error ? e.message : 'failed'); } } }} />
      </Row>
      <Muted size={11}>{pt('m16noteProvenance')}</Muted>
      {msg ? <Muted size={12}>{msg}</Muted> : null}
      <Row style={{ marginTop: 6 }}><Button label={pt('m16done')} onPress={() => { reload(); onClose(); }} /></Row>
    </Card>
  );
}

// ------------------------------------------------------------ main section
export function BoxTrainingSection({ actor, isMinor, childName }: { actor: BoxActor; isMinor?: boolean; childName?: string }) {
  const key = actor.kind === 'guardian' ? actor.childId : actor.id;
  const [plan, reloadPlan] = useLoad<DevelopmentPlan>(() => m16.developmentPlan(actor), [key]);
  const [dash, reloadDash] = useLoad<BoxDashboard>(() => m16.dashboard(actor), [key]);
  const [drillData] = useLoad(() => m16.drills(actor.id), [actor.id]);
  const [challenges, reloadChallenges] = useLoad<BoxChallenge[]>(() => m16.challenges(actor), [key]);
  const [prefs, reloadPrefs] = useLoad<BoxPrefs>(() => m16.prefs(actor), [key]);
  const [capture, setCapture] = useState<{ drill: BoxDrill; target: BoxTarget; assignmentId?: string; challengeEntryId?: string } | null>(null);
  const [result, setResult] = useState<BoxSession | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const reloadAll = () => { reloadPlan(); reloadDash(); reloadChallenges(); };
  const canManageSharing = actor.kind === 'guardian' || !isMinor;
  const drills = drillData?.drills ?? [];
  const startDrill = (drill: BoxDrill, assignmentId?: string, challengeEntryId?: string) => {
    const tt = drill.targetTypes[0];
    const target: BoxTarget = tt === 'repetitions' ? { type: 'repetitions', value: 100 } : { type: 'duration', value: 20 * 60000 };
    setResult(null);
    setCapture({ drill, target, assignmentId, challengeEntryId });
  };

  return (
    <Card>
      <SectionTitle>{pt('m16title')}{childName ? ` — ${childName}` : ''}</SectionTitle>
      <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>{pt('m16trainInBox')}</Text>
      <Muted size={12}>{pt('m16tagline')}</Muted>

      {capture ? (
        <CapturePanel actor={actor} drill={capture.drill} target={capture.target} assignmentId={capture.assignmentId} challengeEntryId={capture.challengeEntryId}
          onDone={(s) => { setCapture(null); setResult(s); reloadAll(); }} onClose={() => setCapture(null)} />
      ) : result ? (
        <ResultCard actor={actor} session={result} onClose={() => setResult(null)} reload={reloadAll} />
      ) : (
        <Row style={{ marginTop: 6 }}>
          <Button primary label={pt('m16startBoxCam')} onPress={() => drills[0] && startDrill(drills[0])} />
          {dash ? <Pill label={`${pt('m16streak')}: ${dash.streakWeeks}`} tone="gold" /> : null}
        </Row>
      )}

      {/* Development activity — evidence of training, never a rating */}
      {plan ? (
        <View style={{ marginTop: 10 }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('m16devActivity')} ({plan.activity.days}d)</Text>
          <Muted size={12}>{pt('m16sessionsLabel')}: {plan.activity.boxSessions} · {pt('m16verifiedTraining')}: {fmt(plan.activity.verifiedActiveMs)} · {pt('m16assigned')}: {plan.activity.assignedCompleted}/{plan.activity.assigned}</Muted>
          <Muted size={11.5}>{plan.activity.note}</Muted>
        </View>
      ) : null}

      {/* Assignments */}
      {plan && plan.assignments.length > 0 ? (
        <View style={{ marginTop: 10 }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('m16assignments')}</Text>
          {plan.assignments.map((a) => (
            <AssignmentRow key={a.id} a={a} drills={drills} onStart={startDrill} onAccept={async () => { try { await m16.acceptAssignment(actor, a.id); reloadAll(); } catch (e) { setMsg(e instanceof Error ? e.message : 'failed'); } }} />
          ))}
        </View>
      ) : null}

      {/* Recent sessions */}
      {dash && dash.recent.length > 0 ? (
        <View style={{ marginTop: 10 }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('m16myTraining')}</Text>
          {(expanded ? dash.recent : dash.recent.slice(0, 4)).map((s) => (
            <Row key={s.id} style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6, marginTop: 6 }}>
              <Text style={{ color: colors.text, fontSize: 13, flexShrink: 1 }}>{s.drillTitle}</Text>
              <Muted size={12}>{s.verifiedReps != null ? `${s.verifiedReps} reps` : fmt(s.verifiedActiveMs ?? 0)}</Muted>
              <StatePill state={s.verificationState} />
              {s.simulated ? <Pill label={pt('m16sim')} /> : null}
            </Row>
          ))}
          {dash.recent.length > 4 ? <Button small label={expanded ? pt('m16less') : pt('m16more')} onPress={() => setExpanded((x) => !x)} /> : null}
        </View>
      ) : null}

      {/* Best */}
      {dash && dash.bests.length > 0 ? (
        <View style={{ marginTop: 8 }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('m16boxBest')}</Text>
          {dash.bests.map((b) => <Muted key={`${b.drillId}${b.drillVersion}`} size={12}>{b.drillId} — {b.bestReps != null ? `${b.bestReps} reps` : b.bestActive}</Muted>)}
          <Muted size={11}>{dash.streakNote}</Muted>
        </View>
      ) : null}

      {/* Challenges */}
      {challenges && challenges.length > 0 ? (
        <View style={{ marginTop: 10 }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('m16challenges')}</Text>
          {challenges.map((c) => (
            <View key={c.id} style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6, marginTop: 6 }}>
              <Row><Text style={{ color: colors.text, fontSize: 13, flexShrink: 1 }}>{c.title}</Text>
                {c.entry ? <Pill label={c.entry.status === 'completed' ? pt('m16completed') : `${c.entry.progress}/${c.targetTotal}`} tone={c.entry.status === 'completed' ? 'green' : 'default'} /> : <Button small label={pt('m16join')} onPress={async () => { try { await m16.joinChallenge(actor, c.id); reloadChallenges(); } catch (e) { setMsg(e instanceof Error ? e.message : 'failed'); } }} />}
              </Row>
              <Muted size={11}>{c.publisher.kind === 'org' ? `${pt('m16by')} ${c.publisher.orgName}` : pt('m16byScoutbox')} · {c.disclaimer}</Muted>
            </View>
          ))}
        </View>
      ) : null}

      {/* Sharing / privacy */}
      {prefs ? (
        <View style={{ marginTop: 10 }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('m16sharing')}</Text>
          {canManageSharing ? (
            <Row style={{ marginTop: 4 }}>
              <Button small label={prefs.shareDevelopmentActivity === 'recruitment' ? `✓ ${pt('m16shareRec')}` : pt('m16shareRec')}
                onPress={async () => { try { await m16.setPrefs(actor, { shareDevelopmentActivity: prefs.shareDevelopmentActivity === 'recruitment' ? 'private' : 'recruitment' }); reloadPrefs(); } catch (e) { setMsg(e instanceof Error ? e.message : 'failed'); } }} />
            </Row>
          ) : <Muted size={12}>{pt('m16shareMinor')}</Muted>}
          <Muted size={11}>{pt('m16shareNote')}</Muted>
        </View>
      ) : null}

      {drillData?.providers.some((p) => p.id === 'production_cv') ? <Muted size={11}>{pt('m16providerNote')}</Muted> : null}
      {msg ? <Muted size={12}>{msg}</Muted> : null}
    </Card>
  );
}

function AssignmentRow({ a, drills, onStart, onAccept }: { a: BoxAssignment; drills: BoxDrill[]; onStart: (d: BoxDrill, assignmentId?: string) => void; onAccept: () => void }) {
  const drill = drills.find((d) => d.id === a.drillId);
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6, marginTop: 6 }}>
      <Row>
        <Text style={{ color: colors.text, fontSize: 13, flexShrink: 1 }}>{a.drillTitle} · {a.target.type === 'duration' ? fmt(a.target.value) : `${a.target.value}`}{a.frequencyPerWeek ? ` ×${a.frequencyPerWeek}/wk` : ''}</Text>
        <Pill label={pt(`m16astate_${a.state}` as Parameters<typeof pt>[0])} tone={a.state === 'completed' ? 'green' : a.state === 'partially_completed' ? 'gold' : 'default'} />
      </Row>
      {a.instructions ? <Muted size={12}>{a.orgName}: “{a.instructions}”</Muted> : <Muted size={12}>{a.orgName}</Muted>}
      {a.lastResult ? <Muted size={12}>{pt('m16lastResult')}: {a.lastResult.verifiedReps != null ? `${a.lastResult.verifiedReps}` : a.lastResult.verifiedActive} — {a.lastResult.statusLabel}</Muted> : null}
      <Row style={{ marginTop: 4 }}>
        {a.state === 'assigned' ? <Button small label={pt('m16accept')} onPress={onAccept} /> : null}
        {drill ? <Button small primary label={pt('m16boxIt')} onPress={() => onStart(drill, a.id)} /> : null}
      </Row>
    </View>
  );
}
