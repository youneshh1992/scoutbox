/**
 * Operator-facing capability reporting and boot assertions: what this
 * deployment can and cannot do (is a real identity provider configured? is CV
 * production-grade?), and which configurations refuse to boot in production.
 *
 * `/capabilities` reports state, never secrets: no keys, no hostnames, no
 * connection strings — only whether a capability is configured, and one
 * sentence on what its absence means.
 */

import { combineVerifiedProtocols } from '../development/boxcam/cv/eligibility.mjs';
import { parseTrustProxy } from '../../httpTrust.mjs';
export const CAPABILITY_STATES = ['configured', 'not_configured', 'test_only'];

/**
 * The one rule for development shortcuts: seeded passwordless logins,
 * credential-less org logins and the local test identity provider. They exist
 * in development only. There is no production override: a production boot
 * with ALLOW_DEV_LOGINS set is refused (productionConfigProblems).
 */
export const devLoginsEnabled = (env = process.env) => env.NODE_ENV !== 'production';

/**
 * Whether a first boot (a data directory never saved to) loads the demo
 * people and clubs. Development does unless SCOUTBOX_SEED_DEMO=0; production
 * starts with the product catalogues only unless SCOUTBOX_SEED_DEMO=1. Later
 * boots never seed: the saved database is authoritative.
 */
export const demoSeedEnabled = (env = process.env) => (
  env.SCOUTBOX_SEED_DEMO === '1' ? true : env.SCOUTBOX_SEED_DEMO === '0' ? false : env.NODE_ENV !== 'production'
);

/**
 * Whether requests may pin their own time with the test-clock header (clock.mjs). Development only: a production
 * boot with SCOUTBOX_TEST_CLOCK set is refused (productionConfigProblems).
 */
export const testClockEnabled = (env = process.env) => env.SCOUTBOX_TEST_CLOCK === '1' && env.NODE_ENV !== 'production';

const isSet = (v) => v != null && String(v).trim() !== '';

/** The mail adapter sends through SendGrid when this holds; otherwise it writes the local outbox. */
export const liveMailConfigured = (env = process.env) => isSet(env.SENDGRID_API_KEY);
/** The push adapter sends through Expo when this holds; otherwise it writes the local push log. */
export const livePushConfigured = (env = process.env) => isSet(env.EXPO_ACCESS_TOKEN);

