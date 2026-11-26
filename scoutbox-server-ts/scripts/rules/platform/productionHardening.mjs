// The rules behind the production hardening battery (e2e/platform/productionHardening.mjs) that are checked in this
// process: the concurrency token, the rate-limit policy and limiter, event audiences, the capability report and the
// production configuration refusals, the Passport revision, the change vocabulary and the provenance vocabulary.
import { expectedRevOf, revOf, bumpRev, revMeta } from '../../../domains/platform/concurrency.mjs';
import {
  RATE_LIMIT_POLICY,
  memoryRateLimitProvider,
  createRateLimiter,
  rateLimitedBody,
} from '../../../domains/platform/rateLimit.mjs';
import {
  AUDIENCES,
  EVENT_AUDIENCE,
  audienceFor,
  unclassifiedEvents,
} from '../../../domains/platform/eventAudience.mjs';
import { buildCapabilityReport, productionConfigProblems } from '../../../domains/platform/capabilities.mjs';
import { passportRevision, PROVENANCE, PROVENANCE_COPY } from '../../../domains/passport/shared.mjs';
import {
  CHANGE_TYPES,
  CHANGE_COPY,
  changeFingerprint,
  normalizeMaterialChange,
} from '../../../domains/discovery/shared.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('platform/productionHardening');

// ======================================================== unit: concurrency
section('§1 — the concurrency token is read strictly');
{
  ok(expectedRevOf({ expectedRev: 3 }) === 3, 'expectedRev is read');
  ok(expectedRevOf({ expectedVersion: 4 }) === 4, 'expectedVersion is accepted as the same thing');
  ok(expectedRevOf({}) === null, 'an absent token means "unchanged behaviour without a rev token", not rev 0');
  neg(Number.isNaN(expectedRevOf({ expectedRev: 'soon' })), 'a non-numeric token is malformed, never coerced to 0');
  neg(Number.isNaN(expectedRevOf({ expectedRev: 2.5 })), 'a fractional token is malformed');
  neg(Number.isNaN(expectedRevOf({ expectedRev: -1 })), 'a negative token is malformed');
  neg(expectedRevOf({ expectedRev: '' }) === null, 'an empty string is absent, not zero');
  ok(revOf({}) === 1 && revOf({ rev: 7 }) === 7, 'a record written before revs existed reads as rev 1');
}

section('§2 — an accepted mutation always moves the token');
{
  const rec = { rev: 1 };
  bumpRev(rec, { by: { id: 'u1', name: 'Maria Keane' }, at: 1000 });
  ok(rec.rev === 2 && rec.revAt === 1000, 'bump increments and stamps');
  ok(revMeta(rec).revBy === 'Maria Keane', 'the metadata names who touched it last');
  neg(!('userId' in revMeta(rec)), 'the metadata carries a display name, never an internal user id');
  bumpRev(rec, { at: 2000 });
  ok(rec.rev === 3 && revMeta(rec).revBy === null, 'a system write bumps without attributing itself to a person');
}

// ======================================================= unit: rate limiting
section('§15 — one policy table, every limited action named');
{
  const actions = Object.entries(RATE_LIMIT_POLICY);
  ok(actions.length >= 13, `${actions.length} named rate-limited actions`);
  ok(
    actions.every(([, p]) => Number.isInteger(p.max) && p.max > 0),
    'every action has a positive integer ceiling',
  );
  ok(
    actions.every(([, p]) => Number.isInteger(p.windowMs) && p.windowMs > 0),
    'every action has a window',
  );
  ok(
    actions.every(([, p]) => typeof p.scope === 'string' && p.scope),
    'every action states what its key is built from',
  );
  ok(
    actions.every(([, p]) => typeof p.note === 'string' && p.note),
    'every action says in words what it protects',
  );
  neg(
    !actions.some(([, p]) => /score|rank|quality/i.test(p.note)),
    'no rate limit is described as a judgement of the user',
  );
  const l = memoryRateLimitProvider();
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) l.consume('k', 3, 1000, t0);
  neg(l.consume('k', 3, 1000, t0).limited === true, 'the fourth call inside the window is limited');
  ok(l.consume('k', 3, 1000, t0 + 1001).limited === false, 'the window rolls');
  neg(l.consume('other', 3, 1000, t0).limited === false, 'limits do not leak between keys');
}

