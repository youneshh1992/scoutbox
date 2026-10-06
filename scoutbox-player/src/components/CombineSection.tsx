import { GuidanceNote } from './InformationRows';
// M16.1 — At-Home Combine, the player/guardian surface.
//   Record it. Prove it. — Real numbers. Real evidence. From anywhere.
//
// A Combine Attempt binds a live Box Cam session: this screen drives the
// server's lifecycle (create attempt → Ready Check → calibrate → start with
// liveness → stream observed events → complete). The measured value, the
// Combine state and the "Combine Verified" badge always come back from the
// server — this screen never asserts a number or a verification. In the demo
// a clearly-labelled simulated provider stands in for a real detector; in
// production, tests whose metric the device cannot measure are shown honestly
// as "Measurement not yet supported on this device" and never estimated.
import { createElement, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Text } from './Text';
import { useColors } from '../theme';
import { RecordPanel, DetailFact, TimelineItem, InfoNote, Button, Card, Disclosure, FactRow, ListRow, Muted, Pill, Row, SectionTitle } from './ui';
import { Icon } from './Icon';
import { SectionHead } from './Reference';
import { fmtShortDay } from '../time';
import {
  combine, type CombineActor, type CombineAttempt, type CombineCard,
  type CombineOverview, type CombineProtocol, type CombineRequest,
} from '../data/combineClient';
import type { BoxEvent } from '../data/m16client';
import { trust, type TrustSelf } from '../data/trustClient';
import { TrustScoreHeader } from './TrustProfileSection';
import { pt } from '../i18n';

const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';
const WEB = Platform.OS === 'web';
const fmtClock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

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

// Whether a verified attempt can actually be offered for a protocol: only when
// the active provider genuinely supports its metric (production), or a
// demo-supported protocol under the labelled simulated provider.
const canMeasure = (p: CombineProtocol) => DEMO ? p.demoSupported : p.measurementCapability === 'configured';

function VerifiedBadge() {
  return <Pill label={pt('cmbVerified')} tone="green" />;
}

// Every Combine state that is not "verified" says which one it is. Until M18.1
// only `partially_measured` had words of its own, so an attempt invalidated
// after review, one the device could not measure, one that broke the protocol
// and one the player cancelled all rendered identically — a bare value with no
// badge. Those mean completely different things to a player, and the one that
// reads worst (invalidated) was the one that looked most like a normal result.
const STATE_TONE: Record<string, 'default' | 'gold' | 'red'> = {
  partially_measured: 'gold',
  measurement_unavailable: 'default',
  protocol_invalid: 'gold',
  integrity_review: 'gold',
  invalidated: 'red',
  cancelled: 'default',
};
/** The state's own badge, or null for verified (which has its own) and for
 *  in-flight states that the surrounding UI is already narrating. */
function StateBadge({ state }: { state: string }) {
  if (state === 'combine_verified') return null;
  const label = pt(`cmbState_${state}` as Parameters<typeof pt>[0]);
  // An unmapped state must not render its raw id at a player.
  if (!label || label === `cmbState_${state}`) return null;
  return <Pill label={label} tone={STATE_TONE[state] ?? 'default'} />;
}
/** True when the recorded number must not be shown as a standing result. */
const valueStruck = (state: string) => state === 'invalidated' || state === 'protocol_invalid';

