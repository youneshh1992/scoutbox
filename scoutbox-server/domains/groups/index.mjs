// Federation groups: organisations that share chosen resources with each other through expiring, revocable grants.
import { needs } from '../platform/deps.mjs';
import { routeContext } from '../platform/routeHelpers.mjs';
import { registerGroups } from './groups.mjs';

export function createGroups(deps) {
  needs('createGroups', deps, [
    'orgRouter',
    'adminRouter',
    'groups',
    'groupReads',
    'recruitmentReads',
    'scoutingReads',
    'safetyReads',
    'byId',
    'users',
    'findPlayer',
    'isBlocked',
    'unit',
    'nextId',
    'notify',
  ]);
  registerGroups(routeContext('createGroups', deps));
}
