// M22 — Box Cam CV client: Ready Check, frame transport, result.
//
// TWO THINGS THIS FILE IS CAREFUL ABOUT
//
// 1. It never asserts a count. The server derives every number from pixels it
//    saw itself; this client sends frames and renders what comes back. There
//    is deliberately no local counter, no optimistic count and no field in any
//    request body that could be mistaken for one — see §22 and the §107
//    regression, which POSTs `touchCount: 176` and proves it changes nothing.
//
// 2. It never retains a frame (§51, §52). A frame's whole life is: draw the
//    current video frame to one reused canvas, read the luminance plane,
//    base64 it, hand it to the request, drop the reference. Nothing is kept in
//    component state, nothing accumulates in an array, and the canvas is a
//    single reused element rather than one per frame.

import { m12Request as req } from './httpClient';

const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';

/** One Ready Check row. The client maps copy; the server sends structure (§49). */
export interface ReadyCheckItem {
  id: string;
  state: 'pass' | 'fail' | 'unknown';
  reasonCode: string | null;
  detail?: unknown;
}

export interface ReadyCheckResult {
  checks: ReadyCheckItem[];
  /** Can Box Cam observe this attempt? */
  observationReady: boolean;
  /** Can this attempt produce a standardised Combine measurement? Currently never. */
  combineVerificationAvailable: boolean;
  combineDisabledReason: { code: string; short: string; detail: string } | null;
  providerHealth: { state: string; combineVerifiedProtocols: string[] };
}

export interface CvBegin {
  providerSessionId: string;
  state: string;
  protocolId: string;
  encoding: string;
  frameLimits: { minWidth: number; minHeight: number; maxWidth: number; maxHeight: number; maxFramesPerBatch: number };
  combineVerifiedEligible: boolean;
  combineDisabledReason: { code: string; short: string; detail: string };
}

export interface CvResult {
  protocolId: string;
  providerId: string; providerVersion: number; engineVersion: number; cvPolicyVersion: number;
  outcome: 'accepted' | 'refused';
  refusalReason: string | null;
  observationQuality: { sufficient: boolean; state: string | null; reasons: string[] };
  derived: {
    personPresent: boolean; ballPresent: boolean;
    touchCount: number | null; juggleCount: number | null; activeDurationMs: number;
  };
  /** §32/§33 — carried, labelled, and never rendered as an official result. */
  experimental: { exactCount: number | null; status: string; note: string };
  integrity: Record<string, unknown>;
  serverStartedAt: number; serverEndedAt: number; serverDurationMs: number;
  combineVerified: false;
  combineVerifiedBlockedBy: string;
}

export interface CvFinalize {
  result: CvResult;
  alreadyFinalized: boolean;
  boxCamObserved: { eligible: boolean; failed: string[]; combineVerified: false; combineVerifiedNote: string };
  provenance: string | null;
  combine: { eligible: boolean; reason: string | null; reasonDetail?: string };
  combineDisabledReason: { code: string; short: string; detail: string };
}

/** A gray8 frame envelope. `data` is transient and never stored. */
export interface FrameEnvelope {
  seq: number; encoding: 'gray8'; w: number; h: number; data: string; capturedAtMs: number;
}

// ---------------------------------------------------------------- capture
//
// One canvas, reused for the life of the capture. Creating a canvas per frame
// is the obvious version of this and it quietly holds a bitmap per frame alive
// until GC catches up — exactly the "camera screenshots kept in app state"
// failure §52 warns about.

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;

/** Release the capture surface. Call when an attempt ends, for any reason. */
export function releaseCaptureSurface(): void {
  if (canvas) { canvas.width = 0; canvas.height = 0; }
  canvas = null;
  ctx = null;
}

/**
 * Draw one video frame and return its luminance plane as a gray8 envelope.
 *
 * Returns null rather than throwing when the video has no frame yet — an
 * exception here would land inside a capture interval where nobody is
 * catching it.
 */
export function captureGray8(
  video: HTMLVideoElement, seq: number, w: number, h: number,
): FrameEnvelope | null {
  if (typeof document === 'undefined') return null;
  if (!video || !video.videoWidth || !video.videoHeight) return null;

  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!ctx) return null;

  ctx.drawImage(video, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;

  // Rec. 601 luma, integer arithmetic. One byte per pixel out.
  const plane = new Uint8Array(w * h);
  for (let i = 0, p = 0; p < plane.length; i += 4, p += 1) {
    plane[p] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }

  // base64 without pulling in a dependency, in chunks so a large plane does
  // not blow the argument limit on String.fromCharCode.
  let bin = '';
  const CHUNK = 8192;
  for (let i = 0; i < plane.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(plane.subarray(i, i + CHUNK)));
  }
  const data = typeof btoa === 'function' ? btoa(bin) : '';

  // Nothing above survives this return: `plane`, `rgba` and `bin` are all
  // local, and the canvas is reused rather than accumulated.
  return { seq, encoding: 'gray8', w, h, data, capturedAtMs: Date.now() };
}

// ------------------------------------------------------------------- api

