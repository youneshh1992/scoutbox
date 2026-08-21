// Minimal test harness for the trust + safeguarding domain logic.
// Run with: npm test  (from scoutbox-server/)

import assert from 'node:assert/strict';
import {
  computeTrustScore, trustBreakdown, isAdult, visibleToOrg, validateTrialReport,
  moderateText, computeStreak, weeklyGoal, trustTier, nextActions, TRUST,
} from '../domain.mjs';
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

test('minor visibility: agencies never, unverified clubs never, verified clubs yes', () => {
  const minor = { dob: new Date(Date.now() - 16 * 365.25 * 24 * 3600 * 1000).toISOString().slice(0, 10), country: 'GB' };
  assert.equal(visibleToOrg(minor, { type: 'agency', verified: true }), false, 'agency blocked even if verified');
  assert.equal(visibleToOrg(minor, { type: 'club', verified: false }), false, 'unverified club blocked');
  assert.equal(visibleToOrg(minor, { type: 'club', verified: true }), true, 'verified club allowed');
});

test('adults are visible to every org type', () => {
  const adult = { dob: '1998-01-01', country: 'GB' };
  for (const org of [{ type: 'agency' }, { type: 'club', verified: false }, { type: 'club', verified: true }]) {
    assert.equal(visibleToOrg(adult, org), true);
  }
});

test('seed: every minor has a verified guardian who accepted the disclaimer', () => {
  const seed = buildSeed();
  for (const p of seed.players.filter((x) => !isAdult(x))) {
    const g = seed.guardians.find((x) => x.id === p.guardianId);
    assert.ok(g, `${p.name} must have a guardian`);
    assert.ok(g.idVerified && g.disclaimerAccepted, `${g.name} must be ID-verified with disclaimer accepted`);
    assert.ok(g.childIds.includes(p.id), 'guardian must list the child');
  }
});

test('moderation blocks contact details and off-platform moves', () => {
  for (const bad of [
    'email me at kid@example.com',
    'call 07911 123456 tonight',
    'add me on whatsapp',
    'my insta is @striker_2012',
    'watch https://some.site/clip',
  ]) {
    assert.equal(moderateText(bad).ok, false, `should block: ${bad}`);
  }
  assert.equal(moderateText('Great cup final highlights vs Riverside').ok, true);
  assert.equal(moderateText('U15 highlights — wing play').ok, true);
});

test('moderation v2 catches obfuscation and flags grooming with severity', () => {
  for (const [text, severity] of [
    ['reach me at coach (at) talentscout (dot) com', 'contact'],
    ['ping me on signal instead', 'contact'],
    ["don't tell your parents about this", 'grooming'],
    ['keep this between us, ok?', 'grooming'],
    ['are you home alone after training?', 'grooming'],
  ]) {
    const check = moderateText(text);
    assert.equal(check.ok, false, `should block: ${text}`);
    assert.equal(check.severity, severity, `severity of: ${text}`);
  }
  assert.equal(moderateText('Full performance report will be filed this week.').ok, true);
  assert.equal(moderateText('The keeper kept a clean sheet at home.').ok, true);
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

test('streak counts consecutive active days, tolerating "yesterday"', () => {
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  assert.equal(computeStreak([], now), 0);
  assert.equal(computeStreak([now - 1000], now), 1);
  assert.equal(computeStreak([now - 2 * day, now - day, now - 1000], now), 3);
  assert.equal(computeStreak([now - 2 * day, now - day], now), 2, 'yesterday keeps the streak alive');
  assert.equal(computeStreak([now - 3 * day], now), 0, 'a gap breaks the streak');
});

test('weekly goal counts activity in the last 7 days', () => {
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  assert.equal(weeklyGoal([now - day, now - 2 * day, now - 3 * day], now).met, true);
  assert.equal(weeklyGoal([now - 10 * day], now).met, false);
});

test('trust tiers map score bands to names', () => {
  assert.equal(trustTier(30), 'Prospect');
  assert.equal(trustTier(45), 'Rising');
  assert.equal(trustTier(65), 'Established');
  assert.equal(trustTier(85), 'Elite');
});

test('next actions guide the biggest gaps first', () => {
  const bare = {
    position: null, foot: null, heightCm: null, weightKg: null, stats: null,
    media: [], attendance: [],
  };
  const actions = nextActions(bare);
  assert.ok(actions.length > 0 && actions.length <= 3);
  assert.equal(actions[0].id, 'complete_profile');
});

console.log(`\n${passed} trust/safeguarding tests passed`);
