// M22 — Box Cam CV: Ready Check, live attempt, result (§76–§84).
//
// THE COPY DECISION THIS COMPONENT IS BUILT AROUND
//
// Two facts must reach the player at the same time, and neither may hide the
// other:
//
//   Box Cam observation ready       yes
//   Combine verification            not yet available for this protocol
//
// Those are different claims with different evidence bars, and the second is
// not a failure — it is the honest state of a measurement that has not been
// validated against real football yet. So it is rendered as a neutral,
// explained state beside the first, never as an error, never in red, and never
// only in a footnote someone has to scroll for.
//
// §79 is the other half: the engine does produce an exact count, and it is
// genuinely interesting, but it is NOT the player-facing result. It appears
// under an explicit "experimental" heading, after the real outcome, with its
// status attached — or not at all if the product later decides it confuses
// more than it informs.

import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Card, Muted, Pill, Row } from './ui';
import { colors } from '../theme';
import { pt } from '../i18n';
import { m22, captureGray8, releaseCaptureSurface } from '../data/m22client';
import type { CvFinalize, ReadyCheckItem, ReadyCheckResult } from '../data/m22client';

const WEB = typeof document !== 'undefined';

/** Capture geometry — inside FRAME_LIMITS, and small on purpose (§9, §11). */
const CAP_W = 240;
const CAP_H = 180;
const CAP_FPS = 12;
const BATCH = 6;

type Phase = 'ready_check' | 'ready' | 'capturing' | 'finalizing' | 'done' | 'refused' | 'error';

/** §49 — the client maps structure to copy. The server never sends a sentence. */
function checkLabel(id: string): string {
  return pt(`m22chk_${id}` as Parameters<typeof pt>[0]) || id;
}
function reasonLabel(code: string | null): string {
  if (!code) return '';
  return pt(`m22reason_${code}` as Parameters<typeof pt>[0]) || code;
}
const stateGlyph = (s: ReadyCheckItem['state']) => (s === 'pass' ? '✓' : s === 'fail' ? '✗' : '○');

