// M22 — the constant freeze (§34).
//
// A holdout only means something if the thing being tested did not move
// between "we froze it" and "we measured it". Otherwise the holdout is just
// another development fixture with a more impressive name: run it, see a
// number you dislike, nudge a threshold, run it again, and the separation
// that made it a holdout is gone without anyone deciding to throw it away.
//
// So the constants that determine an observation are hashed, and the hashes
// are RECORDED HERE AS LITERALS. The holdout harness refuses to run against a
// drifted freeze. Changing a threshold is allowed — it just cannot be done
// quietly, and it invalidates the holdout result that was measured under the
// old one.
//
// What is frozen is everything that can change a count:
//
//   policy      engine and policy version, provider id, frame encoding
//   frame       transport limits (size, batch, queue)
//   capture     the cadence envelope a capture must satisfy
//   detection   what counts as a ball, a person, a usable frame
//   contact     the event rules: impulse, range, separation, refractory, gaps
//   confidence  the acceptance floors
//   quality     the sufficiency thresholds
//   geometry    the normalisation constants the layers measure in
//
//   source      the observation layers themselves, comment-stripped
//
// That last group was added after the first holdout run, and the reason is
// worth recording. The freeze originally covered only CONSTANTS, which left a
// hole wide enough to drive through: a change to the layer CODE — a different
// normalisation order, a reordered guard — changes what the engine counts
// without moving a single threshold, so the freeze would have reported itself
// intact while the holdout result underneath it went stale. Generation 1 of
// the holdout found exactly such a defect in the tracking layer, and fixing it
// would have left the freeze silent. It no longer is.
//
// Deliberately NOT frozen: the fixtures, the scene generator, the harness.
// Those are the measuring instrument, and an instrument may be extended. The
// freeze covers the thing being measured.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  BOX_CAM_CV_POLICY_VERSION, CV_ENGINE_VERSION, CV_PROVIDER_ID, FRAME_ENCODING,
  FRAME_LIMITS, CAPTURE_REQUIREMENTS, DETECTION, EVENT_RULES, CONFIDENCE,
} from './policy.mjs';
import { QUALITY_THRESHOLDS } from './quality.mjs';

/**
 * Geometry constants that live in the layer code rather than in policy,
 * mirrored here so the freeze covers them too.
 *
 * These are duplicated values, and that is a deliberate trade. The
 * alternative — parsing the source files — would hash comments and
 * formatting, so a reworded comment would read as a threshold change. The
 * duplication is checked: `assertGeometryMirrorsSource()` below reads the
 * real source and fails if a mirrored number no longer appears in it.
 */
export const GEOMETRY_CONSTANTS = Object.freeze({
  // detect.mjs — the connected-component cap that bounds detection cost.
  maxComponents: 64,
  // track.mjs — the person-region POSITION discontinuity test. A silhouette
  // whose centre moves more than half a body width in one sample is a
  // different frame of reference, not the same one moved. The corresponding
  // SCALE test is not here: it lives in policy as
  // EVENT_RULES.maxFrameScaleStepPerSample, because unlike this one its value
  // is derived from the impulse threshold rather than from what a body does.
  personCentreJumpFracOfWidth: 0.5,
  // track.mjs — beyond this ratio the apparent ball size has changed so much
  // that the track is following a different object.
  ballDiameterResetRatio: 2.2,
  // protocol.mjs — a ball this close to the frame edge has a clipped blob and
  // therefore an unreliable centroid, in ball diameters.
  minEdgeDiametersForImpulse: 0.5,
});

/**
 * The observation layers whose CODE is frozen. Not the engine orchestrator,
 * which only wires them, and not the fixtures or harness, which measure.
 */
export const FROZEN_SOURCES = Object.freeze(['detect.mjs', 'track.mjs', 'protocol.mjs', 'quality.mjs']);

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Strip comments and collapse whitespace before hashing.
 *
 * This is crude — it is line-based, so it would not survive a `/* *​/` block
 * opened and closed on lines that also carry code — and crude is the right
 * trade here. The alternative of hashing raw bytes would make every reworded
 * comment read as a behavioural change, and a freeze that cries wolf on
 * comment edits is a freeze people learn to re-record without reading.
 */
export function strippedSource(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
    .join('\n')
    .replace(/\s+/g, ' ');
}

/** Per-file digests of the observation layers. */
export function sourceDigests({ dir = HERE } = {}) {
  const out = {};
  for (const f of FROZEN_SOURCES) {
    out[f] = sha256(strippedSource(fs.readFileSync(path.join(dir, f), 'utf8'))).slice(0, 16);
  }
  return out;
}

/** The frozen surface, grouped so a drift report can name what moved. */
export function frozenGroups() {
  return {
    policy: {
      policyVersion: BOX_CAM_CV_POLICY_VERSION,
      engineVersion: CV_ENGINE_VERSION,
      providerId: CV_PROVIDER_ID,
      frameEncoding: FRAME_ENCODING,
    },
    frame: { ...FRAME_LIMITS },
    capture: { ...CAPTURE_REQUIREMENTS },
    detection: { ...DETECTION },
    contact: { ...EVENT_RULES },
    confidence: { ...CONFIDENCE },
    quality: { ...QUALITY_THRESHOLDS },
    geometry: { ...GEOMETRY_CONSTANTS },
    source: sourceDigests(),
  };
}

