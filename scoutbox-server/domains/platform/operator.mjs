// The operator surface: health, the public catalogue meta, and what this deployment can and cannot actually do.
// ScoutBox is careful to be honest about missing capability inside the product; /capabilities is the same honesty
// pointed at whoever runs it. States and counts only: no keys, hosts, connection strings or subjects.
import { PLANS } from '../../catalogue.mjs';
import { buildCapabilityReport, productionConfigProblems } from './capabilities.mjs';
import { integritySummary } from './integrity.mjs';
import { EVENT_NAMES } from './eventRegistry.mjs';

const POSITIONS = ['GK', 'CB', 'RB', 'LB', 'RWB', 'LWB', 'CDM', 'CM', 'CAM', 'RW', 'LW', 'ST', 'CF'];

export function registerMeta({ app, engine, players, orgs, devLogins }) {
  app.get('/health', (_req, res) => res.json({
    ok: true,
    service: 'scoutbox-server',
    engine,
    devLogins,
    uptimeSec: Math.round(process.uptime()),
    players: players.count(),
    orgs: orgs.count(),
  }));

  app.get('/meta', (_req, res) => {
    res.json({
      adultAges: { note: 'age of majority per country; DEFAULT applies otherwise' },
      plans: PLANS,
      positions: POSITIONS,
    });
  });
}

export function registerCapabilities({ app, rateLimit, providerStatus, trustProxy, dataLayer, integrity, eventPayloadDrops, notifier, notificationPrefs, faultLayer }) {
  if (typeof providerStatus !== 'function' || typeof notifier?.suppressedCount !== 'function') throw new TypeError('registerCapabilities needs the Box Cam provider status and the notifier');
  app.get('/capabilities', (_req, res) => {
    res.json(buildCapabilityReport({
      rateLimit,
      providers: providerStatus(),
      trustProxy,
      extra: {
        schema: dataLayer.schemaReport(),
        dataLayer: { ...dataLayer.report(), note: 'Each domain\'s tables and row counts. Counts are counts, never subjects.' },
        integrity: { ...integritySummary(integrity), note: 'Checked once at boot; violations are reported, never repaired.' },
        events: {
          registered: EVENT_NAMES.length,
          payloadDrops: eventPayloadDrops.count,
          note: 'Every emitted event is registered with an audience and a payload allowlist; an unregistered name fails closed.',
        },
        notifications: {
          preferencesEnforced: true,
          suppressedByPreference: notifier.suppressedCount(),
          unknownTypes: Object.keys(notificationPrefs.unknownTypes()),
          note: 'Preferences are applied before a notification is created. security_account cannot be turned off.',
        },
        faultInjection: {
          state: faultLayer.enabled ? 'available' : 'not_configured',
          note: faultLayer.enabled ? 'Development only: SCOUTBOX_FAULTS and POST /__faults simulate slow and failing sources.' : 'Disabled in production.',
        },
      },
    }));
  });
}

/** Refuse configuration that would be unsafe in production; development only logs it. */
export function assertProductionConfig({ trustWeightsTotal }) {
  const problems = productionConfigProblems({ trustWeightsTotal: trustWeightsTotal ?? null });
  for (const p of problems) console.error(`CONFIG ${p.code}: ${p.message}`);
  if (problems.some((p) => p.fatal) && process.env.NODE_ENV === 'production') {
    throw new Error(`Refusing to start: ${problems.filter((p) => p.fatal).map((p) => p.code).join(', ')}`);
  }
}
