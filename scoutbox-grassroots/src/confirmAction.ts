// M18.2 — destructive actions say what they actually do.
//
// Every action that removes, archives, invalidates or tombstones something
// goes through here with a CLASS, and the class decides both whether a
// confirmation is shown and what it says:
//
//   reversible    no confirmation — undoing it is one click away
//   archive       confirm; the record leaves active views, history preserved
//   tombstone     confirm; the content is removed, the fact that it existed
//                 and who wrote it stays on the record
//   irreversible  confirm; there is no way back, and the copy says so
//
// The copy is explicit about consequence ("Decision history will be
// preserved") and never "Are you sure?". The browser's own confirm is used
// because it is modal, keyboard-operable and announced; a custom dialog that
// a toast could cover would be worse, not better.
import { t } from './i18n';

export type DestructiveClass = 'reversible' | 'archive' | 'tombstone' | 'irreversible';

export interface DestructiveAction {
  /** The i18n key of the title, e.g. 'confirm.archiveRoom'. */
  titleKey: string;
  /** The i18n key of the consequence sentence. */
  bodyKey: string;
  cls: DestructiveClass;
  /** Substituted into {name} in both strings. */
  name?: string | null;
}

/** True when the person confirmed, or when the class needs no confirmation. */
export function confirmDestructive(action: DestructiveAction): boolean {
  if (action.cls === 'reversible') return true;
  const name = action.name ?? '';
  const title = t(action.titleKey).replace('{name}', name);
  const body = t(action.bodyKey).replace('{name}', name);
  const tail = t(`confirm.tail.${action.cls}`);
  return window.confirm(`${title}\n\n${body}\n${tail}`);
}

/** The catalogue of destructive actions in the web apps, so the tests can
 *  assert every one is classified and none is missing a consequence line. */
export const DESTRUCTIVE_ACTIONS: Record<string, DestructiveAction> = {
  archiveRoom: { titleKey: 'confirm.archiveRoom', bodyKey: 'confirm.archiveRoomBody', cls: 'archive' },
  closeRoom: { titleKey: 'confirm.closeRoom', bodyKey: 'confirm.closeRoomBody', cls: 'archive' },
  deleteComment: { titleKey: 'confirm.deleteComment', bodyKey: 'confirm.deleteCommentBody', cls: 'tombstone' },
  cancelTrial: { titleKey: 'confirm.cancelTrial', bodyKey: 'confirm.cancelTrialBody', cls: 'archive' },
  // M23 P5 — a formal decision is not destructive, but it is the club's recruitment act and is confirmed like one: the copy says what it records and what it does not (no offer, nothing sent).
  finalizeDecision: { titleKey: 'confirm.finalizeDecision', bodyKey: 'confirm.finalizeDecisionBody', cls: 'irreversible' },
  discardDecisionDraft: { titleKey: 'confirm.discardDecisionDraft', bodyKey: 'confirm.discardDecisionDraftBody', cls: 'tombstone' },
  // M23 P6 — issuing an Offer is the club's outward act: an exact revision reaches a person and cannot be edited afterwards; withdrawing closes it.
  issueOffer: { titleKey: 'confirm.issueOffer', bodyKey: 'confirm.issueOfferBody', cls: 'irreversible' },
  withdrawOffer: { titleKey: 'confirm.withdrawOffer', bodyKey: 'confirm.withdrawOfferBody', cls: 'archive' },
  archiveBrief: { titleKey: 'confirm.archiveBrief', bodyKey: 'confirm.archiveBriefBody', cls: 'archive' },
  pauseBrief: { titleKey: 'confirm.pauseBrief', bodyKey: 'confirm.pauseBriefBody', cls: 'reversible' },
  deleteSavedSearch: { titleKey: 'confirm.deleteSavedSearch', bodyKey: 'confirm.deleteSavedSearchBody', cls: 'irreversible' },
  cancelCombineRequest: { titleKey: 'confirm.cancelCombine', bodyKey: 'confirm.cancelCombineBody', cls: 'irreversible' },
  removeStaff: { titleKey: 'confirm.removeStaff', bodyKey: 'confirm.removeStaffBody', cls: 'irreversible' },
  recordSigning: { titleKey: 'confirm.recordSigning', bodyKey: 'confirm.recordSigningBody', cls: 'irreversible' },
  dismissSecondLook: { titleKey: 'confirm.dismissSecondLook', bodyKey: 'confirm.dismissSecondLookBody', cls: 'reversible' },
  // M19 — archiving a Dynamic Watchlist stops membership being maintained and
  // is not reopened; pausing only stops the change notifications.
  archiveWatchlist: { titleKey: 'confirm.archiveWatchlist', bodyKey: 'confirm.archiveWatchlistBody', cls: 'archive' },
  pauseWatchlist: { titleKey: 'confirm.pauseWatchlist', bodyKey: 'confirm.pauseWatchlistBody', cls: 'reversible' },
};