section('§16 — the limiter never claims protection it does not have');
{
  const rl = createRateLimiter({ provider: 'memory' });
  const cap = rl.capability();
  ok(cap.provider === 'memory', 'the memory provider is what is installed');
  neg(cap.distributed === false && cap.state === 'not_configured', 'it reports itself as NOT distributed');
  neg(/enforced across instances/.test(cap.note) === false, 'and its note does not claim cross-instance enforcement');
  ok(
    /per process/.test(cap.note) && /full quota/.test(cap.note),
    'the note spells out what breaks behind a load balancer',
  );
  let threw = null;
  try {
    createRateLimiter({ provider: 'redis' });
  } catch (e) {
    threw = e;
  }
  neg(!!threw && /not available/.test(threw.message), 'asking for a shared backend that does not exist fails loudly');
  neg(!/redis/i.test(JSON.stringify(rateLimitedBody('brief_write'))), 'the limited response names no backend');
  const body = rateLimitedBody('nobody_missed_action');
  neg(
    !/player|name|id/i.test(JSON.stringify(body).replace(/"action"[^,]*/, '')),
    'a limited response says nothing about the subject of the request',
  );
  let unknown = null;
  try {
    rl.limited('not_a_real_action', 'x');
  } catch (e) {
    unknown = e;
  }
  neg(!!unknown, 'an unnamed action is a programming error, not a silently unlimited route');
}

// ==================================================== unit: event audiences
section('§17 — every classified event has a real audience');
{
  const values = Object.values(EVENT_AUDIENCE);
  ok(
    values.length > 0 && values.every((a) => AUDIENCES.includes(a)),
    'every classification is one of the declared audiences',
  );
  ok(AUDIENCES.length === 6, 'six audiences, no catch-all "everyone"');
  neg(!AUDIENCES.includes('all'), 'there is no audience meaning "every connected identity"');
}

section('§18 — an unclassified event fails closed');
{
  ok(
    audienceFor('brand_new_event_nobody_classified') === 'org_private',
    'an unknown event is organisation-private, not public',
  );
  neg(
    audienceFor('brand_new_event_nobody_classified') !== 'public_safe',
    'it is emphatically NOT delivered to everyone',
  );
  neg(
    audienceFor(undefined) === 'org_private' && audienceFor(null) === 'org_private',
    'a missing event name also fails closed',
  );
  ok(unclassifiedEvents(['players', 'nope']).length === 1, 'the boot helper names exactly the unclassified events');
}

section('§19 — nothing personal is classified as public');
{
  const publicEvents = Object.entries(EVENT_AUDIENCE)
    .filter(([, a]) => a === 'public_safe')
    .map(([n]) => n);
  neg(
    !publicEvents.some((n) => /player_|guardian|evidence|notify|inbox|message|room|second_look/.test(n)),
    'no player-, guardian- or room-scoped event is public',
  );
  ok(EVENT_AUDIENCE.notify === 'player_private', 'a directed notification is private to its subject');
  ok(
    EVENT_AUDIENCE.recruitment_room_archived === 'org_private',
    'a room archival stays inside the organisation that decided it',
  );
  neg(
    EVENT_AUDIENCE.recruitment_room_archived !== 'player_private',
    'and it is not delivered to the player it is about',
  );
}

