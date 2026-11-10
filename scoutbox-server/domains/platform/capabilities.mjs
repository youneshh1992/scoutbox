/**
 * Capability reporting and production boot checks. `/capabilities` reports
 * states only, never keys, hostnames or connection strings.
 */

import { combineVerifiedProtocols } from '../development/boxcam/cv/eligibility.mjs';
import { parseTrustProxy } from '../../httpTrust.mjs';
export const CAPABILITY_STATES = ['configured', 'not_configured', 'test_only'];

/**
 * Passwordless logins and the local test identity provider. There is no
 * production override: ALLOW_DEV_LOGINS in production is refused at boot.
 */
export const devLoginsEnabled = (env = process.env) => env.NODE_ENV !== 'production';

/** Whether a first boot loads the demo world. Later boots never seed. */
export const demoSeedEnabled = (env = process.env) => (
  env.SCOUTBOX_SEED_DEMO === '1' ? true : env.SCOUTBOX_SEED_DEMO === '0' ? false : env.NODE_ENV !== 'production'
);

/** Whether requests may pin their own time with the test-clock header (clock.mjs). Refused in production at boot. */
export const testClockEnabled = (env = process.env) => env.SCOUTBOX_TEST_CLOCK === '1' && env.NODE_ENV !== 'production';

const isSet = (v) => v != null && String(v).trim() !== '';

/** The mail adapter sends through SendGrid when this holds; otherwise it writes the local outbox. */
export const liveMailConfigured = (env = process.env) => isSet(env.SENDGRID_API_KEY);
/** The push adapter sends through Expo when this holds; otherwise it writes the local push log. */
export const livePushConfigured = (env = process.env) => isSet(env.EXPO_ACCESS_TOKEN);

