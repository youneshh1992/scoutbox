// Messaging: notifications and their delivery, message threads, and the delivery centre.
import { needs } from '../platform/deps.mjs';
import { routeContext } from '../platform/routeHelpers.mjs';
import { registerDelivery } from './delivery.mjs';

/**
 * The delivery centre: dispatches, their retries and the deadline reminders. Returns `notifyAction`, the reminder that
 * names a deadline. The webhooks it retries are the integrations domain's.
 */
export function createDelivery(deps) {
  needs('createDelivery', deps, [
    'app',
    'orgRouter',
    'playerRouter',
    'guardianRouter',
    'adminRouter',
    'notifications',
    'dispatches',
    'outbox',
    'operations',
    'safetyAudit',
    'users',
    'byId',
    'findPlayer',
    'isBlocked',
    'unit',
    'nextId',
    'notify',
    'emitWebhook',
    'webhookSweep',
  ]);
  const { notifyAction } = registerDelivery(routeContext('createDelivery', deps));
  return { notifyAction };
}
