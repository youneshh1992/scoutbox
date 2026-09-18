// M18.2 pattern — destructive actions say what they actually do. Same
// classes and the same browser-native confirm as Pro/Grassroots; the
// catalogue is the Agent workspace's own three actions.
import { t } from './i18n';

export type DestructiveClass = 'reversible' | 'archive' | 'tombstone' | 'irreversible';

export interface DestructiveAction {
  titleKey: string;
  bodyKey: string;
  cls: DestructiveClass;
  name?: string | null;
}

export function confirmDestructive(action: DestructiveAction): boolean {
  if (action.cls === 'reversible') return true;
  const name = action.name ?? '';
  const title = t(action.titleKey).replace('{name}', name);
  const body = t(action.bodyKey).replace('{name}', name);
  const tail = t(`confirm.tail.${action.cls}`);
  return window.confirm(`${title}\n\n${body}\n${tail}`);
}

export const DESTRUCTIVE_ACTIONS: Record<string, DestructiveAction> = {
  // Ending a confirmed relationship: access ends now; the record stays; a new one needs a new confirmation.
  terminateRelationship: { titleKey: 'confirm.terminate', bodyKey: 'confirm.terminateBody', cls: 'irreversible' },
  // Withdrawing a pending request: the client is told; the 30-day cooldown applies.
  withdrawRequest: { titleKey: 'confirm.withdraw', bodyKey: 'confirm.withdrawBody', cls: 'irreversible' },
  // Ending a membership: sessions end now; profile and attributions stay.
  endMember: { titleKey: 'confirm.endMember', bodyKey: 'confirm.endMemberBody', cls: 'irreversible' },
};
