// The rules behind the clubOperations battery (e2e/operations/clubOperations.mjs), checked in this process: the
// battery's unit fixtures as they stood (TOTP against the RFC 6238 vectors, currency conversion, budget scenario
// totals, time-zone-aware slot overlap, the webhook SSRF guard and age boundaries by date of birth).
import { totp, totpValid, b32encode } from '../../../domains/identity/totp.mjs';
import { convertMinor } from '../../../domains/recruitment/money.mjs';
import { slotsOverlap } from '../../../domains/scouting/slots.mjs';
import { webhookUrlProblem } from '../../../domains/integrations/webhooks.mjs';
import { computeScenarioTotals } from '../../../domains/recruitment/budgets.mjs';
import { ageOn, isAdult } from '../../../domain.ts';
import { rulesSuite } from '../../rulesSuite.mjs';

process.env.ALLOW_LOCAL_WEBHOOKS = '1'; // the SSRF guard reads this at call time

const { ok, section, done } = rulesSuite('operations/clubOperations');

section('unit fixtures (pure helpers, controlled clocks)');
{
  // RFC 6238 TOTP test vectors (SHA-1, 30s): last 6 digits of the 8-digit codes.
  const rfcSecret = b32encode(Buffer.from('12345678901234567890'));
  ok(totp(rfcSecret, 59 * 1000) === '287082', 'TOTP matches RFC 6238 vector at t=59s');
  ok(totp(rfcSecret, 1111111109 * 1000) === '081804', 'TOTP matches RFC 6238 vector at t=1111111109s');
  ok(totp(rfcSecret, 1234567890 * 1000) === '005924', 'TOTP matches RFC 6238 vector at t=1234567890s');
  ok(
    totpValid(rfcSecret, totp(rfcSecret, 1_000_000_000_000), 1_000_000_000_000 + 29_000),
    'TOTP ±1 step drift window accepts an adjacent code',
  );
  ok(!totpValid(rfcSecret, '000000', 1_000_000_000_000), 'TOTP rejects a wrong code');

  ok(convertMinor(100000, '1.1732') === 117320, 'convertMinor: 1000.00 @ 1.1732 = 1173.20 (integer math)');
  ok(convertMinor(1, '0.5') === 1, 'convertMinor rounds half-up');
  ok(convertMinor(333, '0.3') === 100, 'convertMinor: 3.33 @ 0.3 = 1.00 (99.9 → 100 half-up)');
  ok(convertMinor(1000, 'not-a-rate') === null, 'convertMinor refuses a malformed rate');

  const scn = {
    currency: 'GBP',
    termMonths: 12,
    lines: [
      {
        id: 'w',
        kind: 'wage',
        label: 'wage',
        amountMinor: 50000,
        currency: 'GBP',
        schedule: 'weekly',
        confirmed: true,
        conditional: null,
      },
      {
        id: 'f',
        kind: 'fee',
        label: 'fee',
        amountMinor: 1_000_000,
        currency: 'GBP',
        schedule: 'one_off',
        confirmed: false,
        conditional: null,
      },
      {
        id: 'b',
        kind: 'bonus',
        label: 'promotion bonus',
        amountMinor: 2_000_000,
        currency: 'GBP',
        schedule: 'one_off',
        confirmed: false,
        conditional: { assumption: 'only if promoted' },
      },
    ],
    fxAssumptions: [],
  };
  const t1 = computeScenarioTotals(scn);
  ok(t1.perCurrency.GBP.confirmedMinor === 50000 * 52, 'weekly wage over 12 months = 52 occurrences (integer)');
  ok(t1.perCurrency.GBP.estimatedMinor === 1_000_000, 'estimated one-off counted once, separately from confirmed');
  ok(
    t1.combined.confirmedMinor === 2_600_000 && t1.combined.viaFx === false,
    'single-currency combined total needs no FX',
  );
  ok(
    t1.conditionalLines.length === 1 &&
      t1.perCurrency.GBP.confirmedMinor + t1.perCurrency.GBP.estimatedMinor === 3_600_000,
    'conditional bonus EXCLUDED from every total',
  );
  const scn18 = {
    ...scn,
    termMonths: 18,
    lines: [
      {
        id: 'a',
        kind: 'wage',
        label: 'x',
        amountMinor: 100,
        currency: 'GBP',
        schedule: 'annual',
        confirmed: true,
        conditional: null,
      },
    ],
  };
  ok(
    computeScenarioTotals(scn18).perCurrency.GBP.confirmedMinor === 200,
    'annual line over 18 months = 2 occurrences (ceil)',
  );
  const mixed = {
    ...scn,
    lines: [
      ...scn.lines.slice(0, 1),
      {
        id: 'e',
        kind: 'fee',
        label: 'eur fee',
        amountMinor: 500_000,
        currency: 'EUR',
        schedule: 'one_off',
        confirmed: true,
        conditional: null,
      },
    ],
  };
  ok(
    computeScenarioTotals(mixed).combined.unavailable === true,
    'mixed currencies WITHOUT a stated rate: combined total honestly unavailable',
  );
  const mixedFx = {
    ...mixed,
    fxAssumptions: [{ from: 'EUR', to: 'GBP', rate: '0.85', source: 'manual', date: '2026-09-01', manual: true }],
  };
  const tFx = computeScenarioTotals(mixedFx);
  ok(
    tFx.combined.viaFx === true && tFx.combined.confirmedMinor === 50000 * 52 + 425_000,
    'mixed currencies WITH a labelled manual rate combine correctly',
  );

  // Time zones: Tue 10:00–11:00 New York = Tue 15:00–16:00 UTC (ref date).
  const ny = { day: 'tue', start: '10:00', end: '11:00', tz: 'America/New_York' };
  ok(
    slotsOverlap(ny, { day: 'tue', start: '15:30', end: '16:30', tz: 'UTC' }) === true,
    'tz-aware overlap: NY morning hits UTC afternoon',
  );
  ok(
    slotsOverlap(ny, { day: 'tue', start: '10:00', end: '11:00', tz: 'UTC' }) === false,
    'same wall-clock in different zones does NOT overlap',
  );
  ok(
    slotsOverlap(
      { day: 'mon', start: '01:00', end: '02:00', tz: 'Pacific/Auckland' },
      { day: 'sun', start: '12:30', end: '13:30', tz: 'UTC' },
    ) === true,
    'week-boundary wrap via tz shift still compares',
  );
  ok(
    slotsOverlap({ day: 'xxx', start: '01:00', end: '02:00', tz: 'UTC' }, ny) === null,
    'malformed slot yields UNKNOWN, not false',
  );

  ok(
    webhookUrlProblem('http://127.0.0.1:9999/hook') === null,
    'loopback allowed under ALLOW_LOCAL_WEBHOOKS=1 (tests only)',
  );
  ok(webhookUrlProblem('https://10.0.0.5/hook') !== null, 'SSRF guard: private 10.x blocked');
  ok(
    webhookUrlProblem('https://169.254.169.254/latest/meta-data') !== null,
    'SSRF guard: link-local metadata endpoint blocked',
  );
  ok(webhookUrlProblem('https://internal-api.company.internal/x') !== null, 'SSRF guard: .internal hostnames blocked');
  ok(webhookUrlProblem('https://user:pw@example.com/x') !== null, 'SSRF guard: credentials in URL blocked');
  ok(webhookUrlProblem('ftp://example.com/x') !== null, 'SSRF guard: non-http(s) schemes blocked');
  ok(webhookUrlProblem('http://example.com/x') !== null, 'external destinations must use https');

  // ---- age boundaries by DOB with controlled evaluation dates.
  const at = new Date('2026-09-09T12:00:00Z');
  const dobYearsAgo = (y, extraDays = 0) => {
    const d = new Date(at);
    d.setFullYear(d.getFullYear() - y);
    d.setDate(d.getDate() + extraDays);
    return d.toISOString().slice(0, 10);
  };
  ok(
    ageOn(dobYearsAgo(16), at) === 16 && !isAdult({ dob: dobYearsAgo(16), country: 'GB' }, at),
    'boundary: a 16-year-old is NOT an adult (GB)',
  );
  ok(
    ageOn(dobYearsAgo(17), at) === 17 && !isAdult({ dob: dobYearsAgo(17), country: 'GB' }, at),
    'boundary: a 17-year-old is NOT an adult (GB)',
  );
  ok(isAdult({ dob: dobYearsAgo(18), country: 'GB' }, at), 'boundary: 18th birthday today IS adult (GB)');
  ok(!isAdult({ dob: dobYearsAgo(18, 1), country: 'GB' }, at), 'boundary: 18 years minus one day is NOT adult');
  ok(!isAdult({ dob: dobYearsAgo(18), country: 'KR' }, at), 'boundary: 18 in KR (majority 19) is NOT adult');
}

done();