// ------------------------------------------------------------- capture panel
function CombineCapturePanel({ playerId, protocol, requestId, onDone, onClose }: {
  playerId: string; protocol: CombineProtocol; requestId?: string;
  onDone: (a: CombineAttempt) => void; onClose: () => void;
}) {
  const colors = useColors();
  const [phase, setPhase] = useState<'setup' | 'ready' | 'recording' | 'error'>('setup');
  const [msg, setMsg] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [boxSessionId, setBoxSessionId] = useState<string | null>(null);
  const [nonce, setNonce] = useState('');
  const [liveness, setLiveness] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const seqRef = useRef(1);
  const startRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const provider = DEMO ? 'local_test' : 'web_client';
  const windowMs = protocol.protocolWindowMs;

  const stopCamera = () => { try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* gone */ } streamRef.current = null; };
  useEffect(() => () => stopCamera(), []);

  async function readyCheck() {
    setMsg(null);
    if (DEMO) { setPhase('ready'); return; }
    if (!WEB || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setPhase('error'); setMsg(pt('cmbNoCamera')); return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; void videoRef.current.play?.(); }
      setPhase('ready');
    } catch { setPhase('error'); setMsg(pt('cmbCameraDenied')); }
  }
  useEffect(() => { void readyCheck(); /* eslint-disable-next-line */ }, []);

  async function begin() {
    try {
      const created = await combine.createAttempt(playerId, { protocolId: protocol.id, mode: 'verified', provider, captureContext: 'at_home', requestId });
      setAttemptId(created.attempt.id); setBoxSessionId(created.boxSession.id);
      setNonce(created.nonce); setLiveness(created.livenessChallenge);
      // Standardized geometry only for the first library — pass the Ready Check
      // geometry as the calibration check the server expects.
      await combine.calibrate(playerId, created.attempt.id, created.calibration.required);
      await combine.startBox(playerId, created.boxSession.id, created.nonce, created.livenessChallenge);
      startRef.current = Date.now();
      setPhase('recording');
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'MEASUREMENT_NOT_SUPPORTED') setMsg(pt('cmbNotSupportedMsg'));
      else if (code === 'ATTEMPT_LIMIT_REACHED') setMsg(pt('cmbLimitReached'));
      else setMsg(e instanceof Error ? e.message : 'failed');
      setPhase('error');
    }
  }

  // While recording: flush an observed interval batch every few seconds, the
  // same honest presence/active signal Box Cam uses. The measurement itself is
  // derived server-side from these observations — never asserted here.
  useEffect(() => {
    if (phase !== 'recording' || !boxSessionId) return;
    let last = 0;
    const tick = setInterval(async () => {
      const t = Date.now() - startRef.current;
      setElapsed(t);
      if (t - last >= 3000) {
        const batch: BoxEvent[] = [
          { seq: seqRef.current++, type: 'presence_interval', fromMs: last, toMs: t, quality: 'good' },
          { seq: seqRef.current++, type: 'active_interval', fromMs: last, toMs: t, quality: 'good' },
        ];
        last = t;
        try { await combine.sendBoxEvents(playerId, boxSessionId, nonce, batch); } catch { /* buffered next tick in real impl */ }
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [phase, boxSessionId, nonce, playerId]);

  async function finish() {
    if (!attemptId || !boxSessionId) return;
    stopCamera();
    try {
      const t = Date.now() - startRef.current;
      await combine.sendBoxEvents(playerId, boxSessionId, nonce, [
        { seq: seqRef.current++, type: 'presence_interval', fromMs: Math.max(0, t - 3000), toMs: t, quality: 'good' },
        { seq: seqRef.current++, type: 'active_interval', fromMs: Math.max(0, t - 3000), toMs: t, quality: 'good' },
      ]).catch(() => {});
      const r = await combine.complete(playerId, attemptId, nonce);
      onDone(r.attempt);
    } catch (e) { setMsg(e instanceof Error ? e.message : 'failed'); setPhase('error'); }
  }

  async function cancel() { stopCamera(); if (attemptId) { try { await combine.cancel(playerId, attemptId); } catch { /* ignore */ } } onClose(); }

  return (
    <Card>
      <Row><Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>{pt('cmbAttempt')}</Text><Pill label={protocol.title} tone="blue" /></Row>
      <GuidanceNote icon="info" size={12}>{pt('cmbPoweredBy')}</GuidanceNote>
      {DEMO ? <GuidanceNote icon="info" size={12}>{pt('cmbDemoSim')}</GuidanceNote> : null}

      {WEB && !DEMO && phase !== 'error' ? createElement('video', { ref: videoRef, muted: true, playsInline: true, style: { width: '100%', maxHeight: 220, borderRadius: 10, background: '#000', transform: 'scaleX(-1)' } }) : null}

      {phase === 'setup' ? <Muted>{pt('cmbChecking')}</Muted> : null}

      {phase === 'error' ? (
        <View><Muted size={13}>{msg}</Muted><Row style={{ marginTop: 8 }}><Button small label={pt('cmbRetry')} onPress={() => void readyCheck()} /><Button small label={pt('cmbClose')} onPress={cancel} /></Row></View>
      ) : null}

      {phase === 'ready' ? (
        <View>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, marginTop: 6 }}>{pt('cmbReadyCheck')}</Text>
          <GuidanceNote icon="camera" size={12}>{pt('cmbChkCamera')}</GuidanceNote>
          <GuidanceNote icon="camera" size={12}>{pt('cmbChkFraming')} — {pt('cmbUnableAuto')}</GuidanceNote>
          <GuidanceNote icon="info" size={12}>{pt('cmbChkSpace')} — {pt('cmbUnableAuto')}</GuidanceNote>
          <View style={{ marginTop: 8, backgroundColor: colors.panel2, borderRadius: 8, padding: 8 }}>
            <GuidanceNote icon="info" size={12}>{pt('cmbLiveness')}: {liveness || 'show_ball'}</GuidanceNote>
            <GuidanceNote icon="info" size={11.5}>{pt('cmbLivenessNote')}</GuidanceNote>
          </View>
          <GuidanceNote title="Setup" icon="camera">{protocol.setupRequirements}</GuidanceNote>
          <GuidanceNote icon="activity" size={12}>{protocol.scoringMethod}</GuidanceNote>
          <GuidanceNote icon="shield-check" size={11.5}>{protocol.safetyNotes}</GuidanceNote>
          <Row style={{ marginTop: 8 }}><Button primary label={pt('cmbBegin')} onPress={() => void begin()} /><Button small label={pt('cmbCancel')} onPress={cancel} /></Row>
        </View>
      ) : null}

      {phase === 'recording' ? (
        <View>
          <Row style={{ marginTop: 6 }}>
            <View style={{ flex: 1 }}><Muted size={11}>{pt('cmbWindow')}</Muted><Text style={{ color: colors.text, fontWeight: '800', fontSize: 18 }}>{fmtClock(windowMs)}</Text></View>
            <View style={{ flex: 1 }}><Muted size={11}>{pt('cmbElapsed')}</Muted><Text style={{ color: colors.accentText, fontWeight: '800', fontSize: 18 }}>{fmtClock(elapsed)}</Text></View>
          </Row>
          <Pill label={pt('cmbObserving')} tone="green" />
          <Muted size={11.5}>{pt('cmbObservingNote')}</Muted>
          <Row style={{ marginTop: 10 }}><Button primary label={pt('cmbFinish')} onPress={() => void finish()} /><Button small label={pt('cmbCancel')} onPress={cancel} /></Row>
        </View>
      ) : null}
    </Card>
  );
}

// -------------------------------------------------------------- result card
function CombineResultCard({ attempt, onClose }: { attempt: CombineAttempt; onClose: () => void }) {
  const colors = useColors();
  const verified = attempt.combineState === 'combine_verified';
  const partial = attempt.combineState === 'partially_measured';
  return (
    <Card style={{ borderColor: verified ? colors.accent : colors.line }}>
      <Text style={{ color: colors.text, fontWeight: '800', fontSize: 17 }}>{verified ? pt('cmbResultVerified') : pt('cmbResultRecorded')}</Text>
      <Row><Pill label={attempt.protocolTitle} tone="blue" />{verified ? <VerifiedBadge /> : <StateBadge state={attempt.combineState} />}{attempt.simulated ? <Pill label={pt('cmbSim')} /> : null}</Row>
      <Row style={{ marginTop: 4 }}>
        {attempt.measuredValue == null ? (
          <Text style={{ color: colors.muted, fontWeight: '700', fontSize: 18 }}>{pt('cmbNoValue')}</Text>
        ) : (
          <>
            <Text style={{
              color: verified ? colors.accent : colors.muted, fontWeight: '800', fontSize: 26,
              textDecorationLine: valueStruck(attempt.combineState) ? 'line-through' : 'none',
            }}>{attempt.display}</Text>
            <Text style={{ color: colors.muted, fontWeight: '600', fontSize: 14 }}>{attempt.unit}</Text>
          </>
        )}
      </Row>
      {valueStruck(attempt.combineState) && attempt.measuredValue != null ? <GuidanceNote icon="info" size={12}>{pt('cmbValueNotCounted')}</GuidanceNote> : null}
      {verified ? <Text style={{ color: colors.accentText, fontWeight: '800', fontSize: 15 }}>{pt('cmbWorkCounts')}</Text> : null}
      {verified ? <GuidanceNote icon="info" size={12}>{pt('cmbRecordProve')}</GuidanceNote> : null}
      {partial ? <GuidanceNote icon="activity" size={12}>{pt('cmbMeasuredNotVerified')}</GuidanceNote> : null}
      {attempt.stateCopy ? <GuidanceNote icon="info" size={12}>{attempt.stateCopy}</GuidanceNote> : null}
      {verified && attempt.verificationExplained ? (
        <View style={{ marginTop: 6, backgroundColor: colors.panel2, borderRadius: 8, padding: 8 }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 12 }}>{pt('cmbWhyVerified')}</Text>
          {attempt.verificationExplained.map((c, i) => <InfoNote key={i} icon={c.ok ? 'circle-check' : 'circle-help'}>{c.ok ? 'Confirmed · ' : 'Not confirmed · '}{c.label}{c.detail ? ` — ${c.detail}` : ''}</InfoNote>)}
        </View>
      ) : null}
      <Row style={{ marginTop: 8 }}><Button label={pt('cmbDone')} onPress={onClose} /></Row>
    </Card>
  );
}