// ============================================= unit: capability reporting
section('§50 — the capability report is honest and carries no secrets');
{
  const rl = createRateLimiter({ provider: 'memory' });
  const report = buildCapabilityReport({
    env: {
      NODE_ENV: 'production',
      MEDIA_SECRET: 'super-secret-value-for-the-report-test-0123',
      SENDGRID_API_KEY: 'SG.synthetic-not-a-real-key',
    },
    rateLimit: rl,
    providers: [
      { id: 'web_client', status: 'limited', testOnly: false },
      { id: 'sim', status: 'configured', testOnly: true },
    ],
  });
  const raw = JSON.stringify(report);
  neg(!raw.includes('super-secret-value'), 'a configured secret VALUE never appears');
  neg(!raw.includes('SG.synthetic'), 'no provider credential appears');
  ok(report.capabilities.media_signing_secret.state === 'configured', 'it reports that the secret is configured');
  ok(report.capabilities.email_transport.state === 'configured', 'and that email is configured');
  ok(
    report.capabilities.distributed_rate_limit.state === 'not_configured',
    'and that the rate limiter is not distributed',
  );
}

section('§49 — capability states are not inflated');
{
  const providers = [
    { id: 'web_client', status: 'limited', testOnly: false },
    { id: 'sim', status: 'configured', testOnly: true },
  ];
  const off = buildCapabilityReport({ env: {}, providers });
  neg(
    off.capabilities.production_cv.state === 'not_configured',
    'a test-only provider that the environment has NOT enabled is not available capability',
  );
  neg(
    /observes player presence/.test(off.capabilities.production_cv.note),
    'the limited web capture is described by what it actually does',
  );
  const on = buildCapabilityReport({ env: { BOX_CAM_TEST_PROVIDER: '1' }, providers });
  ok(
    on.capabilities.production_cv.state === 'test_only',
    'with the simulator enabled it reports test_only, never configured',
  );
  const real = buildCapabilityReport({ env: {}, providers: [{ id: 'cv', status: 'configured', testOnly: false }] });
  ok(real.capabilities.production_cv.state === 'configured', 'a genuine detector reports configured');
  neg(
    buildCapabilityReport({ env: {}, providers: [{ id: 'web_client', status: 'limited' }] }).capabilities.production_cv
      .state !== 'configured',
    'a "limited" observer is never counted as production computer vision',
  );
}

section('§48 — boot refuses configuration that is unsafe in production');
{
  const prod = {
    NODE_ENV: 'production',
    MEDIA_SECRET: 'synthetic-media-secret-0123456789abcdef',
    BOX_CAM_TEST_PROVIDER: '1',
  };
  neg(
    productionConfigProblems({ env: prod }).some((p) => p.code === 'TEST_PROVIDER_IN_PRODUCTION' && p.fatal),
    'the simulated observer is fatal in production',
  );
  neg(
    productionConfigProblems({ env: { NODE_ENV: 'production' } }).some((p) => p.code === 'MEDIA_SECRET_MISSING'),
    'a missing media signing secret is fatal in production',
  );
  neg(
    productionConfigProblems({
      env: { NODE_ENV: 'production', MEDIA_SECRET: 'synthetic-media-secret-0123456789abcdef', ALLOW_DEV_LOGINS: '1' },
    }).some((p) => p.code === 'DEV_LOGIN_IN_PRODUCTION' && p.fatal),
    'dev login is fatal in production',
  );
  neg(
    productionConfigProblems({ env: {}, trustWeightsTotal: 95 }).some(
      (p) => p.code === 'TRUST_WEIGHTS_INVALID' && p.fatal,
    ),
    'Trust Score weights that do not total 100 are fatal in EVERY mode — a wrong score is not a development-only problem',
  );
  // The admin key and the synthetic licence register.
  const SAFE = {
    NODE_ENV: 'production',
    MEDIA_SECRET: 'synthetic-media-secret-0123456789abcdef',
    ADMIN_KEY: 'a-long-production-admin-key-0123',
  };
  neg(
    productionConfigProblems({
      env: { NODE_ENV: 'production', MEDIA_SECRET: 'synthetic-media-secret-0123456789abcdef' },
    }).some((p) => p.code === 'ADMIN_KEY_UNSAFE' && p.fatal),
    'an unset ADMIN_KEY is fatal in production (the T&S API would accept the public development key)',
  );
  neg(
    productionConfigProblems({ env: { ...SAFE, ADMIN_KEY: 'scoutbox-admin' } }).some(
      (p) => p.code === 'ADMIN_KEY_UNSAFE' && p.fatal,
    ),
    'the development default key is fatal in production',
  );
  neg(
    productionConfigProblems({ env: { ...SAFE, ADMIN_KEY: 'short' } }).some(
      (p) => p.code === 'ADMIN_KEY_UNSAFE' && p.fatal,
    ),
    'a trivially short key is fatal in production',
  );
  neg(
    productionConfigProblems({ env: { ...SAFE, AGENT_VERIFICATION_TEST_PROVIDER: '1' } }).some(
      (p) => p.code === 'AGENT_TEST_PROVIDER_IN_PRODUCTION' && p.fatal,
    ),
    'the synthetic agent licence register is fatal in production',
  );
  ok(
    productionConfigProblems({ env: SAFE, trustWeightsTotal: 100 }).length === 0,
    'a production configuration with its own admin key and no test provider passes',
  );
  ok(
    productionConfigProblems({ env: { AGENT_VERIFICATION_TEST_PROVIDER: '1' }, trustWeightsTotal: 100 }).length === 0,
    'development keeps the default admin key and the synthetic register',
  );
  ok(
    productionConfigProblems({ env: { BOX_CAM_TEST_PROVIDER: '1' }, trustWeightsTotal: 100 }).length === 0,
    'the same simulator configuration is fine in development (local development stays possible)',
  );
}

