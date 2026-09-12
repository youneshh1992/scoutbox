/**
 * M18.1 — operator-facing capability reporting and boot assertions.
 *
 * ScoutBox is deliberately honest inside the product about what it cannot do:
 * "Measurement not yet supported on this device", "No production computer-vision
 * provider is configured", "Combine Confidence is 0 in a production profile".
 * None of that was visible to whoever DEPLOYS it. An operator could not answer
 * "is a real identity provider configured here?" without reading the source.
 *
 * `/capabilities` answers it. It reports state, never secrets: no keys, no
 * hostnames, no connection strings — only whether a capability is configured,
 * and one sentence on what its absence means.
 */

export const CAPABILITY_STATES = ['configured', 'not_configured', 'test_only'];

export function buildCapabilityReport({ env = process.env, rateLimit = null, providers = [] } = {}) {
  const flag = (v) => !!v && String(v).trim() !== '';

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
          ? 'A production observation provider is available.'
          : `No production computer-vision provider is configured.${limitedOnly ? ' Web capture observes player presence and active duration only — it cannot count repetitions or classify technique.' : ''} Combine metrics that need a real detector are reported as unsupported, never estimated.`,
      },
      distributed_rate_limit: rateLimit
        ? { state: rateLimit.capability().state, note: rateLimit.capability().note }
        : { state: 'not_configured', note: 'No rate limiter is installed.' },
      authoritative_identity_provider: {
        state: flag(env.SCOUTBOX_IDV_PROVIDER) && env.SCOUTBOX_IDV_PROVIDER !== 'local_test' ? 'configured' : 'not_configured',
        note: 'Without one, the strongest identity a player can hold is a ScoutBox document review, which is scored below authoritative.',
      },
      email_transport: {
        state: flag(env.SCOUTBOX_SMTP_URL) || flag(env.SMTP_URL) ? 'configured' : 'not_configured',
        note: 'Without a transport, invitations and notifications are recorded in the delivery centre but not sent.',
      },
      object_storage: {
        state: flag(env.SCOUTBOX_STORAGE_BUCKET) ? 'configured' : 'not_configured',
        note: 'Without it, media is stored on the local disk of this instance.',
      },
      media_signing_secret: {
        state: flag(env.SCOUTBOX_MEDIA_SECRET) ? 'configured' : 'not_configured',
        note: 'A per-deployment secret. Without one a development secret is used, which is not safe for production.',
      },
      box_cam_test_provider: {
        state: env.BOX_CAM_TEST_PROVIDER === '1' ? 'test_only' : 'not_configured',
        note: 'The clearly-labelled simulated observer. Its results never count as production evidence.',
      },
    },
    note: 'Capability states only. This report contains no keys, hostnames or connection details.',
  };
}

/**
 * Refuse to boot on configuration that would be actively unsafe in production,
 * while leaving development exactly as it was. Returns the list of problems;
 * the caller decides whether to throw (it does, in production mode).
 */
export function productionConfigProblems({ env = process.env, trustWeightsTotal = null } = {}) {
  const problems = [];
  const production = env.NODE_ENV === 'production';

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
  if (production && !env.SCOUTBOX_MEDIA_SECRET) {
    problems.push({
      code: 'MEDIA_SECRET_MISSING',
      message: 'SCOUTBOX_MEDIA_SECRET is unset, so signed media URLs would be signed with the development secret.',
      fatal: true,
    });
  }
  if (production && env.SCOUTBOX_ALLOW_DEV_LOGIN === '1') {
    problems.push({
      code: 'DEV_LOGIN_IN_PRODUCTION',
      message: 'SCOUTBOX_ALLOW_DEV_LOGIN=1 bypasses real credentials.',
      fatal: true,
    });
  }
  return problems;
}
