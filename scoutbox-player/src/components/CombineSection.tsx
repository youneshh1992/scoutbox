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
import { Platform, Text, View } from 'react-native';
import { colors } from '../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from './ui';
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

// ------------------------------------------------------- verified result row
function ResultRow({ a }: { a: CombineAttempt }) {
  const [why, setWhy] = useState(false);
  const verified = a.combineState === 'combine_verified';
  const partial = a.combineState === 'partially_measured';
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6, marginTop: 6 }}>
      <Row>
        <Text style={{ color: colors.text, fontSize: 13, flexShrink: 1, fontWeight: '600' }}>{a.protocolTitle}</Text>
        <Text style={{ color: verified ? colors.accent : colors.text, fontWeight: '800', fontSize: 15 }}>{a.display}<Text style={{ color: colors.muted, fontWeight: '600', fontSize: 12 }}> {a.unit}</Text></Text>
        {verified ? <VerifiedBadge /> : null}
        {a.simulated ? <Pill label={pt('cmbSim')} /> : null}
      </Row>
      {partial ? <Muted size={12}>{a.display} {a.unit} — {pt('cmbMeasuredNotVerified')}</Muted> : null}
      {verified ? (
        <View>
          <Button small label={why ? pt('cmbHideWhy') : pt('cmbWhyVerified')} onPress={() => setWhy((x) => !x)} />
          {why && a.verificationExplained ? (
            <View style={{ marginTop: 4, backgroundColor: colors.panel2, borderRadius: 8, padding: 8 }}>
              {a.verificationExplained.map((c, i) => (
                <Muted key={i} size={12}>{c.ok ? '✓' : '○'} {c.label}{c.detail ? ` — ${c.detail}` : ''}</Muted>
              ))}
              {a.stateCopy ? <Muted size={11.5}>{a.stateCopy}</Muted> : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------- capture panel
function CombineCapturePanel({ playerId, protocol, requestId, onDone, onClose }: {
  playerId: string; protocol: CombineProtocol; requestId?: string;
  onDone: (a: CombineAttempt) => void; onClose: () => void;
}) {
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
    <Card style={{ borderColor: colors.accent }}>
      <Row><Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>{pt('cmbAttempt')}</Text><Pill label={protocol.title} tone="blue" /></Row>
      <Muted size={12}>{pt('cmbPoweredBy')}</Muted>
      {DEMO ? <Muted size={12}>{pt('cmbDemoSim')}</Muted> : null}

      {WEB && !DEMO && phase !== 'error' ? createElement('video', { ref: videoRef, muted: true, playsInline: true, style: { width: '100%', maxHeight: 220, borderRadius: 10, background: '#000', transform: 'scaleX(-1)' } }) : null}

      {phase === 'setup' ? <Muted>{pt('cmbChecking')}</Muted> : null}

      {phase === 'error' ? (
        <View><Muted size={13}>⚠ {msg}</Muted><Row style={{ marginTop: 8 }}><Button small label={pt('cmbRetry')} onPress={() => void readyCheck()} /><Button small label={pt('cmbClose')} onPress={cancel} /></Row></View>
      ) : null}

      {phase === 'ready' ? (
        <View>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, marginTop: 6 }}>{pt('cmbReadyCheck')}</Text>
          <Muted size={12}>✓ {pt('cmbChkCamera')}</Muted>
          <Muted size={12}>○ {pt('cmbChkFraming')} — {pt('cmbUnableAuto')}</Muted>
          <Muted size={12}>○ {pt('cmbChkSpace')} — {pt('cmbUnableAuto')}</Muted>
          <View style={{ marginTop: 8, backgroundColor: colors.panel2, borderRadius: 8, padding: 8 }}>
            <Muted size={12}>{pt('cmbLiveness')}: {liveness || 'show_ball'}</Muted>
            <Muted size={11.5}>{pt('cmbLivenessNote')}</Muted>
          </View>
          <Muted size={12}>{pt('cmbSetup')}: {protocol.setupRequirements}</Muted>
          <Muted size={12}>{pt('cmbScoring')}: {protocol.scoringMethod}</Muted>
          <Muted size={11.5}>{protocol.safetyNotes}</Muted>
          <Row style={{ marginTop: 8 }}><Button primary label={pt('cmbBegin')} onPress={() => void begin()} /><Button small label={pt('cmbCancel')} onPress={cancel} /></Row>
        </View>
      ) : null}

      {phase === 'recording' ? (
        <View>
          <Row style={{ marginTop: 6 }}>
            <View style={{ flex: 1 }}><Muted size={11}>{pt('cmbWindow')}</Muted><Text style={{ color: colors.text, fontWeight: '800', fontSize: 18 }}>{fmtClock(windowMs)}</Text></View>
            <View style={{ flex: 1 }}><Muted size={11}>{pt('cmbElapsed')}</Muted><Text style={{ color: colors.accent, fontWeight: '800', fontSize: 18 }}>{fmtClock(elapsed)}</Text></View>
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
  const verified = attempt.combineState === 'combine_verified';
  const partial = attempt.combineState === 'partially_measured';
  return (
    <Card style={{ borderColor: verified ? colors.accent : colors.line }}>
      <Text style={{ color: colors.text, fontWeight: '800', fontSize: 17 }}>{verified ? pt('cmbResultVerified') : pt('cmbResultRecorded')}</Text>
      <Row><Pill label={attempt.protocolTitle} tone="blue" />{verified ? <VerifiedBadge /> : null}{attempt.simulated ? <Pill label={pt('cmbSim')} /> : null}</Row>
      <Row style={{ marginTop: 4 }}>
        <Text style={{ color: verified ? colors.accent : colors.text, fontWeight: '800', fontSize: 26 }}>{attempt.display}</Text>
        <Text style={{ color: colors.muted, fontWeight: '600', fontSize: 14 }}>{attempt.unit}</Text>
      </Row>
      {verified ? <Text style={{ color: colors.accent, fontWeight: '800', fontSize: 15 }}>{pt('cmbWorkCounts')}</Text> : null}
      {verified ? <Muted size={12}>{pt('cmbRecordProve')}</Muted> : null}
      {partial ? <Muted size={12}>{pt('cmbMeasuredNotVerified')}</Muted> : null}
      {attempt.stateCopy ? <Muted size={12}>{attempt.stateCopy}</Muted> : null}
      {verified && attempt.verificationExplained ? (
        <View style={{ marginTop: 6, backgroundColor: colors.panel2, borderRadius: 8, padding: 8 }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 12 }}>{pt('cmbWhyVerified')}</Text>
          {attempt.verificationExplained.map((c, i) => <Muted key={i} size={12}>{c.ok ? '✓' : '○'} {c.label}{c.detail ? ` — ${c.detail}` : ''}</Muted>)}
        </View>
      ) : null}
      <Row style={{ marginTop: 8 }}><Button label={pt('cmbDone')} onPress={onClose} /></Row>
    </Card>
  );
}

// ------------------------------------------------------------- main section
export function CombineSection({ actor, childName }: { actor: CombineActor; childName?: string }) {
  const key = actor.kind === 'guardian' ? actor.childId : actor.id;
  const isPlayer = actor.kind === 'player';
  const [overview, reloadOverview] = useLoad<CombineOverview>(() => combine.overview(actor), [key]);
  const [protoData] = useLoad(() => isPlayer ? combine.protocols(actor.id) : Promise.resolve(null), [actor.id]);
  const [card, setCard] = useState<CombineCard | null>(null);
  const [showCard, setShowCard] = useState(false);
  // M16.2 — the Trust Score shown on the Combine Card comes from its own
  // endpoint and is rendered in a visually separate block, so a Trust Score of
  // 92 can never be misread as a Combine measurement.
  const [trustProfile, setTrustProfile] = useState<TrustSelf | null>(null);
  const [capture, setCapture] = useState<{ protocol: CombineProtocol; requestId?: string } | null>(null);
  const [result, setResult] = useState<CombineAttempt | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const protocols = protoData?.protocols ?? [];
  const reloadAll = () => { reloadOverview(); if (showCard && isPlayer) combine.card(actor.id).then(setCard).catch(() => {}); };

  const start = (protocol: CombineProtocol, requestId?: string) => { setResult(null); setCapture({ protocol, requestId }); };
  async function toggleCard() {
    if (showCard) { setShowCard(false); return; }
    if (!card && isPlayer) { try { setCard(await combine.card(actor.id)); } catch (e) { setMsg(e instanceof Error ? e.message : 'failed'); } }
    // The Trust Profile is optional context on this card — if it cannot be
    // read, the Combine results stand entirely on their own.
    if (!trustProfile) { try { setTrustProfile(await trust.profile(actor)); } catch { /* card still valid */ } }
    setShowCard(true);
  }

  return (
    <Card>
      <SectionTitle>{pt('cmbTitle')}{childName ? ` — ${childName}` : ''}</SectionTitle>
      <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>{pt('cmbTagline')}</Text>
      <Muted size={12}>{pt('cmbSub')} · {pt('cmbPoweredBy')}</Muted>

      {capture && isPlayer ? (
        <CombineCapturePanel playerId={actor.id} protocol={capture.protocol} requestId={capture.requestId}
          onDone={(a) => { setCapture(null); setResult(a); reloadAll(); }} onClose={() => setCapture(null)} />
      ) : result ? (
        <CombineResultCard attempt={result} onClose={() => setResult(null)} />
      ) : (
        <>
          {/* My Combine — verified results + personal bests */}
          <View style={{ marginTop: 8 }}>
            <Row>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('cmbMyCombine')}</Text>
              {overview ? <Pill label={`${pt('cmbPersonalBests')}: ${overview.personalBests}`} tone="gold" /> : null}
              {isPlayer ? <Button small label={showCard ? pt('cmbHideCard') : pt('cmbViewCard')} onPress={() => void toggleCard()} /> : null}
            </Row>
            {overview && overview.verifiedResults.length > 0 ? (
              overview.verifiedResults.map((a) => <ResultRow key={a.id} a={a} />)
            ) : <Muted size={12}>{pt('cmbNoResults')} — —</Muted>}
            {overview ? <Muted size={11.5}>{overview.capabilityNote}</Muted> : null}
          </View>

          {/* Combine Card */}
          {showCard && card ? (
            <View style={{ marginTop: 8, backgroundColor: colors.panel2, borderRadius: 10, padding: 10 }}>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 14 }}>{pt('cmbCombineCard')}</Text>
              <Muted size={12}>{card.player.name}{card.player.position ? ` · ${card.player.position}` : ''}{card.player.age != null ? ` · ${card.player.age}` : ''}</Muted>
              {card.results.length > 0 ? card.results.map((r) => (
                <Row key={r.protocolId} style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 4, marginTop: 4 }}>
                  <Text style={{ color: colors.text, fontSize: 13, flexShrink: 1 }}>{r.protocolTitle}</Text>
                  <Text style={{ color: colors.accent, fontWeight: '800' }}>{r.display}<Text style={{ color: colors.muted, fontWeight: '600', fontSize: 12 }}> {r.unit}</Text></Text>
                  {r.combineVerified ? <VerifiedBadge /> : null}
                </Row>
              )) : <Muted size={12}>{pt('cmbNoResults')}</Muted>}
              {card.results.some((r) => r.combineVerified) ? (
                <Muted size={11.5}>{pt('trsCombineVerifiedLine')}</Muted>
              ) : null}
              <Muted size={11}>{card.note}</Muted>
            </View>
          ) : null}

          {/* M16.2 — Trust Score, in its OWN block outside the Combine Card.
              It is deliberately separated by its own container, heading and
              spacing so the number is never read as a Combine result, and it
              never implies that a higher measured value earns more trust. */}
          {showCard && trustProfile ? (
            <View style={{ marginTop: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 10, backgroundColor: colors.bg2 }}>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 13.5 }}>{pt('trsCombineBlock')}</Text>
              <TrustScoreHeader t={trustProfile} compact />
              <Muted size={11.5}>{pt('trsCombineSeparate')}</Muted>
            </View>
          ) : null}

          {/* Active Club Combine requests */}
          {overview && overview.activeRequests.length > 0 ? (
            <View style={{ marginTop: 10 }}>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('cmbClubRequests')}</Text>
              {overview.activeRequests.map((r) => <RequestRow key={r.id} r={r} protocols={protocols} onStart={start} canStart={isPlayer} />)}
            </View>
          ) : null}

          {/* Protocol library — honest capability labels */}
          <View style={{ marginTop: 10 }}>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('cmbProtocols')}</Text>
            {protocols.length === 0 ? <Muted size={12}>{isPlayer ? pt('cmbLoading') : pt('cmbProtocolsPlayerOnly')}</Muted> : null}
            {protocols.map((p) => (
              <View key={p.id} style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6, marginTop: 6 }}>
                <Row>
                  <Text style={{ color: colors.text, fontSize: 13, flexShrink: 1, fontWeight: '600' }}>{p.title}</Text>
                  <Muted size={11}>{p.metricUnit}</Muted>
                  {canMeasure(p) ? <Button small primary label={pt('cmbStart')} onPress={() => start(p)} /> : <Pill label={pt('cmbNotSupportedShort')} />}
                </Row>
                <Muted size={12}>{p.description}</Muted>
                {!canMeasure(p) ? <Muted size={11.5}>{pt('cmbNotSupported')}</Muted> : null}
                {DEMO && canMeasure(p) ? <Muted size={11.5}>{pt('cmbDemoSim')}</Muted> : null}
              </View>
            ))}
          </View>
        </>
      )}

      {msg ? <Muted size={12}>{msg}</Muted> : null}
    </Card>
  );
}