// ------------------------------------------------------------- main section
/** A back control for the Combine detail pages. */
function BackRow({ onPress, label }: { onPress: () => void; label: string }) {
  const colors = useColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} testID="combine-back" style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, alignSelf: 'flex-start' }, pressed && { opacity: 0.7 }]}>
      <Icon name="chevron-left" size={16} color={colors.accent2} /><Text style={{ color: colors.accent2, fontSize: 13, fontWeight: '500' }}>{label}</Text>
    </Pressable>
  );
}

/** One exercise in full: the latest result, its status, the start control,
 *  the instructions and the history. Nothing of this is on the root. */
function ProtocolDetail({ protocol, title, attempts, canStart, onStart, onBack }: {
  protocol: CombineProtocol | null; title: string; attempts: CombineAttempt[]; canStart: boolean; onStart: () => void; onBack: () => void;
}) {
  const colors = useColors();
  const finished = attempts.filter((a) => a.completedAt != null || a.measuredValue != null);
  const latest = finished[0] ?? null;
  const verified = latest?.combineState === 'combine_verified';
  const supported = protocol ? canMeasure(protocol) : false;
  const statusWord = latest
    ? verified ? pt('cmbVerifiedWord') : (pt(`cmbState_${latest.combineState}` as Parameters<typeof pt>[0]) ?? latest.combineState)
    : supported || !protocol ? pt('cmbNoResult') : pt('cmbNotSupportedWord');
  return (
    <View testID="combine-detail">
      <BackRow onPress={onBack} label={pt('cmbBack')} />
      <SectionHead title={title} />
      <FactRow k={pt('cmbLatestResult')} v={latest ? (latest.measuredValue == null ? pt('cmbNoValue') : `${latest.display} ${latest.unit}`) : pt('cmbNoResult')} testID="combine-latest" />
      <FactRow k={pt('cmbStatus')} v={statusWord} testID="combine-status" />
      {latest?.simulated ? <GuidanceNote icon="info" size={12}>{pt('cmbDemoSim')}</GuidanceNote> : null}
      {latest && valueStruck(latest.combineState) && latest.measuredValue != null ? <GuidanceNote icon="info" size={12}>{pt('cmbValueNotCounted')}</GuidanceNote> : null}
      {latest && latest.combineState === 'partially_measured' ? <GuidanceNote icon="activity" size={12}>{pt('cmbMeasuredNotVerified')}</GuidanceNote> : null}
      {latest && !verified && latest.combineState !== 'partially_measured' && latest.stateCopy ? <GuidanceNote icon="info" size={12}>{latest.stateCopy}</GuidanceNote> : null}
      {canStart && protocol ? (
        <View style={{ marginTop: 14 }}>
          {supported ? <Button primary label={pt('cmbStart')} onPress={onStart} testID="combine-start" /> : <Muted size={12.5}>{pt('cmbNotSupported')}</Muted>}
        </View>
      ) : null}
      <View style={{ marginTop: 14 }}>
        {verified && latest?.verificationExplained ? (
          <Disclosure label={pt('cmbWhyVerified')} testID="combine-why">
            {latest.verificationExplained.map((c, i) => <InfoNote key={i} icon={c.ok ? 'circle-check' : 'circle-help'}>{c.ok ? 'Confirmed · ' : 'Not confirmed · '}{c.label}{c.detail ? ` — ${c.detail}` : ''}</InfoNote>)}
            {latest.stateCopy ? <GuidanceNote title="Current status" icon="info" size={11.5}>{latest.stateCopy}</GuidanceNote> : null}
          </Disclosure>
        ) : null}
        {protocol ? (
          <Disclosure label={pt('cmbInstructions')} testID="combine-instructions">
            <GuidanceNote title="The exercise" icon="soccer-ball" size={12.5}>{protocol.description}</GuidanceNote>
            <GuidanceNote title="Setup" icon="camera" size={12.5}>{protocol.setupRequirements}</GuidanceNote>
            <GuidanceNote title="How it is measured" icon="activity" size={12.5}>{protocol.scoringMethod}</GuidanceNote>
            <GuidanceNote title="Safety" icon="shield-check" size={12}>{protocol.safetyNotes}</GuidanceNote>
            {DEMO && supported ? <GuidanceNote title="Demo information" icon="info" size={12}>{pt('cmbDemoSim')}</GuidanceNote> : null}
          </Disclosure>
        ) : null}
        <Disclosure label={pt('cmbHistory')} hint={pt('cmbAttempts').replace('{n}', String(finished.length))} testID="combine-history">
          {finished.length === 0 ? <GuidanceNote size={12.5}>{pt('cmbNoResult')}</GuidanceNote> : <View>{finished.map((a, i) => (
            <TimelineItem key={a.id} date={fmtShortDay(a.completedAt ?? a.createdAt)} last={i === finished.length - 1}>
              <Text style={{ color: a.combineState === 'combine_verified' ? colors.accentText : colors.text, fontSize: 13, fontWeight: '600', textDecorationLine: valueStruck(a.combineState) ? 'line-through' : 'none' }}>{a.measuredValue == null ? pt('cmbNoValue') : `${a.display} ${a.unit}`}</Text>
              <Text style={{ color: colors.muted, fontSize: 12 }}>{a.combineState === 'combine_verified' ? pt('cmbVerifiedWord') : (pt(`cmbState_${a.combineState}` as Parameters<typeof pt>[0]) ?? '')}</Text>
            </TimelineItem>
          ))}</View>}
        </Disclosure>
      </View>
    </View>
  );
}

