/// <reference types="jest" />
// The app's mirror of the server's Trust Score arithmetic (used offline and in
// demo mode): every component is capped, the sum is capped at MAX, and the
// score never exceeds 99.
import { TRUST, computeTrustScore, trustBreakdown } from '../domain/trustScore';
import type { PlayerProfile } from '../domain/types';

/** A profile with nothing that earns trust; fields the arithmetic reads are explicit, the rest is the minimum the type needs. */
const bare = (over: Partial<PlayerProfile> = {}): PlayerProfile => ({
  id: 'pl-test', name: 'Test Player', dob: '2000-01-01', country: 'GB', city: 'Testville',
  position: null, foot: null, heightCm: null, weightKg: null, stats: null,
  academyPlus: false, badges: [], identityVerified: false, attendance: [], timeline: [],
  ...over,
} as PlayerProfile);
const n = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `x-${i}` })) as never;

describe('trustBreakdown', () => {
  test('an empty profile scores the base alone', () => {
    expect(trustBreakdown(bare())).toEqual({ base: TRUST.BASE, identityVerified: 0, verifiedAttendance: 0, trialReports: 0, media: 0, profileComplete: 0, total: TRUST.BASE });
    expect(computeTrustScore(bare())).toBe(30);
  });

  test('each evidence component is capped', () => {
    expect(trustBreakdown(bare({ attendance: n(1) })).verifiedAttendance).toBe(TRUST.PER_ATTENDANCE);
    expect(trustBreakdown(bare({ attendance: n(10) })).verifiedAttendance).toBe(TRUST.ATTENDANCE_CAP);
    expect(trustBreakdown(bare({ trialReports: n(2) })).trialReports).toBe(2 * TRUST.PER_TRIAL_REPORT);
    expect(trustBreakdown(bare({ trialReports: n(9) })).trialReports).toBe(TRUST.TRIAL_REPORT_CAP);
    expect(trustBreakdown(bare({ media: n(3) })).media).toBe(3 * TRUST.PER_MEDIA);
    expect(trustBreakdown(bare({ media: n(50) })).media).toBe(TRUST.MEDIA_CAP);
  });

  test('a missing array counts as nothing rather than throwing', () => {
    const p = bare({ attendance: undefined as never, media: undefined, trialReports: undefined });
    expect(() => trustBreakdown(p)).not.toThrow();
    expect(trustBreakdown(p).total).toBe(TRUST.BASE);
  });

  test('identity verification adds its fixed amount', () => {
    expect(trustBreakdown(bare({ identityVerified: true })).identityVerified).toBe(TRUST.IDENTITY_VERIFIED);
  });

  test('the profile bonus needs every one of position, foot, height, weight and stats', () => {
    const full = { position: 'ST', foot: 'R', heightCm: 180, weightKg: 75, stats: { appearances: 1, goals: 0, assists: 0 } } as const;
    expect(trustBreakdown(bare(full)).profileComplete).toBe(TRUST.PROFILE_COMPLETE);
    expect(trustBreakdown(bare({ ...full, foot: null })).profileComplete).toBe(0);
    expect(trustBreakdown(bare({ ...full, stats: null })).profileComplete).toBe(0);
  });

  test('every component at its cap sums to exactly MAX, and nothing can exceed it', () => {
    const maxed = bare({ identityVerified: true, attendance: n(99), trialReports: n(99), media: n(99), position: 'GK', foot: 'L', heightCm: 190, weightKg: 85, stats: { appearances: 9, goals: 0, assists: 0 } });
    const b = trustBreakdown(maxed);
    expect(b.base + b.identityVerified + b.verifiedAttendance + b.trialReports + b.media + b.profileComplete).toBe(TRUST.MAX);
    expect(b.total).toBe(TRUST.MAX);
    expect(computeTrustScore(maxed)).toBeLessThanOrEqual(99);
  });
});