export function M22BoxCamCv({
  playerId, sessionId, nonce, protocolId, onClose,
}: {
  playerId: string; sessionId: string; nonce: string; protocolId: string; onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('ready_check');
  const [checks, setChecks] = useState<ReadyCheckResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [captureState, setCaptureState] = useState<'idle' | 'sending' | 'degraded'>('idle');
  const [dropped, setDropped] = useState(0);
  const [outcome, setOutcome] = useState<CvFinalize | null>(null);
  // §81 — a technical failure and an observation refusal are different things,
  // so they are different PHASES ('error' vs 'refused') with different copy.
  //
  // The underlying error message is deliberately NOT held in state: §88 keeps
  // server internals away from the client, and the player-facing copy is
  // generic on purpose ("this is a problem on our side"). Storing a message
  // nothing renders would only invite someone to render it later.
  const [showExperimental, setShowExperimental] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const providerSessionRef = useRef<string | null>(null);
  const seqRef = useRef(1);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const captureRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingRef = useRef<ReturnType<typeof captureGray8>[]>([]);
  const startedAtRef = useRef(0);

  /** §52 — one place that releases everything, called on every exit path. */
  const teardown = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (captureRef.current) { clearInterval(captureRef.current); captureRef.current = null; }
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    // Drop any frames that never made it to the wire. They are the only place
    // pixel data could linger in this component, so they are cleared here
    // rather than left for GC.
    pendingRef.current.length = 0;
    releaseCaptureSurface();
  }, []);

  useEffect(() => teardown, [teardown]);

  // ------------------------------------------------------- Ready Check

  const runReadyCheck = useCallback(async () => {
    setPhase('ready_check');
    let cameraPermission = 'unknown';
    let frameWidth = 0, frameHeight = 0, fps = 0;
    try {
      if (WEB && navigator?.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
          audio: false,   // §91 — audio is never requested, let alone analysed
        });
        streamRef.current = stream;
        cameraPermission = 'granted';
        const track = stream.getVideoTracks()[0];
        const s = track?.getSettings?.() ?? {};
        frameWidth = CAP_W; frameHeight = CAP_H;
        fps = Number(s.frameRate ?? 24);
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => {}); }
      }
    } catch (e) {
      // §50 — the permission states, distinguished rather than collapsed.
      const name = (e as { name?: string })?.name ?? '';
      cameraPermission = name === 'NotAllowedError' ? 'denied'
        : name === 'NotReadableError' ? 'in_use'
          : name === 'NotFoundError' ? 'unavailable'
            : WEB && !window.isSecureContext ? 'insecure_context' : 'unavailable';
    }

    try {
      const r = await m22.readyCheck(playerId, {
        protocolId,
        cameraPermission,
        secureContext: WEB ? window.isSecureContext : true,
        frameWidth: frameWidth || CAP_W,
        frameHeight: frameHeight || CAP_H,
        fps: fps || CAP_FPS,
      });
      setChecks(r);
      setPhase('ready');
    } catch {
      setPhase('error');
    }
  }, [playerId, protocolId]);

  useEffect(() => { void runReadyCheck(); }, [runReadyCheck]);

  // ---------------------------------------------------------- capturing

  async function flush(force = false) {
    const queue = pendingRef.current;
    if (!providerSessionRef.current) return;
    if (!force && queue.length < BATCH) return;
    const batch = queue.splice(0, BATCH).filter(Boolean) as NonNullable<ReturnType<typeof captureGray8>>[];
    if (!batch.length) return;
    setCaptureState('sending');
    try {
      const r = await m22.sendFrames(playerId, sessionId, nonce, providerSessionRef.current, batch);
      if (r.droppedByServer > 0) { setDropped(r.droppedByServer); setCaptureState('degraded'); }
      else setCaptureState('idle');
    } catch {
      // A dropped batch is not a player-facing error: the server accounts for
      // what it did not receive, and observation quality reflects it honestly.
      setCaptureState('degraded');
    }
  }

  async function begin() {
    try {
      const b = await m22.begin(playerId, sessionId, nonce, protocolId);
      providerSessionRef.current = b.providerSessionId;
      seqRef.current = 1;
      startedAtRef.current = Date.now();
      setPhase('capturing');
      timerRef.current = setInterval(() => setElapsed(Date.now() - startedAtRef.current), 250);
      captureRef.current = setInterval(() => {
        const v = videoRef.current;
        if (!v) return;
        const f = captureGray8(v, seqRef.current, CAP_W, CAP_H);
        if (!f) return;
        seqRef.current += 1;
        pendingRef.current.push(f);
        void flush();
      }, Math.round(1000 / CAP_FPS));
    } catch {
      setPhase('error');
    }
  }

  async function finish() {
    setPhase('finalizing');
    if (captureRef.current) { clearInterval(captureRef.current); captureRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    try {
      await flush(true);
      const r = await m22.finalize(playerId, sessionId, nonce, providerSessionRef.current ?? '');
      setOutcome(r);
      setPhase(r.result.outcome === 'accepted' ? 'done' : 'refused');
    } catch {
      setPhase('error');
    } finally {
      teardown();
    }
  }

  async function cancel() {
    teardown();
    if (providerSessionRef.current) {
      try { await m22.cancel(playerId, sessionId, nonce, providerSessionRef.current); } catch { /* ignore */ }
    }
    onClose();
  }

  // ------------------------------------------------------------- render

  const secs = Math.floor(elapsed / 1000);
  const timer = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;

  /**
   * §76/§78 — the two-fact block. Rendered wherever the player could otherwise
   * conclude that a successful observation means a verified measurement.
   */
  const combineNotice = (available: boolean, reason?: { short: string; detail: string } | null) => (
    <View
      style={{ marginTop: 8, backgroundColor: colors.panel2, borderRadius: 8, padding: 10 }}
      // §82 — one live region for the status pair, so a screen reader announces
      // the whole claim rather than two fragments that separately mislead.
      accessible
      accessibilityRole="summary"
      accessibilityLabel={
        available
          ? pt('m22combineAvailable')
          : `${pt('m22combineTitle')}: ${reason?.short ?? pt('m22combineUnavailable')}. ${reason?.detail ?? ''}`
      }
    >
      <Row>
        <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('m22combineTitle')}</Text>
        <Pill label={available ? pt('m22available') : pt('m22notYet')} tone={available ? 'green' : 'default'} />
      </Row>
      {!available ? (
        <>
          <Muted size={12}>{reason?.short ?? pt('m22combineUnavailable')}</Muted>
          <Muted size={11.5}>{reason?.detail ?? pt('m22validationPending')}</Muted>
        </>
      ) : null}
    </View>
  );

  return (
    <Card style={{ borderColor: colors.accent }}>
      <Row>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>{pt('m22title')}</Text>
        <Pill label={protocolId} tone="blue" />
      </Row>
      <Muted size={12}>{pt('m22whatThisIs')}</Muted>

      {WEB && phase !== 'done' && phase !== 'refused' ? createElement('video', {
        ref: videoRef, muted: true, playsInline: true,
        'aria-label': pt('m22videoLabel'),
        style: { width: '100%', maxHeight: 220, borderRadius: 10, background: '#000', transform: 'scaleX(-1)' },
      }) : null}

      {/* ---------------------------------------------------- Ready Check */}
      {phase === 'ready_check' ? (
        <View accessibilityLiveRegion="polite"><Muted>{pt('m22checking')}</Muted></View>
      ) : null}

      {phase === 'ready' && checks ? (
        <View>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, marginTop: 8 }}>{pt('m22readyCheck')}</Text>
          {/* §82 — a list, each row labelled for a screen reader in full. */}
          <View accessibilityRole="list">
            {checks.checks.map((c) => (
              <Muted key={c.id} size={12}>
                <Text
                  accessibilityRole="text"
                  accessibilityLabel={`${checkLabel(c.id)}: ${pt(`m22state_${c.state}` as Parameters<typeof pt>[0])}${c.reasonCode ? `. ${reasonLabel(c.reasonCode)}` : ''}`}
                >
                  {stateGlyph(c.state)} {checkLabel(c.id)}
                  {c.state === 'unknown' ? ` — ${pt('m22unableAuto')}` : ''}
                  {c.reasonCode ? ` — ${reasonLabel(c.reasonCode)}` : ''}
                </Text>
              </Muted>
            ))}
          </View>

          <Row style={{ marginTop: 8 }}>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('m22observationTitle')}</Text>
            <Pill
              label={checks.observationReady ? pt('m22ready') : pt('m22notReady')}
              tone={checks.observationReady ? 'green' : 'red'}
            />
          </Row>

          {/* §48/§76 — the distinction, side by side, always. */}
          {combineNotice(checks.combineVerificationAvailable, checks.combineDisabledReason)}

          <Row style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <Button primary disabled={!checks.observationReady} label={pt('m22start')} onPress={() => void begin()} />
            <Button small label={pt('m22recheck')} onPress={() => void runReadyCheck()} />
            <Button small label={pt('m22cancel')} onPress={() => void cancel()} />
          </Row>
        </View>
      ) : null}

      {/* ----------------------------------------------------- capturing */}
      {phase === 'capturing' ? (
        <View>
          {/* §77 — protocol, timer, capture status, provider status. No live
              count: the server has not finished deciding, and a number that
              moves during an attempt reads as a score being kept. */}
          <Row style={{ marginTop: 8 }}>
            <Text
              style={{ color: colors.text, fontWeight: '800', fontSize: 22 }}
              accessibilityLiveRegion="polite"
              accessibilityLabel={`${pt('m22elapsed')} ${secs} ${pt('m22seconds')}`}
            >
              {timer}
            </Text>
            <Pill
              label={captureState === 'degraded' ? pt('m22captureDegraded') : pt('m22capturing')}
              tone={captureState === 'degraded' ? 'gold' : 'green'}
            />
          </Row>
          <Muted size={12}>{pt('m22noLiveCount')}</Muted>
          {dropped > 0 ? <Muted size={11.5}>{pt('m22someFramesDropped')}</Muted> : null}
          <Row style={{ marginTop: 10 }}>
            <Button primary label={pt('m22finish')} onPress={() => void finish()} />
            <Button small label={pt('m22cancel')} onPress={() => void cancel()} />
          </Row>
        </View>
      ) : null}

      {phase === 'finalizing' ? (
        <View accessibilityLiveRegion="polite"><Muted>{pt('m22finalizing')}</Muted></View>
      ) : null}

      {/* -------------------------------------------------------- result */}
      {phase === 'done' && outcome ? (
        <View accessibilityLiveRegion="polite">
          <Row style={{ marginTop: 8 }}>
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>
              {outcome.boxCamObserved.eligible ? pt('m22observed') : pt('m22notObserved')}
            </Text>
            <Pill label={outcome.boxCamObserved.eligible ? pt('m22observedPill') : pt('m22notYet')} tone={outcome.boxCamObserved.eligible ? 'green' : 'default'} />
          </Row>
          <Muted size={12}>{pt('m22observedDetail')}</Muted>

          {/* §78 — and immediately, the other fact. */}
          {combineNotice(false, outcome.combineDisabledReason)}

          {/* §79 — the experimental count, behind a disclosure, after the real
              outcome, with its status attached. Never the headline. */}
          {outcome.result.experimental.exactCount != null ? (
            <View style={{ marginTop: 8 }}>
              <Button
                small
                label={showExperimental ? pt('m22hideExperimental') : pt('m22showExperimental')}
                onPress={() => setShowExperimental((v) => !v)}
              />
              {showExperimental ? (
                <View style={{ marginTop: 6, backgroundColor: colors.panel2, borderRadius: 8, padding: 10 }}>
                  <Row>
                    <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('m22experimentalTitle')}</Text>
                    <Pill label={pt('m22experimentalPill')} tone="gold" />
                  </Row>
                  <Muted size={12}>{pt('m22experimentalCount')}: {outcome.result.experimental.exactCount}</Muted>
                  <Muted size={11.5}>{pt('m22experimentalNote')}</Muted>
                </View>
              ) : null}
            </View>
          ) : null}

          <Row style={{ marginTop: 10 }}><Button label={pt('m22close')} onPress={onClose} /></Row>
        </View>
      ) : null}

      {/* §80/§81 — a REFUSAL: the attempt was understood and not verifiable.
          Plain, specific, and it tells the player what to change. */}
      {phase === 'refused' && outcome ? (
        <View accessibilityLiveRegion="polite">
          <Row style={{ marginTop: 8 }}>
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>{pt('m22couldNotVerify')}</Text>
            <Pill label={pt('m22tryAgain')} tone="gold" />
          </Row>
          <Muted size={12}>{reasonLabel(outcome.result.refusalReason)}</Muted>
          <Muted size={11.5}>{pt('m22refusalReassure')}</Muted>
          <Row style={{ marginTop: 10 }}>
            <Button primary label={pt('m22retry')} onPress={() => void runReadyCheck()} />
            <Button small label={pt('m22close')} onPress={onClose} />
          </Row>
        </View>
      ) : null}

      {/* §81 — a TECHNICAL failure. Different words, because it is not about
          the player's attempt at all. */}
      {phase === 'error' ? (
        <View accessibilityLiveRegion="assertive">
          <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15, marginTop: 8 }}>{pt('m22technicalTitle')}</Text>
          <Muted size={12}>{pt('m22technicalDetail')}</Muted>
          <Row style={{ marginTop: 10 }}>
            <Button primary label={pt('m22retry')} onPress={() => void runReadyCheck()} />
            <Button small label={pt('m22close')} onPress={() => void cancel()} />
          </Row>
        </View>
      ) : null}
    </Card>
  );
}
