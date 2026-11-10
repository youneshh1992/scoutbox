// The constants and observation-layer source that can change a count are hashed, and the hashes recorded here as
// literals; the holdout harness refuses to run against a drifted freeze, so a threshold can't be nudged quietly
// between freezing and measuring. Layer source is frozen too because a code change (a reordered guard) can change
// counts without moving a threshold. The fixtures, scene generator and harness are the measuring instrument and are
// not frozen.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  BOX_CAM_CV_POLICY_VERSION, CV_ENGINE_VERSION, CV_PROVIDER_ID, FRAME_ENCODING,
  FRAME_LIMITS, CAPTURE_REQUIREMENTS, DETECTION, EVENT_RULES, CONFIDENCE,
} from './policy.mjs';
import { QUALITY_THRESHOLDS } from './quality.mjs';
import { canonicalJson } from '../../../platform/values.mjs';

/**
 * Geometry constants in the layer code, mirrored so the freeze covers them. `geometryMirrorCheck()` fails if a
 * mirrored number no longer appears in the source.
 */
export const GEOMETRY_CONSTANTS = Object.freeze({
  // detect.mjs: the connected-component cap that bounds detection cost.
  maxComponents: 64,
  // track.mjs: a silhouette centre moving over half a body width in one sample is a different frame of reference.
  // The scale test is EVENT_RULES.maxFrameScaleStepPerSample, derived from the impulse threshold.
  personCentreJumpFracOfWidth: 0.5,
  // track.mjs: beyond this ball-size ratio the track is following a different object.
  ballDiameterResetRatio: 2.2,
  // protocol.mjs: in ball diameters, a ball this close to the frame edge has a clipped, unreliable centroid.
  minEdgeDiametersForImpulse: 0.5,
});

export const FROZEN_SOURCES = Object.freeze(['detect.mjs', 'track.mjs', 'protocol.mjs', 'quality.mjs']);

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Line-based, so trailing comments on code lines are hashed. Raw bytes would make every reworded comment read as a
 * behavioural change.
 */
export function strippedSource(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
    .join('\n')
    .replace(/\s+/g, ' ');
}

export function sourceDigests({ dir = HERE } = {}) {
  const out = {};
  for (const f of FROZEN_SOURCES) {
    out[f] = sha256(strippedSource(fs.readFileSync(path.join(dir, f), 'utf8'))).slice(0, 16);
  }
  return out;
}

/** Grouped so a drift report can name what moved. */
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

/** Keys sorted, so the checksum doesn't depend on declaration order. */
export { canonicalJson };

function sha256(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }

export function computeChecksums(groups = frozenGroups()) {
  const out = {};
  for (const [name, g] of Object.entries(groups)) out[name] = sha256(canonicalJson(g)).slice(0, 16);
  out.all = sha256(canonicalJson(out)).slice(0, 16);
  return out;
}

/**
 * Recorded before the holdout was generated or run. If a checksum stops matching, the holdout result is stale and
 * must be regenerated and re-run under a new freeze.
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

/** Every freeze stays here with the reason it was superseded, so none is re-recorded silently. */
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

/** Names the drifted groups, because different groups moving call for different responses. */
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

/** The checksum hashes the mirror, so the mirror is checked against the source it was copied from. */
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
