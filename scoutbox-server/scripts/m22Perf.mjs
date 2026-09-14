// M22 — performance, memory and soak measurement (§39–§47).
//
// WHAT THIS MEASURES AND WHAT IT DOES NOT
//
// It measures the cost of the observation pipeline as it is actually built:
// gray8 frames in, per-layer timings out, on this machine. It does NOT
// establish a production capacity figure, because a capacity figure needs a
// production provider and real video, and M22 has neither. Numbers here are a
// floor on cost and a shape — how cost scales with frame size, cadence and
// concurrency — not a promise about a server.
//
// The costs worth watching are named rather than averaged into a single
// "throughput", because they behave differently:
//
//   detection    per frame, scales with PIXELS
//   tracking     per finish, scales with the number of detections
//   protocol     per finish, scales with usable triples
//   quality      per finish, effectively constant
//   finalization tracking + protocol + quality together
//
// §45 asks for event-loop responsiveness. The pipeline is synchronous CPU
// work, so it necessarily blocks the loop while it runs; the question that
// matters is whether one FRAME blocks it long enough to matter, which is what
// the lag measurement below reports against an idle baseline.
//
// Run with --expose-gc for meaningful heap numbers. Without it the soak still
// runs and reports the retained-object counts, which is the part that actually
// answers "does a finished session let go of everything".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ObservationRun, detectFrame, buildTracks } from '../m22/engine.mjs';
import { interpret } from '../m22/protocol.mjs';
import { observationQuality } from '../m22/quality.mjs';
import { decodeFrame, FrameQueue } from '../m22/frames.mjs';
import { ObservationSessions } from '../m22/session.mjs';
import { sequence, jugglePath, touchPath } from '../m22/scenes.mjs';
import { FRAME_LIMITS, CV_ENGINE_VERSION } from '../m22/policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'm22', 'perf.json');

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