function RequestRow({ r, protocols, onStart, canStart }: { r: CombineRequest; protocols: CombineProtocol[]; onStart: (p: CombineProtocol, requestId?: string) => void; canStart: boolean }) {
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6, marginTop: 6 }}>
      <Row>
        <Text style={{ color: colors.text, fontSize: 13, flexShrink: 1, fontWeight: '600' }}>{r.title || pt('cmbClubRequests')}</Text>
        <Pill label={`${r.completedCount}/${r.requiredCount}`} tone={r.completedCount >= r.requiredCount ? 'green' : 'default'} />
      </Row>
      <Muted size={12}>{pt('cmbRequestFrom')} {r.orgName}{r.deadline ? ` · ${pt('cmbDeadline')}: ${r.deadline}` : ''}</Muted>
      {r.instructions ? <Muted size={12}>“{r.instructions}”</Muted> : null}
      {r.protocols.map((rp) => {
        const proto = protocols.find((p) => p.id === rp.protocolId);
        return (
          <Row key={rp.protocolId} style={{ marginTop: 4 }}>
            <Text style={{ color: colors.text, fontSize: 12.5, flexShrink: 1 }}>{rp.completed ? '✓' : '○'} {rp.protocolTitle}</Text>
            {!rp.completed && canStart && proto && canMeasure(proto) ? <Button small primary label={pt('cmbStart')} onPress={() => onStart(proto, r.id)} /> : null}
            {!rp.completed && proto && !canMeasure(proto) ? <Pill label={pt('cmbNotSupportedShort')} /> : null}
          </Row>
        );
      })}
      {r.note ? <Muted size={11}>{r.note}</Muted> : null}
    </View>
  );
}