// ================================================= unit: Passport revision
section('§7 — the Passport revision is a fact about content, not about now');
{
  const full = {
    player: { position: 'CM', level: 'semi_pro' },
    identity: { confirmed: true, assurance: 'scoutbox_document_review' },
    status: { currentClub: { orgId: 'org-1', provenance: 'verified_club_confirmed' } },
    history: {
      rows: [
        {
          key: 'org-0',
          provenance: 'player_submitted',
          current: false,
          from: { t: Date.UTC(2022, 0, 1), precision: 'year', y: 2022 },
          to: { t: Date.UTC(2024, 0, 1), precision: 'year', y: 2024 },
          role: 'player',
        },
      ],
    },
    revisionSources: {
      evidence: [{ id: 'ev-1', tier: 'club_assessed', superseded: false, expired: false }],
      careerEntries: [{ id: 'ce-1' }],
    },
    references: [{ id: 'rf-1', status: 'active', provenanceStillCurrent: true }],
    achievements: [{ id: 'ac-1', confirmation: null, withdrawnAt: null }],
    combine: { results: [{ protocolId: 'p1', protocolVersion: 1, measuredValue: 12, combineVerified: true }] },
  };
  const a = passportRevision(full);
  const b = passportRevision(JSON.parse(JSON.stringify(full)));
  ok(/^pr_[0-9a-f]{16}$/.test(a), 'the revision is a short stable token');
  ok(a === b, 'the same Passport content produces the same revision');
  // Values that change with the clock must not move it.
  const withClockNoise = {
    ...full,
    player: { ...full.player, age: 21 },
    daysSinceLastEvidence: 900,
    generatedAt: Date.now(),
    summary: { recency: 'stale' },
  };
  neg(passportRevision(withClockNoise) === a, 'a revision computed a year later, from the same records, is identical');
}