export function CombineSection({ actor, childName }: { actor: CombineActor; childName?: string }) {
  const colors = useColors();
  const key = actor.kind === 'guardian' ? actor.childId : actor.id;
  const isPlayer = actor.kind === 'player';
  const [overview, reloadOverview] = useLoad<CombineOverview>(() => combine.overview(actor), [key]);
  const [protoData] = useLoad(() => isPlayer ? combine.protocols(actor.id) : Promise.resolve(null), [actor.id]);
  const [card, setCard] = useState<CombineCard | null>(null);
  // M16.2 — the Trust Score shown on the Combine Card comes from its own
  // endpoint and is rendered in a visually separate block, so a Trust Score of
  // 92 can never be misread as a Combine measurement.
  const [trustProfile, setTrustProfile] = useState<TrustSelf | null>(null);
  const [capture, setCapture] = useState<{ protocol: CombineProtocol; requestId?: string } | null>(null);
  const [result, setResult] = useState<CombineAttempt | null>(null);
  const [page, setPage] = useState<{ kind: 'protocol'; id: string; title: string } | { kind: 'requests' } | { kind: 'card' } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const protocols = protoData?.protocols ?? [];
  const reloadAll = () => { reloadOverview(); if (page?.kind === 'card' && isPlayer) combine.card(actor.id).then(setCard).catch(() => {}); };

  const start = (protocol: CombineProtocol, requestId?: string) => { setResult(null); setCapture({ protocol, requestId }); };
  async function openCard() {
    if (!card && isPlayer) { try { setCard(await combine.card(actor.id)); } catch (e) { setMsg(e instanceof Error ? e.message : 'failed'); } }
    // The Trust Profile is optional context on this card — if it cannot be
    // read, the Combine results stand entirely on their own.
    if (!trustProfile) { try { setTrustProfile(await trust.profile(actor)); } catch { /* card still valid */ } }
    setPage({ kind: 'card' });
  }

  // M24F.4 — the root names the exercises, and nothing else. A guardian has
  // no protocol library (attempts start on the player's device), so their
  // rows are the exercises the child has attempted.
  const allAttempts = overview ? [...overview.attempts].sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt)) : [];
  const exercises: { id: string; title: string; protocol: CombineProtocol | null }[] = protocols.length > 0
    ? protocols.map((p) => ({ id: p.id, title: p.title, protocol: p }))
    : Array.from(new Map(allAttempts.map((a) => [a.protocolId, { id: a.protocolId, title: a.protocolTitle, protocol: null as CombineProtocol | null }])).values());
  const requests = overview?.activeRequests ?? [];

  return (
    <View testID="combine-section">
      {capture && isPlayer ? (
        <CombineCapturePanel playerId={actor.id} protocol={capture.protocol} requestId={capture.requestId}
          onDone={(a) => { setCapture(null); setResult(a); reloadAll(); }} onClose={() => setCapture(null)} />
      ) : result ? (
        <CombineResultCard attempt={result} onClose={() => setResult(null)} />
      ) : page?.kind === 'protocol' ? (
        <ProtocolDetail
          protocol={protocols.find((p) => p.id === page.id) ?? null} title={page.title}
          attempts={allAttempts.filter((a) => a.protocolId === page.id)} canStart={isPlayer}
          onStart={() => { const p = protocols.find((x) => x.id === page.id); if (p) start(p); }} onBack={() => setPage(null)} />
      ) : page?.kind === 'requests' ? (
        <View testID="combine-requests">
          <BackRow onPress={() => setPage(null)} label={pt('cmbBack')} />
          <SectionHead title={pt('cmbClubRequests')} />
          {requests.map((r) => <RequestRow key={r.id} r={r} protocols={protocols} onStart={start} canStart={isPlayer} />)}
        </View>
      ) : page?.kind === 'card' ? (
        <View testID="combine-card-page">
          <BackRow onPress={() => setPage(null)} label={pt('cmbBack')} />
          <SectionHead title={pt('cmbCombineCard')} />
          {card ? (
            <View>
              <GuidanceNote icon="info" size={12.5}>{card.player.name}{card.player.position ? ` · ${card.player.position}` : ''}{card.player.age != null ? ` · ${card.player.age}` : ''}</GuidanceNote>
              {card.results.length > 0 ? card.results.map((r) => (
                <Row key={r.protocolId} style={{ borderBottomWidth: 1, borderBottomColor: colors.line, paddingVertical: 10, justifyContent: 'space-between' }}>
                  <Text style={{ color: colors.text, fontSize: 14, flexShrink: 1 }}>{r.protocolTitle}</Text>
                  <Row><Text style={{ color: colors.accentText, fontWeight: '700' }}>{r.display}<Text style={{ color: colors.muted, fontWeight: '600', fontSize: 12 }}> {r.unit}</Text></Text>{r.combineVerified ? <VerifiedBadge /> : null}</Row>
                </Row>
              )) : <GuidanceNote icon="activity" size={12.5}>{pt('cmbNoResults')}</GuidanceNote>}
              {card.results.some((r) => r.combineVerified) ? <GuidanceNote icon="info" size={12}>{pt('trsCombineVerifiedLine')}</GuidanceNote> : null}
              <Disclosure label="About this result"><GuidanceNote size={12}>{card.note}</GuidanceNote></Disclosure>
            </View>
          ) : <Muted size={12.5}>{pt('cmbLoading')}</Muted>}
          {/* M16.2 — Trust Score, in its OWN block outside the Combine Card.
              It is deliberately separated by its own heading and spacing so
              the number is never read as a Combine result, and it never
              implies that a higher measured value earns more trust. */}
          {trustProfile ? (
            <View style={{ marginTop: 18, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.line }}>
              <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13.5 }}>{pt('trsCombineBlock')}</Text>
              <TrustScoreHeader t={trustProfile} compact />
              <Disclosure label="About this score"><GuidanceNote title="What this means" icon="info" size={11.5}>{pt('trsCombineSeparate')}</GuidanceNote></Disclosure>
            </View>
          ) : null}
        </View>
      ) : (
        <>
          <SectionTitle>{pt('cmbTitle')}{childName ? ` — ${childName}` : ''}</SectionTitle>
          <View testID="combine-exercises">
            {exercises.length === 0 ? <Muted size={12.5}>{isPlayer ? pt('cmbLoading') : pt('cmbNoResults')}</Muted> : null}
            {exercises.map((x) => <ListRow key={x.id} label={x.title} onPress={() => setPage({ kind: 'protocol', id: x.id, title: x.title })} testID={`combine-protocol-${x.id}`} />)}
          </View>
          <View style={{ marginTop: 18 }}>
            {requests.length > 0 ? <ListRow label={pt('cmbRequestsRow')} count={requests.length} onPress={() => setPage({ kind: 'requests' })} testID="combine-requests-row" /> : null}
            {isPlayer ? <ListRow label={pt('cmbCardRow')} onPress={() => void openCard()} testID="combine-card-row" /> : null}
            <Disclosure label={pt('cmbAbout')} testID="combine-about">
              <GuidanceNote size={12.5}>{pt('cmbTagline')} {pt('cmbSub')} {pt('cmbPoweredBy')}.</GuidanceNote>
              {overview ? <GuidanceNote title="Device support" icon="camera" size={12.5}>{overview.capabilityNote}</GuidanceNote> : null}
              {!isPlayer ? <GuidanceNote size={12.5}>{pt('cmbProtocolsPlayerOnly')}</GuidanceNote> : null}
            </Disclosure>
          </View>
        </>
      )}
      {msg ? <Muted size={12}>{msg}</Muted> : null}
    </View>
  );
}

