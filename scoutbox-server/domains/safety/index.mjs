// Safety: content moderation, reports and blocks, and the Trust & Safety console.
import { needs, strictContext } from '../platform/deps.mjs';
import { createModeration } from './moderation.mjs';
import { createAdminRouter, registerReporting, registerSafetyConsole } from './safety.mjs';

/**
 * Moderation, the admin router (ScoutBox staff only, behind the admin key) and the report and block routes. Returns
 * `moderateOrRefuse` and the `adminRouter`.
 */
export function createSafety(deps) {
  const d = strictContext(
    'createSafety',
    needs('createSafety', deps, [
      'app',
      'orgRouter',
      'playerRouter',
      'guardianRouter',
      'adminKey',
      'sessionFor',
      'compliancePolicies',
      'safetyAudit',
      'recruitmentActs',
      'byId',
      'unit',
      'nextId',
      'broadcast',
      'ledgerAppend',
    ]),
  );
  const { safetyAudit, unit, nextId } = d;
  const moderateOrRefuse = createModeration({ safetyAudit, unit, nextId });
  const adminRouter = createAdminRouter({
    app: d.app,
    adminKey: d.adminKey,
    sessionFor: d.sessionFor,
    compliancePolicies: d.compliancePolicies,
  });
  registerReporting({
    playerRouter: d.playerRouter,
    guardianRouter: d.guardianRouter,
    orgRouter: d.orgRouter,
    safetyAudit,
    recruitmentActs: d.recruitmentActs,
    byId: d.byId,
    unit,
    nextId,
    ledgerAppend: d.ledgerAppend,
    broadcast: d.broadcast,
  });
  return { moderateOrRefuse, adminRouter };
}

/** The Trust & Safety console. It reads most domains' records, so it is created after them. */
export function createSafetyConsole(deps) {
  registerSafetyConsole(
    strictContext(
      'createSafetyConsole',
      needs('createSafetyConsole', deps, [
        'adminRouter',
        'dataLayerReport',
        'storeEngine',
        'unit',
        'notify',
        'broadcast',
        'mailer',
        'players',
        'guardians',
        'orgs',
        'orgRecord',
        'sessions',
        'channels',
        'safetyAudit',
        'signingsFollowUps',
        'invoices',
        'outbox',
        'pushLog',
        'transitionsVouches',
        'coachReferences',
        'verificationReads',
        'byId',
        'orgSafe',
        'safeguardingCertified',
        'channelViewFor',
        'vouchView',
        'syncLegacyOrgVerification',
      ]),
    ),
  );
}