// The Combine gate is read from eligibility.mjs, not restated, so every
// surface follows one definition.
export function buildCapabilityReport({ env = process.env, rateLimit = null, providers = [], trustProxy = null, extra = {} } = {}) {
  const flag = (v) => !!v && String(v).trim() !== '';
  const proxy = trustProxy ?? parseTrustProxy(env.SCOUTBOX_TRUST_PROXY);
  const devLogins = devLoginsEnabled(env);

  // "Production CV" means a provider that can genuinely OBSERVE — classify
  // technique, count repetitions. `web_client` is deliberately `limited`: it
  // infers presence and active duration from the camera stream and nothing
  // more, and reporting that as production computer vision would be exactly
  // the kind of capability inflation the rest of the product refuses to do.
  // A test-only provider is REACHABLE only when the environment enables it, so
  // its mere presence in the registry says nothing about this deployment.
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
        // The four facts that must never collapse into one word. A
        // reader who sees only `state: configured` would reasonably conclude
        // that CV measurements are available; these say otherwise, in the
        // same object, without needing a second request.
        serverSideObservation: productionCv.length > 0,
        syntheticEvaluation: productionCv.length ? 'passed' : 'not_run',
        realWorldValidation: 'not_completed',
        combineVerifiedProtocols: combineVerifiedProtocols(),
        combineVerificationAvailable: combineVerifiedProtocols().length > 0,
        // Deliberately no machine code here. `realWorldValidation` above
        // already carries the reason, and the canonical code
        // (REAL_WORLD_VALIDATION_NOT_COMPLETED) is 35 characters of
        // underscore-separated capitals — which is exactly the shape the
        // secret-scan heuristic looks for on this unauthenticated
        // endpoint. Repeating it here bought nothing and tripped a real
        // guard, so the guard wins.
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
        // "not_configured" would undersell what exists and "configured" would
        // oversell it. Mail is written to a local outbox that the delivery
        // centre can read; nothing leaves the machine.
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
      // Staff single sign-on: the only issuer that exists is the local test
      // identity provider, which is reachable in development only. No
      // corporate provider can be configured yet, so production reports
      // not_configured and the SSO routes refuse there.
      staff_sso: {
        state: devLogins ? 'test_only' : 'not_configured',
        note: devLogins
          ? 'Only the local test identity provider is available; it exercises the relying-party logic and never links an account that was not invited.'
          : 'No staff identity provider is configured; staff sign in with organisation credentials. The local test provider is disabled outside development.',
      },
      // How the server learns a client's address. Per-IP limits (login
      // attempts, sharing links) key on it, so a deployment behind a proxy
      // that leaves this unset has effectively one shared client.
      proxy_trust: { state: proxy.state, note: proxy.note },
      // Counts and states of the data layer are on /capabilities → dataLayer,
      // never subjects.
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

/**
 * Variables that name a real provider. No such
 * integration exists (adapters.mjs), so setting one is refused in production
 * rather than letting a deployment believe it verifies identity, bills or
 * stores media off the instance.
 */
export const UNIMPLEMENTED_PROVIDER_VARIABLES = Object.freeze({
  ONFIDO_API_TOKEN: 'identity verification (guardian ID checks still auto-approve)',
  STRIPE_SECRET_KEY: 'billing (success fees are recorded in the local ledger only)',
  S3_BUCKET: 'object storage (media is stored on this instance\'s disk)',
});

/**
 * Refuse to boot on configuration that would be actively unsafe in production,
 * while leaving development alone. Returns the list of problems; the caller
 * decides whether to throw (it does, in production mode).
 */
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
  // Signed media URLs are the capability to fetch a player's footage; their
  // HMAC key must be the deployment's own, stable across restarts and
  // instances, and long enough not to be guessed.
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
  // Passwordless logins have no production override. An environment that sets
  // the variable expects behaviour that does not exist, so it is refused
  // rather than silently ignored.
  if (production && flagged(env.ALLOW_DEV_LOGINS)) {
    problems.push({
      code: 'DEV_LOGIN_IN_PRODUCTION',
      message: 'ALLOW_DEV_LOGINS is set. Passwordless demo logins are never available in production; give demo accounts real passwords instead.',
      fatal: true,
    });
  }
  // Fault injection is a development instrument. Its middleware is
  // already inert in production; asking for it there is still a mistake
  // worth refusing to boot over, because it means someone copied a dev env.
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
  // The Trust & Safety API is guarded by one shared key. Production must name
  // its own key, and it must not be the publicly known development value
  // `scoutbox-admin` or trivially short.
  if (production && (!env.ADMIN_KEY || env.ADMIN_KEY === 'scoutbox-admin' || String(env.ADMIN_KEY).length < 16)) {
    problems.push({
      code: 'ADMIN_KEY_UNSAFE',
      message: 'ADMIN_KEY is unset, is the development default or is shorter than 16 characters; the Trust & Safety API would accept a publicly known key.',
      fatal: true,
    });
  }
  // The synthetic agent-verification provider verifies any
  // `TEST-VERIFIED-*` reference. Like the Box Cam simulator above, it must
  // never be reachable in production — an agent could self-verify a licence.
  if (production && env.AGENT_VERIFICATION_TEST_PROVIDER === '1') {
    problems.push({
      code: 'AGENT_TEST_PROVIDER_IN_PRODUCTION',
      message: 'AGENT_VERIFICATION_TEST_PROVIDER=1 enables the synthetic licence register, which verifies any TEST-VERIFIED reference.',
      fatal: true,
    });
  }
  // The local test identity provider is a development instrument, like the
  // fault layer above. Its routes already refuse outside development; a
  // signing secret for it on a production instance means a development
  // environment file was copied, and that is refused rather than ignored.
  if (production && flagged(env.TEST_IDP_SECRET)) {
    problems.push({
      code: 'TEST_IDP_IN_PRODUCTION',
      message: 'TEST_IDP_SECRET is set. The local test identity provider must never be configured on a production instance.',
      fatal: true,
    });
  }
  // A proxy-trust value that does not parse silently leaves every per-IP
  // limit keyed on the proxy's own address. Production refuses to guess.
  if (production && parseTrustProxy(env.SCOUTBOX_TRUST_PROXY).state === 'invalid') {
    problems.push({
      code: 'TRUST_PROXY_INVALID',
      message: `SCOUTBOX_TRUST_PROXY=${JSON.stringify(String(env.SCOUTBOX_TRUST_PROXY))} is not a hop count, true/false, or a list of addresses and subnets.`,
      fatal: true,
    });
  }
  return problems;
}