function stats(xs) {
  if (!xs.length) return { n: 0, mean: null, p50: null, p95: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return {
    n: s.length,
    mean: r3(s.reduce((a, b) => a + b, 0) / s.length),
    p50: r3(at(0.5)), p95: r3(at(0.95)), max: r3(s[s.length - 1]),
  };
}

/** Decode a synthetic capture once, so transport cost is not timed as CV cost. */
function capture({ w, h, fps, kind = 'juggle', durationMs = 4800, seed = 11 }) {
  const path_ = kind === 'juggle' ? jugglePath({ contacts: 8 }) : touchPath({ touches: 10 });
  const raw = sequence({ w, h, fps, durationMs, path: path_, seed });
  return raw.map((x) => decodeFrame(x)).filter((d) => d.ok).map((d) => d.frame);
}

// Warm the JIT before measuring. Without this the first size measured carries
// the cost of compiling every layer, which shows up as the smallest frame
// being the most expensive — an artefact that would sit in the report looking
// like a finding.
{
  const warm = capture({ w: 240, h: 180, fps: 24, durationMs: 1200 });
  for (let i = 0; i < 3; i += 1) {
    const r = new ObservationRun({ eventKind: 'juggle' });
    for (const f of warm) r.processFrame(f);
    r.finish({});
  }
}

const report = {
  kind: 'm22_perf',
  generatedAt: new Date().toISOString(),
  engineVersion: CV_ENGINE_VERSION,
  node: process.version,
  gcExposed: typeof global.gc === 'function',
  note: 'Synthetic frames on this machine. A floor on cost and a scaling shape, not a production capacity figure.',
};

console.log(`M22 performance — engine v${CV_ENGINE_VERSION}, node ${process.version}`);
console.log(`gc exposed: ${report.gcExposed ? 'yes' : 'no (run with --expose-gc for heap numbers)'}\n`);

// =====================================================================
// §39–§41 — per-layer timings across frame size and cadence
// =====================================================================

const SIZES = [
  { id: '160x120', w: 160, h: 120 },
  { id: '240x180', w: 240, h: 180 },
  { id: '320x240', w: 320, h: 240 },   // FRAME_LIMITS maximum
];
const RATES = [12, 24, 30];

console.log('--- per-layer cost, by frame size (24 fps) ----------------------');
console.log(`${pad('size', 10)}${rpad('bytes', 8)}${rpad('frames', 8)}${rpad('detect/f', 11)}${rpad('p95', 8)}${rpad('track', 9)}${rpad('protocol', 10)}${rpad('quality', 9)}${rpad('finalize', 10)}`);

const bySize = [];
for (const s of SIZES) {
  const frames = capture({ w: s.w, h: s.h, fps: 24 });

  // Layer 1, per frame, with the previous frame threaded through exactly as
  // the run does it (the inter-frame diff is part of detection's cost).
  const detMs = [];
  const dets = [];
  let prev = null;
  for (const f of frames) {
    const t0 = performance.now();
    const d = detectFrame(f, prev);
    detMs.push(performance.now() - t0);
    dets.push(d); prev = f;
  }

  // Layers 2-4 run once per finish and each take well under a millisecond, so
  // a single reading is mostly scheduler and GC noise — one unlucky sample
  // reads as a layer being ten times its real cost. Each is timed REPEATS
  // times and reported as the median.
  const REPEATS = 9;
  const med = (f) => {
    const xs = [];
    for (let i = 0; i < REPEATS; i += 1) { const t = performance.now(); f(); xs.push(performance.now() - t); }
    return stats(xs).p50;
  };

  const tracks = buildTracks(dets);
  const trackMs = med(() => buildTracks(dets));
  const protoMs = med(() => interpret({ eventKind: 'juggle', tracks }));
  const qualityMs = med(() => observationQuality({
    continuity: tracks.continuity, cadence: tracks.cadence,
    duplicates: 0, framesSeen: frames.length, eventCount: 0,
  }));

  // Finalization through the real API. A run can only be finished once, so the
  // repeats are INGESTED first and only the finish() calls are timed — an
  // earlier cut timed whole runs and subtracted an estimate of ingest, which
  // is a bad estimator (ingest is more than detection) and produced obvious
  // nonsense in the column.
  const finals = [];
  for (let i = 0; i < REPEATS; i += 1) {
    const run = new ObservationRun({ eventKind: 'juggle' });
    for (const f of frames) run.processFrame(f);
    const t = performance.now();
    run.finish({});
    finals.push(performance.now() - t);
  }
  const finalizeMs = stats(finals).p50;

  const d = stats(detMs);
  bySize.push({
    size: s.id, bytes: s.w * s.h, frames: frames.length,
    detectPerFrameMs: d, trackMs: r3(trackMs), protocolMs: r3(protoMs),
    qualityMs: r3(qualityMs), finalizeMs: r3(finalizeMs),
    timingNote: 'per-finish layers are medians of 9 repeats; detection is per frame over the whole capture',
    detectPerMegapixelMs: r2((d.mean / (s.w * s.h)) * 1e6),
  });
  console.log(
    `${pad(s.id, 10)}${rpad(s.w * s.h, 8)}${rpad(frames.length, 8)}` +
    `${rpad(`${d.mean}ms`, 11)}${rpad(`${d.p95}`, 8)}${rpad(`${r3(trackMs)}ms`, 9)}` +
    `${rpad(`${r3(protoMs)}ms`, 10)}${rpad(`${r3(qualityMs)}ms`, 9)}${rpad(`${r3(finalizeMs)}ms`, 10)}`,
  );
}
report.bySize = bySize;

// Detection should be at worst linear in pixels — if cost per megapixel ROSE
// with size, something would be scanning the image a number of times that
// itself grows, and the largest supported frame would be the one to worry
// about. The expected shape is the opposite: per-megapixel cost FALLS as
// frames get larger, because a fixed per-frame overhead is amortised over
// more pixels. That is what is reported below, and the direction is the
// finding, not the ratio.
const perMp = bySize.map((b) => b.detectPerMegapixelMs);
const linearity = r2(Math.max(...perMp) / Math.min(...perMp));
const amortising = perMp[0] >= perMp[perMp.length - 1];
console.log(`\ndetection cost per megapixel: [${perMp.join(', ')}] ms across ${SIZES.map((s) => s.id).join(' -> ')}`);
console.log(
  amortising
    ? `  falling with frame size (spread ${linearity}x): fixed per-frame overhead amortising, at worst linear in pixels.`
    : `  RISING with frame size (spread ${linearity}x): detection is super-linear in pixels — worth investigating.`,
);
report.detectionCostPerMegapixelMs = perMp;
report.detectionLinearityRatio = linearity;
report.detectionAtWorstLinear = amortising;

console.log('\n--- per-layer cost, by cadence (240x180) ------------------------');
const byRate = [];
for (const fps of RATES) {
  const frames = capture({ w: 240, h: 180, fps });
  // Median of 5 whole runs, for the same noise reason as above.
  const ingests = [], finals = [];
  for (let i = 0; i < 5; i += 1) {
    const run = new ObservationRun({ eventKind: 'juggle' });
    const t0 = performance.now();
    for (const f of frames) run.processFrame(f);
    const t1 = performance.now();
    run.finish({});
    ingests.push(t1 - t0); finals.push(performance.now() - t1);
  }
  const ingestMs = stats(ingests).p50, finalizeMs = stats(finals).p50;
  // The number that matters operationally: cost per second of captured video.
  const realtimeFactor = r2((ingestMs + finalizeMs) / 4800);
  byRate.push({
    fps, frames: frames.length, ingestMs: r3(ingestMs), finalizeMs: r3(finalizeMs),
    msPerFrame: r3(ingestMs / frames.length), realtimeFactor,
  });
  console.log(
    `${rpad(fps, 3)} fps  frames ${rpad(frames.length, 4)}  ingest ${rpad(`${r2(ingestMs)}ms`, 10)}  ` +
    `finalize ${rpad(`${r2(finalizeMs)}ms`, 9)}  per frame ${rpad(`${r3(ingestMs / frames.length)}ms`, 9)}  ` +
    `${realtimeFactor}x of realtime`,
  );
}
report.byRate = byRate;

// =====================================================================
// §42–§44 — concurrency
// =====================================================================
//
// Node runs this on one thread, so "concurrent sessions" means interleaved
// frame submission, which is exactly what the server would see. The question
// is whether interleaving costs anything beyond the sum of the parts — it
// should not, because every layer is pure and all state is per-session.

console.log('\n--- concurrent sessions (240x180, 24 fps) -----------------------');
console.log(`${pad('sessions', 10)}${rpad('total ms', 11)}  ${rpad('per session', 13)}  ${rpad('vs 1-session', 13)}  overhead`);

const CONCURRENCY = [1, 2, 5, 10];
const concurrency = [];
let onePerSession = null;
for (const n of CONCURRENCY) {
  const reg = new ObservationSessions();
  const caps = [];
  for (let i = 0; i < n; i += 1) {
    reg.create({ sessionId: `perf-${n}-${i}`, eventKind: 'juggle' });
    caps.push(capture({ w: 240, h: 180, fps: 24, seed: 11 + i }));
  }
  const maxLen = Math.max(...caps.map((c) => c.length));
  const t0 = performance.now();
  // Interleave: one frame per session per round, the realistic arrival order.
  for (let k = 0; k < maxLen; k += 1) {
    for (let i = 0; i < n; i += 1) {
      if (k < caps[i].length) reg.ingest({ sessionId: `perf-${n}-${i}`, frame: caps[i][k] });
    }
  }
  for (let i = 0; i < n; i += 1) reg.finalize({ sessionId: `perf-${n}-${i}` });
  const totalMs = performance.now() - t0;
  const per = totalMs / n;
  if (onePerSession == null) onePerSession = per;
  const overhead = r2((per / onePerSession - 1) * 100);
  concurrency.push({ sessions: n, totalMs: r2(totalMs), perSessionMs: r2(per), overheadPct: overhead });
  console.log(
    `${pad(n, 10)}${rpad(r2(totalMs), 11)}  ${rpad(`${r2(per)}ms`, 13)}  ${rpad(`${r2(per / onePerSession)}x`, 13)}  ${overhead >= 0 ? '+' : ''}${overhead}%`,
  );
  reg.disposeAll();
}
report.concurrency = concurrency;

// =====================================================================
// §45 — event-loop responsiveness
// =====================================================================

async function measureLoopLag({ durationMs, work }) {
  const lags = [];
  let stop = false;
  const tick = () => {
    const expected = performance.now() + 5;
    setTimeout(() => {
      lags.push(Math.max(0, performance.now() - expected));
      if (!stop) tick();
    }, 5);
  };
  tick();
  const t0 = performance.now();
  while (performance.now() - t0 < durationMs) {
    if (work) work();
    await new Promise((res) => setImmediate(res));
  }
  stop = true;
  await new Promise((res) => setTimeout(res, 20));
  return stats(lags);
}

console.log('\n--- event-loop responsiveness ----------------------------------');
const idleLag = await measureLoopLag({ durationMs: 400, work: null });
const busyFrames = capture({ w: 320, h: 240, fps: 24 });
let bi = 0;
let busyRun = new ObservationRun({ eventKind: 'juggle' });
const busyLag = await measureLoopLag({
  durationMs: 400,
  work: () => {
    if (bi >= busyFrames.length) { busyRun = new ObservationRun({ eventKind: 'juggle' }); bi = 0; }
    busyRun.processFrame(busyFrames[bi]); bi += 1;
  },
});
console.log(`idle      mean ${idleLag.mean}ms  p95 ${idleLag.p95}ms  max ${idleLag.max}ms`);
console.log(`ingesting mean ${busyLag.mean}ms  p95 ${busyLag.p95}ms  max ${busyLag.max}ms  (320x240, one frame per loop turn)`);
console.log(
  'One frame is the unit of blocking. Yielding between frames keeps the loop\n' +
  'responsive; submitting a whole batch without yielding would not, which is\n' +
  `why FRAME_LIMITS caps a batch at ${FRAME_LIMITS.maxFramesPerBatch} frames.`,
);
report.eventLoop = { idle: idleLag, ingesting: busyLag };

// =====================================================================
// §46 — soak: 500 sessions, created and released
// =====================================================================

console.log('\n--- soak: 500 sessions created, ingested, finalized, released ---');

const gc = typeof global.gc === 'function' ? global.gc : null;
const heapNow = () => { if (gc) gc(); return process.memoryUsage().heapUsed; };

const soakFrames = capture({ w: 240, h: 180, fps: 12, durationMs: 2400 });
const reg = new ObservationSessions();
const heapBefore = heapNow();
const samples = [];
const SOAK_N = 500;
const tSoak = performance.now();
for (let i = 0; i < SOAK_N; i += 1) {
  const id = `soak-${i}`;
  reg.create({ sessionId: id, eventKind: 'juggle' });
  for (const f of soakFrames) reg.ingest({ sessionId: id, frame: f });
  // A quarter are abandoned rather than finished — cancelled, expired or
  // disconnected — because a leak is far likelier on the path nobody watches.
  if (i % 4 === 3) reg.cancel(id); else reg.finalize({ sessionId: id });
  if (i % 100 === 99) samples.push({ after: i + 1, heapMB: r2(heapNow() / 1048576), footprint: reg.footprint() });
}
const soakMs = performance.now() - tSoak;
const heapAfter = heapNow();
const footprint = reg.footprint();

console.log(`${SOAK_N} sessions in ${r2(soakMs)}ms (${r2(soakMs / SOAK_N)}ms each, ${soakFrames.length} frames each)`);
for (const s of samples) {
  console.log(`  after ${rpad(s.after, 4)}  heap ${rpad(`${s.heapMB}MB`, 9)}  active ${s.footprint.activeSessions}  queued ${s.footprint.queuedFrames}  detections ${s.footprint.detections}  timers ${s.footprint.timers}`);
}
console.log(`heap ${r2(heapBefore / 1048576)}MB -> ${r2(heapAfter / 1048576)}MB (delta ${r2((heapAfter - heapBefore) / 1048576)}MB)${gc ? '' : ' — no --expose-gc, treat as indicative only'}`);
console.log(`retained after 500 sessions: ${footprint.activeSessions} sessions, ${footprint.queuedFrames} queued frames, ${footprint.detections} detections, ${footprint.timers} timers`);

const leaked = footprint.activeSessions > 0 || footprint.queuedFrames > 0
  || footprint.detections > 0 || footprint.timers > 0;
report.soak = {
  sessions: SOAK_N, framesPerSession: soakFrames.length,
  totalMs: r2(soakMs), msPerSession: r2(soakMs / SOAK_N),
  heapBeforeMB: r2(heapBefore / 1048576), heapAfterMB: r2(heapAfter / 1048576),
  heapDeltaMB: r2((heapAfter - heapBefore) / 1048576),
  heapSamples: samples, finalFootprint: footprint, retainedObjects: leaked,
  cancelledFraction: 0.25,
};

// =====================================================================
// §47 — bounded history, backpressure, timeout
// =====================================================================

console.log('\n--- bounds ------------------------------------------------------');

// Queue backpressure: push far past capacity and confirm the queue stays
// bounded and reports the drops rather than growing.
const q = new FrameQueue();
for (let i = 0; i < FRAME_LIMITS.maxQueuedFrames * 10; i += 1) q.push({ seq: i });
const bounded = q.size <= FRAME_LIMITS.maxQueuedFrames;
console.log(`queue backpressure      pushed ${FRAME_LIMITS.maxQueuedFrames * 10}, held ${q.size} (cap ${FRAME_LIMITS.maxQueuedFrames}), dropped ${q.dropped} — ${bounded ? 'bounded' : 'UNBOUNDED'}`);

// Session timeout: an attempt past its TTL is expired and released, and a
// frame arriving afterwards finds nothing to attach to.
const treg = new ObservationSessions({ ttlMs: 1000 });
treg.create({ sessionId: 'ttl', eventKind: 'juggle', nowMs: 0 });
const late = treg.ingest({ sessionId: 'ttl', frame: soakFrames[0], nowMs: 5000 });
const afterTtl = treg.get('ttl');
console.log(`session timeout         late frame -> ${late.error}, runtime after expiry: ${afterTtl === null ? 'released' : 'STILL PRESENT'}`);

// Retained history per session, in detections rather than frames: the run
// keeps Layer 1 output, never pixels.
const histRun = new ObservationRun({ eventKind: 'juggle' });
for (const f of soakFrames) histRun.processFrame(f);
const retainsPixels = histRun.detections.some((d) => d && (d.pixels || d.frame || d.data));
console.log(`per-session history     ${histRun.detections.length} detections for ${soakFrames.length} frames; retains pixel buffers: ${retainsPixels ? 'YES' : 'no'}`);
histRun.finish({});

report.bounds = {
  queueCap: FRAME_LIMITS.maxQueuedFrames,
  queueHeld: q.size, queueDropped: q.dropped, queueBounded: bounded,
  lateFrameError: late.error, runtimeReleasedAfterTtl: afterTtl === null,
  detectionsRetained: histRun.detections.length, retainsPixelBuffers: retainsPixels,
};

// =====================================================================
// §94–§97 — the transport path, concurrent live providers, load shedding
// =====================================================================
//
// Everything above measures the ENGINE. This measures what the provider adds
// on top of it: envelope validation, base64 decode, sequence and duplicate
// bookkeeping, queueing, and the canonical result build. That overhead is the
// honest cost of the transport, and it is reported separately so it cannot
// hide inside an engine number.

console.log('\n--- §94: transport overhead, per frame (240x180) ----------------');

const { ProductionCvProvider, MAX_CONCURRENT_SESSIONS } = await import('../m22/provider.mjs');
const { sequence: seq2, touchPath: touch2 } = await import('../m22/scenes.mjs');

const envelopes = seq2({ w: 240, h: 180, fps: 24, durationMs: 4800, path: touch2({ touches: 10 }), seed: 23 });

// Validation + decode, timed apart from the engine.
const decodeMs = [];
for (const e of envelopes) {
  const t = performance.now();
  decodeFrame(e);
  decodeMs.push(performance.now() - t);
}
const dec = stats(decodeMs);

// The full provider ingest path, decoded frames in.
const decoded = envelopes.map((e) => decodeFrame(e)).filter((d) => d.ok).map((d) => d.frame);
const provWarm = new ProductionCvProvider();
{
  const b = provWarm.beginSession({ boxCamSessionId: 'warm', playerId: 'p', protocolId: 'combine-box-touch-60', nonce: 'n' });
  decoded.forEach((f, i) => provWarm.ingestFrame({ providerSessionId: b.providerSessionId, boxCamSessionId: 'warm', nonce: 'n', seq: i + 1, frame: f }));
  provWarm.finalize({ providerSessionId: b.providerSessionId });
}

const ingestMs = [];
let finalizeProvMs = 0;
{
  const prov = new ProductionCvProvider();
  const b = prov.beginSession({ boxCamSessionId: 'perf', playerId: 'p', protocolId: 'combine-box-touch-60', nonce: 'n' });
  decoded.forEach((f, i) => {
    const t = performance.now();
    prov.ingestFrame({ providerSessionId: b.providerSessionId, boxCamSessionId: 'perf', nonce: 'n', seq: i + 1, frame: f });
    ingestMs.push(performance.now() - t);
  });
  const t = performance.now();
  prov.finalize({ providerSessionId: b.providerSessionId });
  finalizeProvMs = performance.now() - t;
  prov.disposeAll();
}
const ing = stats(ingestMs);
// Engine-only ingest for the same frames, so the DIFFERENCE is the transport.
const engineOnly = [];
{
  const run = new ObservationRun({ eventKind: 'touch' });
  for (const f of decoded) { const t = performance.now(); run.processFrame(f); engineOnly.push(performance.now() - t); }
  run.finish({});
}
const eng = stats(engineOnly);
// Subtracting two nearly-equal means measured in separate loops is a weak
// estimator: run-to-run JIT and GC state moves each by more than the quantity
// being estimated, and it can easily come out NEGATIVE — which would print a
// flattering "0ms overhead" that means nothing. So the difference is reported
// only when it clears a noise band derived from the spread of the two
// measurements themselves; otherwise it is reported as unresolvable, and the
// directly-measured decode cost is given as the honest floor.
const diff = ing.mean - eng.mean;
const noiseBand = r3(Math.max(ing.p95 - ing.mean, eng.p95 - eng.mean));
const resolved = Math.abs(diff) > noiseBand;

console.log(`decode + validate        mean ${dec.mean}ms  p95 ${dec.p95}ms   (measured directly)`);
console.log(`provider ingest (total)  mean ${ing.mean}ms  p95 ${ing.p95}ms`);
console.log(`engine alone             mean ${eng.mean}ms  p95 ${eng.p95}ms`);
console.log(
  resolved
    ? `transport overhead       ${r3(diff)}ms per frame (${Math.round((diff / eng.mean) * 100)}% on top of the engine)`
    : `transport overhead       below the noise band (difference ${r3(diff)}ms, band ±${noiseBand}ms) — not resolvable by subtraction`,
);
console.log(`  the honest floor is the directly-measured decode: ${dec.mean}ms per frame, about ${Math.round((dec.mean / ing.mean) * 100)}% of ingest.`);
console.log(`provider finalization    ${r3(finalizeProvMs)}ms (canonical result build included)`);

report.transport = {
  decode: dec, providerIngest: ing, engineOnly: eng,
  subtractionDiffMs: r3(diff), noiseBandMs: noiseBand, overheadResolved: resolved,
  transportOverheadMsPerFrame: resolved ? r3(diff) : null,
  providerFinalizeMs: r3(finalizeProvMs),
  note: resolved
    ? 'Provider ingest minus engine-only ingest on identical frames.'
    : 'Provider ingest and engine-only ingest are indistinguishable at this sample size; the decode measurement is the reliable figure.',
};

// ------------------------------------------- §96: concurrent live providers
console.log('\n--- §96: concurrent live provider sessions ---------------------');
console.log(`${pad('sessions', 10)}${rpad('total ms', 11)}  ${rpad('per session', 13)}  ${rpad('per frame', 11)}  refused`);

const liveConcurrency = [];
for (const n of [1, 2, 5, 10]) {
  const prov = new ProductionCvProvider();
  const ids = [];
  let refused = 0;
  for (let i = 0; i < n; i += 1) {
    const b = prov.beginSession({ boxCamSessionId: `c${n}-${i}`, playerId: `p${i}`, protocolId: 'combine-box-touch-60', nonce: 'n' });
    if (b.ok) ids.push(b.providerSessionId); else refused += 1;
  }
  const t0 = performance.now();
  // Interleaved arrival, the realistic order.
  for (let k = 0; k < decoded.length; k += 1) {
    for (let i = 0; i < ids.length; i += 1) {
      prov.ingestFrame({ providerSessionId: ids[i], boxCamSessionId: `c${n}-${i}`, nonce: 'n', seq: k + 1, frame: decoded[k] });
    }
  }
  for (let i = 0; i < ids.length; i += 1) prov.finalize({ providerSessionId: ids[i] });
  const totalMs = performance.now() - t0;
  const frames = decoded.length * Math.max(1, ids.length);
  liveConcurrency.push({ sessions: n, totalMs: r2(totalMs), perSessionMs: r2(totalMs / Math.max(1, ids.length)), msPerFrame: r3(totalMs / frames), refused });
  console.log(`${pad(n, 10)}${rpad(r2(totalMs), 11)}  ${rpad(`${r2(totalMs / Math.max(1, ids.length))}ms`, 13)}  ${rpad(`${r3(totalMs / frames)}ms`, 11)}  ${refused}`);
  prov.disposeAll();
}
report.liveConcurrency = liveConcurrency;

// ------------------------------------------------------ §97: load shedding
console.log('\n--- §97: load shedding at the concurrency ceiling ---------------');
{
  const prov = new ProductionCvProvider({ maxConcurrent: 4 });
  const opened = [];
  let busy = 0, busyError = null;
  for (let i = 0; i < 8; i += 1) {
    const b = prov.beginSession({ boxCamSessionId: `shed-${i}`, playerId: 'p', protocolId: 'combine-box-touch-60', nonce: 'n' });
    if (b.ok) opened.push(b.providerSessionId);
    else { busy += 1; busyError = b.error; }
  }
  console.log(`ceiling 4: opened ${opened.length}, refused ${busy} with "${busyError}"`);
  // The property: refusal happens at the DOOR, not by accepting and dropping
  // frames from an attempt the player believes is being observed.
  const shedOk = opened.length === 4 && busy === 4 && busyError === 'provider_busy';
  console.log(shedOk
    ? 'a session over the ceiling is refused up front — never accepted and quietly starved'
    : '*** load shedding did not behave as declared ***');
  report.loadShedding = { ceiling: 4, opened: opened.length, refused: busy, error: busyError, correct: shedOk };
  report.maxConcurrentSessions = MAX_CONCURRENT_SESSIONS;
  if (!shedOk) failures.push('load shedding did not refuse at the concurrency ceiling');
  prov.disposeAll();
}

// ------------------------------------------ §95: event loop with CV active
console.log('\n--- §95: API responsiveness while CV sessions are active --------');
{
  const prov = new ProductionCvProvider();
  const b = prov.beginSession({ boxCamSessionId: 'loop', playerId: 'p', protocolId: 'combine-box-touch-60', nonce: 'n' });
  let i = 0;
  const lag = await measureLoopLag({
    durationMs: 400,
    work: () => {
      if (i >= decoded.length) i = 0;
      prov.ingestFrame({ providerSessionId: b.providerSessionId, boxCamSessionId: 'loop', nonce: 'n', seq: 100000 + i, frame: decoded[i] });
      i += 1;
    },
  });
  console.log(`with an active CV session: mean ${lag.mean}ms  p95 ${lag.p95}ms  max ${lag.max}ms`);
  console.log(`idle baseline (above):     mean ${idleLag.mean}ms  p95 ${idleLag.p95}ms`);
  // §24/§95 — the measurement that decides whether a worker boundary is
  // needed. A frame costs well under a millisecond and the loop is yielded
  // between frames, so the answer here is no. The seam exists in the provider
  // (`processFrame`) if a future measurement says otherwise.
  const workerNeeded = lag.p95 > 50;
  console.log(workerNeeded
    ? '*** p95 lag above 50ms — §24 makes worker isolation mandatory ***'
    : 'p95 lag is well inside budget: §24 is satisfied without a worker boundary, measured rather than assumed.');
  report.eventLoopWithCv = { ...lag, workerIsolationRequired: workerNeeded };
  prov.disposeAll();
}

fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nwritten to              m22/perf.json`);

const failures = [];

// -------------------------------------------------------------- verdict
//
// Only the structural properties fail the run. Timings are recorded, never
// asserted: this machine is not the production machine, and a perf script
// that fails on a wall-clock threshold fails for reasons that have nothing to
// do with the code.

if (leaked) failures.push('the session registry retained objects after every session ended');
if (!bounded) failures.push('the frame queue is not bounded');
if (afterTtl !== null) failures.push('an expired session was not released');
if (retainsPixels) failures.push('a run retained pixel buffers past detection');
if (late.error !== 'SESSION_EXPIRED' && late.error !== 'SESSION_NOT_FOUND') {
  failures.push(`a frame past the TTL was not rejected (got ${late.error})`);
}

if (failures.length) {
  console.error('\nm22Perf: FAILED');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('m22Perf: bounded queue, released sessions, no retained pixels, no leaked objects.');