export function buildCapabilityReport({ env = process.env, rateLimit = null, providers = [], trustProxy = null, extra = {} } = {}) {
  const flag = (v) => !!v && String(v).trim() !== '';
  const proxy = trustProxy ?? parseTrustProxy(env.SCOUTBOX_TRUST_PROXY);
  const devLogins = devLoginsEnabled(env);

  // Production CV means a provider that can classify technique and count repetitions. `web_client` is `limited`:
  // it infers only presence and active duration. A test-only provider counts only when the environment enables it.
  const testProviderEnabled = env.BOX_CAM_TEST_PROVIDER === '1';
  const usable = providers.filter((p) => p.status === 'configured' && (!p.testOnly || testProviderEnabled));
  const productionCv = usable.filter((p) => !p.testOnly);
  const testOnlyAvailable = usable.some((p) => p.testOnly);
  const limitedOnly = providers.some((p) => p.status === 'limited' && !p.testOnly);

  return {
    generatedAt: Date.now(),
    mode: env.NODE_ENV === 'production' ? 'production' : 'development',
    capabilities: {
      production_cv: {
        state: productionCv.length ? 'configured' : (testOnlyAvailable ? 'test_only' : 'not_configured'),
        note: productionCv.length
          ? 'Box Cam uses server-side computer vision to observe supported activity. Combine verification for these CV protocols remains disabled pending real-world validation.'
          : `No production computer-vision provider is configured.${limitedOnly ? ' Web capture observes player presence and active duration only — it cannot count repetitions or classify technique.' : ''} Combine metrics that need a real detector are reported as unsupported, never estimated.`,
        // `state: configured` alone would suggest CV measurements are available; these say otherwise.
        serverSideObservation: productionCv.length > 0,
        syntheticEvaluation: productionCv.length ? 'passed' : 'not_run',
        realWorldValidation: 'not_completed',
        combineVerifiedProtocols: combineVerifiedProtocols(),
        combineVerificationAvailable: combineVerifiedProtocols().length > 0,
        // No REAL_WORLD_VALIDATION_NOT_COMPLETED code here: its shape trips the secret-scan heuristic on this
        // unauthenticated endpoint, and `realWorldValidation` already carries the reason.
      },
      distributed_rate_limit: rateLimit
        ? { state: rateLimit.capability().state, note: rateLimit.capability().note }
        : { state: 'not_configured', note: 'No rate limiter is installed.' },
      // No real identity-verification or object-storage provider is integrated
      // (adapters.mjs), so no environment can make these configured.
      authoritative_identity_provider: {
        state: 'not_configured',
        note: 'Without one, the strongest identity a player can hold is a ScoutBox document review, which is scored below authoritative.',
      },
      email_transport: {
        // Neither configured nor absent: mail goes to a local outbox and never leaves the machine.
        state: liveMailConfigured(env) ? 'configured' : 'local_outbox',
        note: 'Without a transport, invitations and notifications are recorded in the local outbox and the delivery centre, and are not sent anywhere.',
      },
      object_storage: {
        state: 'not_configured',
        note: 'Media is stored on the local disk of this instance.',
      },
      media_signing_secret: {
        state: flag(env.MEDIA_SECRET) ? 'configured' : 'not_configured',
        note: 'A per-deployment secret (MEDIA_SECRET). Without one, development signs with a random key per process, so links stop working after a restart; production refuses to start.',
      },
      box_cam_test_provider: {
        state: env.BOX_CAM_TEST_PROVIDER === '1' ? 'test_only' : 'not_configured',
        note: 'The clearly-labelled simulated observer. Its results never count as production evidence.',
      },
      // The only issuer is the local test identity provider, so production has no staff SSO.
      staff_sso: {
        state: devLogins ? 'test_only' : 'not_configured',
        note: devLogins
          ? 'Only the local test identity provider is available; it exercises the relying-party logic and never links an account that was not invited.'
          : 'No staff identity provider is configured; staff sign in with organisation credentials. The local test provider is disabled outside development.',
      },
      // Per-IP limits key on the client address; behind a proxy, unset means one shared client.
      proxy_trust: { state: proxy.state, note: proxy.note },
      core_identity_storage: {
        state: 'live',
        note: 'Players, guardians and guardian–child links are table-backed (migration 0005); writes go through the identity repositories and multi-domain operations run inside the store\'s unit of work.',
      },
    },
    ...extra,
    note: 'Capability states only. This report contains no keys, hostnames or connection details.',
  };
}

export const MEDIA_SECRET_MIN_LENGTH = 32;

/** No such integration exists, so setting one in production is refused rather than silently ignored. */
export const UNIMPLEMENTED_PROVIDER_VARIABLES = Object.freeze({
  ONFIDO_API_TOKEN: 'identity verification (guardian ID checks still auto-approve)',
  STRIPE_SECRET_KEY: 'billing (success fees are recorded in the local ledger only)',
  S3_BUCKET: 'object storage (media is stored on this instance\'s disk)',
});