section('§8 — the revision moves when Passport truth moves');
{
  const base = {
    player: { position: 'CM', level: 'semi_pro' },
    // The player's identity is unchecked (null) or confirmed by a ScoutBox document review: the only two states.
    identity: null,
    status: { currentClub: null },
    history: { rows: [] },
    revisionSources: { evidence: [], careerEntries: [] },
    references: [],
    achievements: [],
    combine: { results: [] },
  };
  const r0 = passportRevision(base);
  neg(
    passportRevision({ ...base, player: { position: 'ST', level: 'semi_pro' } }) !== r0,
    'a position change moves it',
  );
  neg(
    passportRevision({ ...base, identity: { confirmed: true, assurance: 'scoutbox_document_review' } }) !== r0,
    'an identity assurance change moves it',
  );
  neg(
    passportRevision({
      ...base,
      status: { currentClub: { orgId: 'org-9', provenance: 'verified_club_confirmed' } },
    }) !== r0,
    'gaining a confirmed current club moves it',
  );
  neg(
    passportRevision({
      ...base,
      revisionSources: {
        evidence: [{ id: 'e', tier: 'club_assessed', superseded: false, expired: false }],
        careerEntries: [],
      },
    }) !== r0,
    'a new piece of evidence moves it',
  );
  neg(
    passportRevision({
      ...base,
      revisionSources: {
        evidence: [{ id: 'e', tier: 'club_assessed', superseded: true, expired: false }],
        careerEntries: [],
      },
    }) !==
      passportRevision({
        ...base,
        revisionSources: {
          evidence: [{ id: 'e', tier: 'club_assessed', superseded: false, expired: false }],
          careerEntries: [],
        },
      }),
    'SUPERSEDING evidence moves it too — removal is a change, not an absence',
  );
}

// ================================================== unit: change vocabulary
section('§11 — one source row is one change, however many projections see it');
{
  const mk = (sourceSystem, sourceId) =>
    normalizeMaterialChange({
      type: 'combine_verified_invalidated',
      subjectId: 'pl-1',
      sourceSystem,
      sourceId,
      occurredAt: 1_700_000_000_000,
    });
  const viaSession = mk('box_cam', 'sess-9');
  const viaSessionAgain = mk('box_cam', 'sess-9');
  ok(viaSession.fingerprint === viaSessionAgain.fingerprint, 'the same canonical session fingerprints identically');
  neg(mk('box_cam', 'sess-8').fingerprint !== viaSession.fingerprint, 'a different session is a different change');
  neg(
    changeFingerprint({ type: 'combine_verified_invalidated', sourceSystem: 'combine', sourceId: 'sess-9' }) !==
      changeFingerprint({ type: 'combine_verified_invalidated', sourceSystem: 'box_cam', sourceId: 'sess-9' }),
    'fingerprinting on the projection instead of the canonical row WOULD double-count — which is why it is the session id',
  );
}

section('§12 — the invalidation vocabulary exists and reads honestly');
{
  ok(CHANGE_TYPES.includes('combine_verified_invalidated'), 'invalidation is a first-class change type');
  ok(
    CHANGE_TYPES.includes('combine_verified_restored'),
    'restoration is too — it is not the absence of an invalidation',
  );
  for (const t of ['combine_verified_invalidated', 'combine_verified_restored']) {
    ok(typeof CHANGE_COPY[t] === 'string' && CHANGE_COPY[t].length > 20, `${t} has human copy`);
    neg(!/cheat|fake|fraud|dishonest|lied/i.test(CHANGE_COPY[t]), `${t} copy accuses nobody`);
  }
}

section('§40 — one provenance vocabulary, total and ranked');
{
  ok(PROVENANCE.length === 9, 'nine provenance values');
  ok(
    PROVENANCE.every((p) => typeof PROVENANCE_COPY[p] === 'string' && PROVENANCE_COPY[p].length > 20),
    'every one has honest copy',
  );
  ok(
    PROVENANCE.indexOf('box_cam_observed') > PROVENANCE.indexOf('player_submitted'),
    'Box Cam observation outranks a self-submission',
  );
  neg(
    PROVENANCE.indexOf('box_cam_observed') < PROVENANCE.indexOf('scoutbox_reviewed'),
    'and is deliberately weaker than a ScoutBox review',
  );
  ok(
    /observed training, not football ability/i.test(PROVENANCE_COPY.box_cam_observed),
    'its copy refuses to imply ability',
  );
}

done();
