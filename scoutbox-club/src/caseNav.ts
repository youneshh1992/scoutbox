// M24B — the Recruitment Room's category → subcategory arrangement (Pro).
//
// Every subcategory is a function the Room already had, or a read-only view
// over records the Room already reads. A category is UI organisation only —
// it is not a lifecycle state and nothing persists it. The `legacy` ids are
// the flat tab names the server still emits (notification targets, the
// journey's next-action tab) and the old `#/recruitment/rooms/:id/<tab>`
// links, every one of which resolves to its subcategory.
import { validateCaseNav, type CaseNavModel } from '../../design-system/caseNav';

export const ROOM_NAV: CaseNavModel = {
  id: 'room',
  categories: [
    {
      id: 'overview', labelKey: 'rm.cat.overview',
      subs: [
        { id: 'summary', labelKey: 'rm.tab.summary', legacy: ['overview'] },
        { id: 'journey', labelKey: 'rm.tab.journey' },
        { id: 'tasks', labelKey: 'rm.tab.tasks' },
        { id: 'activity', labelKey: 'rm.tab.activity' },
      ],
    },
    {
      // The player's own truth layer — the Passport, Combine results and the
      // development plan — as distinct from what this club thinks (Evaluation).
      id: 'player', labelKey: 'rm.cat.player',
      subs: [
        { id: 'passport', labelKey: 'rm.tab.passport' },
        { id: 'combine', labelKey: 'rm.tab.combine' },
        { id: 'development', labelKey: 'rm.tab.development' },
      ],
    },
    {
      id: 'evaluation', labelKey: 'rm.cat.evaluation',
      subs: [
        { id: 'evidence', labelKey: 'rm.tab.evidence' },
        { id: 'assessments', labelKey: 'rm.tab.assessments' },
        { id: 'decision', labelKey: 'rm.tab.decision' },
        { id: 'secondlook', labelKey: 'rm.tab.secondlook' },
      ],
    },
    {
      id: 'engagement', labelKey: 'rm.cat.engagement',
      subs: [
        // Internal talk first, shared communication second (M23 P3): the
        // Discussion never travels; Contact and Trial reach the player.
        { id: 'discussion', labelKey: 'rm.tab.discussion' },
        { id: 'contact', labelKey: 'rm.tab.contact' },
        { id: 'trial', labelKey: 'rm.tab.trial' },
        { id: 'inbox', labelKey: 'rm.tab.inbox' },
      ],
    },
    {
      id: 'deal', labelKey: 'rm.cat.deal',
      subs: [
        { id: 'offer', labelKey: 'rm.tab.offer' },
        { id: 'signing', labelKey: 'rm.tab.signing' },
        { id: 'documents', labelKey: 'rm.tab.documents' },
      ],
    },
    {
      // Read-oriented: canonical history, never another writer.
      id: 'history', labelKey: 'rm.cat.history',
      subs: [
        { id: 'timeline', labelKey: 'rm.tab.timeline' },
        { id: 'past-decisions', labelKey: 'rm.tab.past-decisions' },
        { id: 'past-trials', labelKey: 'rm.tab.past-trials' },
        { id: 'past-offers', labelKey: 'rm.tab.past-offers' },
        { id: 'past-signings', labelKey: 'rm.tab.past-signings' },
      ],
    },
  ],
};

// Refuse to boot on a malformed model in development; the node suite asserts
// the same thing for every application.
if (import.meta.env?.DEV) {
  const problems = validateCaseNav(ROOM_NAV);
  if (problems.length) throw new Error(`ROOM_NAV: ${problems.join('; ')}`);
}
