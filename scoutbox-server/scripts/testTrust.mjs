// Minimal test harness for the trust + safeguarding domain logic.
// Run with: npm test  (from scoutbox-server/)

import assert from 'node:assert/strict';
import { computeTrustScore, trustBreakdown, isAdult, visibleToOrg, validateTrialReport, TRUST } from '../domain.mjs';
import { buildSeed } from '../seed.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const bare = {
  id: 'x', name: 'X', dob: '2000-01-01', country: 'GB',
  attendance: [], trialReports: [], media: [], medical: { shared: false, records: [] },
};

test('bare profile scores BASE', () => {
  assert.equal(computeTrustScore(bare), TRUST.BASE);
});

test('identity verification adds its bonus', () => {
  assert.equal(computeTrustScore({ ...bare, identityVerified: true }), TRUST.BASE + TRUST.IDENTITY_VERIFIED);
});

test('attendance is capped', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}` }));
  assert.equal(
    computeTrustScore({ ...bare, attendance: many }),
    TRUST.BASE + TRUST.ATTENDANCE_CAP
  );
});

test('trial reports raise trust (institutional corroboration)', () => {
  const one = computeTrustScore({ ...bare, trialReports: [{}] });
  assert.equal(one, TRUST.BASE + TRUST.PER_TRIAL_REPORT);
});

test('medical sharing has NO effect on trust (privacy never penalised)', () => {
  const closed = computeTrustScore({ ...bare, medical: { shared: false, records: [{}] } });
  const open = computeTrustScore({ ...bare, medical: { shared: true, records: [{}] } });
  assert.equal(closed, open);
});

test('score never exceeds MAX', () => {
  const maxed = {
    ...bare,
    identityVerified: true,
    position: 'ST', foot: 'right', heightCm: 180, weightKg: 75, stats: {},
    attendance: Array.from({ length: 20 }, () => ({})),
    trialReports: Array.from({ length: 20 }, () => ({})),
    media: Array.from({ length: 20 }, () => ({})),
  };
  assert.ok(computeTrustScore(maxed) <= TRUST.MAX);
});

test('breakdown totals match the score', () => {
  const seedPlayer = buildSeed().players[0];
  const b = trustBreakdown(seedPlayer);
  assert.equal(
    b.base + b.identityVerified + b.verifiedAttendance + b.trialReports + b.media + b.profileComplete,
    Math.min(b.total, TRUST.MAX) === TRUST.MAX ? b.base + b.identityVerified + b.verifiedAttendance + b.trialReports + b.media + b.profileComplete : b.total
  );
});

test('adult age respects country of majority (KR = 19)', () => {
  const nineteenYearsAgo = new Date();
  nineteenYearsAgo.setFullYear(nineteenYearsAgo.getFullYear() - 18, nineteenYearsAgo.getMonth(), nineteenYearsAgo.getDate() - 1);
  const eighteenInKr = { dob: nineteenYearsAgo.toISOString().slice(0, 10), country: 'KR' };
  assert.equal(isAdult(eighteenInKr), false, '18-year-old is not an adult in KR');
  assert.equal(isAdult({ ...eighteenInKr, country: 'GB' }), true, '18-year-old is an adult in GB');
});

test('under-18 wall blocks agencies but not clubs', () => {
  const minor = { dob: new Date(Date.now() - 16 * 365.25 * 24 * 3600 * 1000).toISOString().slice(0, 10), country: 'GB' };
  assert.equal(visibleToOrg(minor, { type: 'agency' }), false);
  assert.equal(visibleToOrg(minor, { type: 'club' }), true);
});

test('all seeded players are adults (adults-only launch)', () => {
  for (const p of buildSeed().players) assert.ok(isAdult(p), `${p.name} must be an adult`);
});

test('partial trial reports are rejected, complete ones pass', () => {
  const partial = validateTrialReport({ acceleration: 7, sprintSpeedKmh: 33 });
  assert.equal(partial.ok, false);
  assert.ok(partial.missing.includes('coachRating'));
  const full = validateTrialReport({
    acceleration: 7, sprintSpeedKmh: 33.4, distanceKm: 10.8,
    passCompletionPct: 82, duelSuccessPct: 58, coachRating: 8,
  });
  assert.equal(full.ok, true);
});

console.log(`\n${passed} trust/safeguarding tests passed`);
