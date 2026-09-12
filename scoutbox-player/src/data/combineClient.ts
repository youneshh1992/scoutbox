// M16.1 — At-Home Combine: standardized, measurable tests recorded live with
// Box Cam. This is a MEASUREMENT LAYER over Box Cam, not a second camera: each
// Combine Attempt binds a server-minted Box Cam session, and the measured
// value, the Combine state ('combine_verified' | 'partially_measured' | …) and
// the "Combine Verified" provenance are ALL derived server-side and returned
// here — this client never asserts a number, a state or a verification. The
// demo mirror simulates observations honestly and always labels them as an
// "At-Home Combine demo — simulated Box Cam observations".
import { m12Request as req } from './httpClient';
import type { BoxEvent } from './m16client';
import { combineMock } from './combineMock';

const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';

export interface CombineProtocol {
  id: string; version: number; title: string; category: string; description: string;
  metricType: string; metricUnit: string; direction: string; precision: string;
  protocolWindowMs: number; requiredCapabilities: string[];
  measurementCapability: 'configured' | 'not_configured'; demoSupported: boolean;
  setupRequirements: string; cameraRequirements?: string; spaceRequirements?: string;
  equipmentRequirements?: string[]; calibrationRequirements: string[];
  startRule?: string; finishRule?: string; validAttemptRules?: string;
  scoringMethod: string; maxVerifiedPerWindow: number; practiceAllowed: boolean;
  safetyNotes: string; status: string; unsupportedNote: string | null;
}
export interface VerificationCheck { label: string; ok: boolean; detail?: string }
export interface CombineAttempt {
  id: string; playerId: string; protocolId: string; protocolVersion: number; protocolTitle: string;
  metricType: string; metricUnit: string; direction: string; mode: 'verified' | 'practice';
  captureContext: string; requestId: string | null; attemptNumber: number;
  measuredValue: number | null; display: string; unit: string;
  measurementState: string | null;
  // The server's COMBINE_STATES in full. The earlier union was missing
  // `integrity_review`, `processing`, `attempt_in_progress`, `setup_required`
  // and `not_started`, all of which the server does send — so the client type
  // asserted states it could actually receive were impossible.
  combineState:
    | 'not_started' | 'setup_required' | 'ready' | 'attempt_in_progress' | 'processing'
    | 'combine_verified' | 'partially_measured' | 'measurement_unavailable'
    | 'protocol_invalid' | 'integrity_review' | 'invalidated' | 'cancelled';
  stateCopy: string | null; reasons: string[];
  provider: string; providerVersion: number; simulated: boolean;
  calibration: { required: string[]; passed: boolean; checks: string[]; at: number } | null;
  startedAt: number | null; completedAt: number | null; createdAt: number;
  provenance: string | null; provenanceLabel: 'Combine Verified' | null;
  verificationExplained: VerificationCheck[] | null;
  boxSessionId?: string; resultHash?: string | null;
}
export interface CombineRequest {
  id: string; orgId: string; orgName: string; title: string | null;
  requestedBy: { userId: string; name: string; role: string | null; at: number } | null;
  playerId: string;
  protocols: { protocolId: string; protocolTitle: string; completed: boolean }[];
  deadline: string | null; instructions: string | null;
  state: 'requested' | 'completed' | 'cancelled'; createdAt: number;
  completedCount: number; requiredCount: number; note: string | null;
}
export interface CombineOverview {
  verifiedResults: CombineAttempt[]; personalBests: number; attempts: CombineAttempt[];
  activeRequests: CombineRequest[]; capabilityNote: string;
}
export interface CombineCardResult { protocolId: string; protocolTitle: string; display: string; unit: string; combineVerified: boolean; protocolVersion: number; completedAt: number }
export interface CombineCard {
  player: { id: string; name: string; age: number | null; position: string | null };
  results: CombineCardResult[]; capturedBy: string; updatedAt: number; note: string;
}
export interface CreatedAttempt {
  attempt: CombineAttempt; boxSession: { id: string } & Record<string, unknown>;
  nonce: string; livenessChallenge: string; livenessNote: string; expiresAt: number;
  protocol: CombineProtocol; readyCheck: { automated: string[]; unableToCheckAutomatically: string[] };
  calibration: { required: string[]; note: string };
}

export type CombineActor = { kind: 'player'; id: string } | { kind: 'guardian'; id: string; childId: string };
const base = (a: CombineActor) => a.kind === 'player' ? '/player/combine' : `/guardian/children/${a.childId}/combine`;

export interface CombineClient {
  protocols(playerId: string): Promise<{ protocols: CombineProtocol[]; productionProvider: { id: string; status: string; label: string; capabilities: string[] }; testProviderEnabled: boolean; note: string }>;
  overview(a: CombineActor): Promise<CombineOverview>;
  card(playerId: string): Promise<CombineCard>;
  requests(a: CombineActor): Promise<CombineRequest[]>;
  createAttempt(playerId: string, body: { protocolId: string; mode: 'verified' | 'practice'; provider: string; captureContext: string; requestId?: string }): Promise<CreatedAttempt>;
  calibrate(playerId: string, id: string, checks: string[]): Promise<{ attempt: CombineAttempt; calibrationPassed: boolean }>;
  // The bound Box Cam session is driven with the EXISTING box-cam endpoints.
  startBox(playerId: string, boxSessionId: string, nonce: string, liveness: string): Promise<{ session: Record<string, unknown> }>;
  sendBoxEvents(playerId: string, boxSessionId: string, nonce: string, batch: BoxEvent[]): Promise<{ accepted: number; lastSeq: number }>;
  complete(playerId: string, id: string, nonce: string): Promise<{ attempt: CombineAttempt; boxSession: Record<string, unknown> }>;
  cancel(playerId: string, id: string): Promise<{ attempt: CombineAttempt }>;
}

const live: CombineClient = {
  protocols: (playerId) => req('/player/combine/protocols', playerId),
  overview: (a) => req(`${base(a)}`, a.id),
  card: (playerId) => req('/player/combine/card', playerId),
  requests: async (a) => (await req<{ items: CombineRequest[] }>(`${base(a)}/requests`, a.id)).items,
  createAttempt: (playerId, body) => req('/player/combine/attempts', playerId, { method: 'POST', body: JSON.stringify(body) }),
  calibrate: (playerId, id, checks) => req(`/player/combine/attempts/${id}/calibrate`, playerId, { method: 'POST', body: JSON.stringify({ checks }) }),
  startBox: (playerId, boxSessionId, nonce, liveness) => req(`/player/box-cam/sessions/${boxSessionId}/start`, playerId, { method: 'POST', body: JSON.stringify({ nonce, liveness }) }),
  sendBoxEvents: (playerId, boxSessionId, nonce, batch) => req(`/player/box-cam/sessions/${boxSessionId}/events`, playerId, { method: 'POST', body: JSON.stringify({ nonce, batch }) }),
  complete: (playerId, id, nonce) => req(`/player/combine/attempts/${id}/complete`, playerId, { method: 'POST', body: JSON.stringify({ nonce }) }),
  cancel: (playerId, id) => req(`/player/combine/attempts/${id}/cancel`, playerId, { method: 'POST', body: JSON.stringify({}) }),
};

export const combine: CombineClient = DEMO ? combineMock : live;
