// Integrations: CSV imports, API keys and outbound webhooks.
import { needs } from '../platform/deps.mjs';
import { routeContext } from '../platform/routeHelpers.mjs';
import { registerImports } from './imports.mjs';

/** Returns `emitWebhook(orgId, event, payload)` and the `webhookSweep` that retries failed deliveries. */
export function createIntegrations(deps) {
  needs('createIntegrations', deps, [
    'app',
    'orgRouter',
    'adminRouter',
    'integrations',
    'players',
    'playerRecord',
    'safetyAudit',
    'byId',
    'findPlayer',
    'isBlocked',
    'unit',
    'nextId',
  ]);
  const { emitWebhook, webhookSweep } = registerImports(routeContext('createIntegrations', deps));
  return { emitWebhook, webhookSweep };
}