/**
 * Canonical serialisation: keys sorted at every level, arrays kept in order.
 *
 * Without this the checksum depends on declaration order, so reordering two
 * unrelated policy lines would report a threshold change and reordering a
 * changed line back would hide one.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sha256(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }

/** Per-group checksums plus one over the whole surface. */
export function computeChecksums(groups = frozenGroups()) {
  const out = {};
  for (const [name, g] of Object.entries(groups)) out[name] = sha256(canonicalJson(g)).slice(0, 16);
  out.all = sha256(canonicalJson(out)).slice(0, 16);
  return out;
}

/**
 * THE FREEZE RECORD.
 *
 * Recorded before the holdout was generated or run. If a checksum below stops
 * matching the live constants, the holdout result measured under it is stale
 * — not wrong, stale — and must be regenerated and re-run under a new freeze.
 */
export const FREEZE = Object.freeze({
  freezeId: 'm22-v2-freeze-3',
  frozenAt: '2026-09-14',
  engineVersion: 2,
  policyVersion: 1,
  reason:
    'Re-frozen after the scale-step fix that holdout generation 2 forced: the per-sample '
    + 'normalisation introduced under freeze 2 was replaced by a derived bound on how much '
    + 'the player region may change size between samples. Generations 1 and 2 are consumed; '
    + 'generation 3 was generated under this freeze.',
  supersedes: 'm22-v2-freeze-2',
  checksums: Object.freeze({
    policy: '776cb4d0ea6fa31b',
    frame: '320b82d092507cf1',
    capture: 'a1872b4e68fe75a2',
    detection: 'e6af0760581a5f65',
    contact: '717eee32536e9d1b',
    confidence: '2bb4a327f967fb21',
    quality: '3c03784945096493',
    geometry: 'b217e16a18270532',
    source: '9a44876f95909cdc',
    all: '8d390baecd5715fa',
  }),
});

/**
 * The freeze history. A freeze that can be re-recorded silently is not a
 * freeze, so every one that has existed stays here with the reason it was
 * superseded — including, in the case of generation 1, the admission that its
 * holdout result was invalidated by a fix rather than by a threshold change.
 */
export const FREEZE_HISTORY = Object.freeze([
  Object.freeze({
    freezeId: 'm22-v2-freeze-1',
    frozenAt: '2026-09-14',
    covered: 'constants only',
    supersededBy: 'm22-v2-freeze-2',
    supersededBecause:
      'Holdout generation 1, run under this freeze, found a P0 false touch (HT05, an 18% '
      + 'camera zoom pulse over a fixed ball-player relationship). The root cause was in the '
      + 'tracking layer: player-relative positions were differenced in pixels and then divided '
      + 'by a single ball diameter, so a global scale change left a residual velocity. The fix '
      + 'changed code, not constants, which this freeze did not cover — so the freeze was '
      + 'extended to hash the observation layers themselves.',
  }),
  Object.freeze({
    freezeId: 'm22-v2-freeze-2',
    frozenAt: '2026-09-14',
    covered: 'constants and layer source',
    supersededBy: 'm22-v2-freeze-3',
    supersededBecause:
      'Holdout generation 2, run under this freeze, found three more P0 false touches on the '
      + 'same axis (step zooms and repeated pulses) and, on re-probing, showed that freeze 2\'s '
      + 'fix had cost counting accuracy by amplifying ball-diameter noise. Both were resolved '
      + 'by a single derived constant, EVENT_RULES.maxFrameScaleStepPerSample, which changed '
      + 'the `contact` and `geometry` groups as well as layer source.',
  }),
]);

/**
 * Compare the live constants against the freeze record.
 *
 * Returns the drifted group names rather than a bare boolean, because "the
 * contact parameters moved" and "the frame transport limits moved" call for
 * completely different responses.
 */
export function freezeStatus() {
  const live = computeChecksums();
  const drifted = [];
  for (const [name, recorded] of Object.entries(FREEZE.checksums)) {
    if (name === 'all') continue;
    if (live[name] !== recorded) drifted.push({ group: name, recorded, live: live[name] });
  }
  return {
    freezeId: FREEZE.freezeId,
    frozenAt: FREEZE.frozenAt,
    intact: drifted.length === 0 && live.all === FREEZE.checksums.all,
    drifted,
    live,
    recorded: { ...FREEZE.checksums },
  };
}

/**
 * The mirrored geometry constants must still exist in the source they were
 * copied from. This is the check that keeps the duplication honest: if
 * someone changes `1.4` to `1.6` in track.mjs, the freeze checksum would not
 * move — it hashes the mirror — so the mirror itself is verified against the
 * file.
 */
export function geometryMirrorCheck({ readFile } = {}) {
  const expectations = [
    { file: 'detect.mjs', needles: ['maxComponents = 64'] },
    { file: 'track.mjs', needles: ['maxFrameScaleStepPerSample', '* 0.5', '* 2.2', '/ 2.2'] },
    { file: 'protocol.mjs', needles: ['edgeDiameters < 0.5'] },
  ];
  const missing = [];
  for (const e of expectations) {
    const src = readFile(e.file);
    for (const n of e.needles) if (!src.includes(n)) missing.push({ file: e.file, needle: n });
  }
  return { ok: missing.length === 0, missing };
}