export interface PlayerM22 {
  readyCheck(playerId: string, body: Record<string, unknown>): Promise<ReadyCheckResult>;
  begin(playerId: string, sessionId: string, nonce: string, protocolId: string): Promise<CvBegin>;
  sendFrames(playerId: string, sessionId: string, nonce: string, providerSessionId: string, frames: FrameEnvelope[]): Promise<{ accepted: number; lastSeq: number; droppedByServer: number }>;
  finalize(playerId: string, sessionId: string, nonce: string, providerSessionId: string): Promise<CvFinalize>;
  cancel(playerId: string, sessionId: string, nonce: string, providerSessionId: string): Promise<unknown>;
}

const post = <T>(playerId: string, path: string, body: unknown) =>
  req<T>(path, playerId, { method: 'POST', body: JSON.stringify(body) });

const live: PlayerM22 = {
  readyCheck: (playerId, body) => post(playerId, '/player/box-cam/cv/ready-check', body),
  begin: (playerId, sessionId, nonce, protocolId) =>
    post(playerId, `/player/box-cam/sessions/${sessionId}/cv/begin`, { nonce, protocolId }),
  sendFrames: (playerId, sessionId, nonce, providerSessionId, frames) =>
    post(playerId, `/player/box-cam/sessions/${sessionId}/cv/frames`, { nonce, providerSessionId, frames }),
  finalize: (playerId, sessionId, nonce, providerSessionId) =>
    post(playerId, `/player/box-cam/sessions/${sessionId}/cv/finalize`, { nonce, providerSessionId }),
  cancel: (playerId, sessionId, nonce, providerSessionId) =>
    post(playerId, `/player/box-cam/sessions/${sessionId}/cv/cancel`, { nonce, providerSessionId }),
};

/**
 * The demo mirror.
 *
 * It reports the SAME production state the real server does — observation
 * available, Combine verification not — because a demo that quietly shows a
 * Combine Verified badge would teach the wrong thing about the product to
 * everyone who sees it.
 */
const mock: PlayerM22 = {
  async readyCheck() {
    return {
      checks: [
        { id: 'camera_permission', state: 'pass', reasonCode: null },
        { id: 'secure_context', state: 'pass', reasonCode: null },
        { id: 'frame_dimensions', state: 'pass', reasonCode: null },
        { id: 'capture_cadence', state: 'pass', reasonCode: null },
        { id: 'provider_health', state: 'pass', reasonCode: null },
        { id: 'person_region', state: 'pass', reasonCode: null },
        { id: 'ball_detection', state: 'pass', reasonCode: null },
        { id: 'lighting', state: 'unknown', reasonCode: null },
        { id: 'protocol_observation_support', state: 'pass', reasonCode: null },
      ],
      observationReady: true,
      combineVerificationAvailable: false,
      combineDisabledReason: {
        code: 'REAL_WORLD_VALIDATION_NOT_COMPLETED',
        short: 'Combine verification is not available yet for this protocol.',
        detail: 'Real-world validation has not been completed, so ScoutBox will not publish a standardised Combine measurement from computer vision.',
      },
      providerHealth: { state: 'ready', combineVerifiedProtocols: [] },
    };
  },
  async begin() {
    return {
      providerSessionId: 'pcv_demo', state: 'ready', protocolId: 'combine-box-touch-60', encoding: 'gray8',
      frameLimits: { minWidth: 160, minHeight: 120, maxWidth: 320, maxHeight: 240, maxFramesPerBatch: 12 },
      combineVerifiedEligible: false,
      combineDisabledReason: {
        code: 'REAL_WORLD_VALIDATION_NOT_COMPLETED',
        short: 'Combine verification is not available yet for this protocol.',
        detail: 'Real-world validation has not been completed.',
      },
    };
  },
  async sendFrames(_p, _s, _n, _ps, frames) {
    return { accepted: frames.length, lastSeq: frames[frames.length - 1]?.seq ?? 0, droppedByServer: 0 };
  },
  async finalize() {
    const result: CvResult = {
      protocolId: 'combine-box-touch-60', providerId: 'production_cv',
      providerVersion: 1, engineVersion: 2, cvPolicyVersion: 1,
      outcome: 'accepted', refusalReason: null,
      observationQuality: { sufficient: true, state: 'sufficient', reasons: [] },
      derived: { personPresent: true, ballPresent: true, touchCount: 9, juggleCount: null, activeDurationMs: 42_000 },
      experimental: { exactCount: 9, status: 'experimental_unvalidated', note: 'Experimental observation. Not a standardised Combine measurement.' },
      integrity: { framesAccepted: 120, framesRejected: 0, nonceBound: true, serverTimeline: true },
      serverStartedAt: Date.now() - 42_000, serverEndedAt: Date.now(), serverDurationMs: 42_000,
      combineVerified: false, combineVerifiedBlockedBy: 'REAL_WORLD_VALIDATION_NOT_COMPLETED',
    };
    return {
      result, alreadyFinalized: false,
      boxCamObserved: { eligible: true, failed: [], combineVerified: false, combineVerifiedNote: 'Box Cam observed is not Combine Verified.' },
      provenance: 'box_cam_observed',
      combine: { eligible: false, reason: 'REAL_WORLD_VALIDATION_NOT_COMPLETED' },
      combineDisabledReason: {
        code: 'REAL_WORLD_VALIDATION_NOT_COMPLETED',
        short: 'Combine verification is not available yet for this protocol.',
        detail: 'Real-world validation has not been completed.',
      },
    };
  },
  async cancel() { return { cancelled: true, result: null }; },
};

export const m22: PlayerM22 = DEMO ? mock : live;
