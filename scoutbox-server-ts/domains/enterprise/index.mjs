// Enterprise: onboarding, staff MFA set-up, SSO, the organisation's export and audit, health and backups.
import { needs } from '../platform/deps.mjs';
import { routeContext } from '../platform/routeHelpers.mjs';
import { registerEnterprise } from './enterprise.mjs';

export function createEnterprise(deps) {
  needs('createEnterprise', deps, [
    'app',
    'orgRouter',
    'adminRouter',
    'enterprise',
    'enterpriseReads',
    'groupReads',
    'insightReads',
    'integrationReads',
    'recruitmentReads',
    'users',
    'staffRecord',
    'orgs',
    'orgRecord',
    'players',
    'sessions',
    'sessionEnds',
    'codes',
    'channels',
    'notifications',
    'dispatches',
    'outbox',
    'pushLog',
    'pushTokens',
    'mediaDeletions',
    'recruitment',
    'recruitmentCases',
    'safetyAudit',
    'byId',
    'isBlocked',
    'mfaGuards',
    'createSession',
    'orgSafe',
    'mailer',
    'storage',
    'unit',
    'nextId',
    'notify',
    'schemaVersion',
    'backupDatabase',
    'DATA_DIR',
  ]);
  registerEnterprise(routeContext('createEnterprise', deps));
}
