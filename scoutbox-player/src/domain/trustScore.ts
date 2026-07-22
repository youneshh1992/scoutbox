// Trust Score — MIRRORS scoutbox-server/domain.mjs. The server computes the
// authoritative score; this copy renders the breakdown offline / in demo mode.

import type { PlayerProfile } from './types';

export const TRUST = {
  BASE: 30,
  IDENTITY_VERIFIED: 10,
  PER_ATTENDANCE: 5,
  ATTENDANCE_CAP: 20,
  PER_TRIAL_REPORT: 8,
  TRIAL_REPORT_CAP: 24,
  PER_MEDIA: 2,
  MEDIA_CAP: 10,
  PROFILE_COMPLETE: 5,
  MAX: 99,
} as const;

export interface TrustBreakdown {
  base: number;
  identityVerified: number;
  verifiedAttendance: number;
  trialReports: number;
  media: number;
  profileComplete: number;
  total: number;
}

export function computeTrustScore(p: PlayerProfile): number {
  return trustBreakdown(p).total;
}

export function trustBreakdown(p: PlayerProfile): TrustBreakdown {
  const b = {
    base: TRUST.BASE,
    identityVerified: p.identityVerified ? TRUST.IDENTITY_VERIFIED : 0,
    verifiedAttendance: Math.min((p.attendance?.length ?? 0) * TRUST.PER_ATTENDANCE, TRUST.ATTENDANCE_CAP),
    trialReports: Math.min((p.trialReports?.length ?? 0) * TRUST.PER_TRIAL_REPORT, TRUST.TRIAL_REPORT_CAP),
    media: Math.min((p.media?.length ?? 0) * TRUST.PER_MEDIA, TRUST.MEDIA_CAP),
    profileComplete: p.position && p.foot && p.heightCm && p.weightKg && p.stats ? TRUST.PROFILE_COMPLETE : 0,
  };
  const total = Math.min(
    b.base + b.identityVerified + b.verifiedAttendance + b.trialReports + b.media + b.profileComplete,
    TRUST.MAX
  );
  return { ...b, total };
}