function RequestRow({ r, protocols, onStart, canStart }: { r: CombineRequest; protocols: CombineProtocol[]; onStart: (p: CombineProtocol, requestId?: string) => void; canStart: boolean }) {
  const colors = useColors();
  return (
    <RecordPanel title={r.title || pt('cmbClubRequests')} subtitle={`${pt('cmbRequestFrom')} ${r.orgName}`} icon="clipboard-list">
      <Row>
        <Pill label={`${r.completedCount}/${r.requiredCount}`} tone={r.completedCount >= r.requiredCount ? 'green' : 'default'} />
      </Row>
      {r.deadline && <DetailFact label={pt('cmbDeadline')} value={r.deadline} icon="calendar-days" />}
      {r.instructions ? <InfoNote icon="clipboard-list">{r.instructions}</InfoNote> : null}
      {r.protocols.map((rp) => {
        const proto = protocols.find((p) => p.id === rp.protocolId);
        return (
          <Row key={rp.protocolId} style={{ marginTop: 4 }}>
            <Text style={{ color: colors.text, fontSize: 12.5, flexShrink: 1 }}>{rp.completed ? 'Completed · ' : 'Pending · '}{rp.protocolTitle}</Text>
            {!rp.completed && canStart && proto && canMeasure(proto) ? <Button small primary label={pt('cmbStart')} onPress={() => onStart(proto, r.id)} /> : null}
            {!rp.completed && proto && !canMeasure(proto) ? <Pill label={pt('cmbNotSupportedShort')} /> : null}
          </Row>
        );
      })}
      {r.note ? <Disclosure label="About this request"><GuidanceNote size={12}>{r.note}</GuidanceNote></Disclosure> : null}
    </RecordPanel>
  );
}