/** Unsafe production configuration. The caller throws on the result in production. */
export function productionConfigProblems({ env = process.env, trustWeightsTotal = null } = {}) {
  const problems = [];
  const production = env.NODE_ENV === 'production';
  const flagged = (v) => v != null && String(v).trim() !== '';

  if (trustWeightsTotal != null && trustWeightsTotal !== 100) {
    problems.push({
      code: 'TRUST_WEIGHTS_INVALID',
      message: `Trust Score component weights total ${trustWeightsTotal}, not 100.`,
      fatal: true,
    });
  }
  if (production && env.BOX_CAM_TEST_PROVIDER === '1') {
    problems.push({
      code: 'TEST_PROVIDER_IN_PRODUCTION',
      message: 'BOX_CAM_TEST_PROVIDER=1 enables the simulated observer. Simulated captures must never be reachable in production.',
      fatal: true,
    });
  }
  // A signed media URL grants access to a player's footage, so its key must be stable, private and unguessable.
  if (production && String(env.MEDIA_SECRET ?? '').length < MEDIA_SECRET_MIN_LENGTH) {
    problems.push({
      code: 'MEDIA_SECRET_MISSING',
      message: `MEDIA_SECRET is unset or shorter than ${MEDIA_SECRET_MIN_LENGTH} characters; signed media URLs need a stable secret of the deployment's own.`,
      fatal: true,
    });
  }
  for (const [name, what] of Object.entries(UNIMPLEMENTED_PROVIDER_VARIABLES)) {
    if (production && flagged(env[name])) {
      problems.push({
        code: 'PROVIDER_NOT_IMPLEMENTED',
        message: `${name} is set, but no real provider is integrated for ${what}.`,
        fatal: true,
      });
    }
  }
  if (flagged(env.SCOUTBOX_SEED_DEMO) && !['0', '1'].includes(env.SCOUTBOX_SEED_DEMO)) {
    problems.push({
      code: 'SEED_DEMO_INVALID',
      message: 'SCOUTBOX_SEED_DEMO must be 1 (load the demo world on first boot) or 0 (start empty).',
      fatal: true,
    });
  }
  // Refused rather than ignored: whoever set it expects behaviour that does not exist.
  if (production && flagged(env.ALLOW_DEV_LOGINS)) {
    problems.push({
      code: 'DEV_LOGIN_IN_PRODUCTION',
      message: 'ALLOW_DEV_LOGINS is set. Passwordless demo logins are never available in production; give demo accounts real passwords instead.',
      fatal: true,
    });
  }
  // The fault middleware is inert in production, but setting it means a dev environment was copied.
  if (production && env.SCOUTBOX_FAULTS) {
    problems.push({
      code: 'FAULTS_IN_PRODUCTION',
      message: 'SCOUTBOX_FAULTS is set. Simulated failures must never be configured on a production instance.',
      fatal: true,
    });
  }
  // A client that can set its own clock could, for example, answer an Offer after it expired.
  if (production && flagged(env.SCOUTBOX_TEST_CLOCK)) {
    problems.push({
      code: 'TEST_CLOCK_IN_PRODUCTION',
      message: 'SCOUTBOX_TEST_CLOCK is set. Requests must never choose their own time on a production instance.',
      fatal: true,
    });
  }
  // `scoutbox-admin` is the publicly known development key.
  if (production && (!env.ADMIN_KEY || env.ADMIN_KEY === 'scoutbox-admin' || String(env.ADMIN_KEY).length < 16)) {
    problems.push({
      code: 'ADMIN_KEY_UNSAFE',
      message: 'ADMIN_KEY is unset, is the development default or is shorter than 16 characters; the Trust & Safety API would accept a publicly known key.',
      fatal: true,
    });
  }
  // It verifies any `TEST-VERIFIED-*` reference, so an agent could self-verify a licence.
  if (production && env.AGENT_VERIFICATION_TEST_PROVIDER === '1') {
    problems.push({
      code: 'AGENT_TEST_PROVIDER_IN_PRODUCTION',
      message: 'AGENT_VERIFICATION_TEST_PROVIDER=1 enables the synthetic licence register, which verifies any TEST-VERIFIED reference.',
      fatal: true,
    });
  }
  // Its routes already refuse outside development; the secret here means a dev environment was copied.
  if (production && flagged(env.TEST_IDP_SECRET)) {
    problems.push({
      code: 'TEST_IDP_IN_PRODUCTION',
      message: 'TEST_IDP_SECRET is set. The local test identity provider must never be configured on a production instance.',
      fatal: true,
    });
  }
  // An unparseable value would key every per-IP limit on the proxy's own address.
  if (production && parseTrustProxy(env.SCOUTBOX_TRUST_PROXY).state === 'invalid') {
    problems.push({
      code: 'TRUST_PROXY_INVALID',
      message: `SCOUTBOX_TRUST_PROXY=${JSON.stringify(String(env.SCOUTBOX_TRUST_PROXY))} is not a hop count, true/false, or a list of addresses and subnets.`,
      fatal: true,
    });
  }
  return problems;
}
