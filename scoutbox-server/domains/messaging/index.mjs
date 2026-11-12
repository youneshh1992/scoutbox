// Messaging: notifications and their delivery, message threads, and the delivery centre.
import { needs, strictContext } from '../platform/deps.mjs';
import { routeContext } from '../platform/routeHelpers.mjs';
import { registerMessaging } from './channels.mjs';
import { registerDelivery } from './delivery.mjs';
import { createNotifier, registerDeliverySettings, registerNotificationFeed } from './notify.mjs';

/**
 * The notifier, the message threads and the push and e-mail delivery settings. Returns the `notifier` (and its
 * `notify`) and `openChannel`, which the Inbox uses to open a thread from an accepted request.
 */
export function createMessaging(deps) {
  const d = strictContext(
    'createMessaging',
    needs('createMessaging', deps, [
      'app',
      'orgRouter',
      'playerRouter',
      'guardianRouter',
      'guardianManagedOnly',
      'sessionFor',
      'store',
      'notifications',
      'notificationPrefs',
      'pushSender',
      'publishEvent',
      'eventPayloadDrops',
      'channels',
      'recruitment',
      'players',
      'guardians',
      'pushTokens',
      'byId',
      'isBlocked',
      'moderateOrRefuse',
      'unit',
      'nextId',
      'broadcast',
      'ledgerAppend',
    ]),
  );
  const { orgRouter, playerRouter, guardianRouter, byId } = d;
  const notifier = createNotifier({
    notifications: d.notifications,
    prefs: d.notificationPrefs,
    store: d.store,
    pushSender: d.pushSender,
    byId,
    publishEvent: d.publishEvent,
    eventPayloadDrops: d.eventPayloadDrops,
  });
  const { notify } = notifier;
  const { openChannel } = registerMessaging({
    orgRouter,
    playerRouter,
    guardianRouter,
    channels: d.channels,
    recruitment: d.recruitment,
    byId,
    isBlocked: d.isBlocked,
    unit: d.unit,
    nextId: d.nextId,
    notify,
    broadcast: d.broadcast,
    ledgerAppend: d.ledgerAppend,
    moderateOrRefuse: d.moderateOrRefuse,
    guardianManagedOnly: d.guardianManagedOnly,
  });
  registerDeliverySettings({
    app: d.app,
    playerRouter,
    guardianRouter,
    players: d.players,
    guardians: d.guardians,
    pushTokens: d.pushTokens,
    sessionFor: d.sessionFor,
  });
  return { notifier, notify, openChannel };
}

/** The notification feed of each audience. `notificationTargetFor` (recruitment) says where a notification leads. */
export function createNotificationFeed(deps) {
  return registerNotificationFeed(
    strictContext(
      'createNotificationFeed',
      needs('createNotificationFeed', deps, [
        'orgRouter',
        'playerRouter',
        'guardianRouter',
        'notifications',
        'notifier',
        'notificationTargetFor',
      ]),
    ),
  );
}

/**
 * The delivery centre: dispatches, their retries and the deadline reminders. Returns `notifyAction`, the reminder that
 * names a deadline, and the minute `deliverySweep`, which retries dispatches and the integrations domain's webhooks.
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
  const { notifyAction, deliverySweep } = registerDelivery(routeContext('createDelivery', deps));
  return { notifyAction, deliverySweep };
}
