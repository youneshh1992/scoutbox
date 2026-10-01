// M24B — the Recruitment Room's category → subcategory arrangement (Grassroots).
//
// Simpler than Pro: five categories, the player's record and the club's
// review in one "Player review" area, and a shorter history. Every
// subcategory is a function the Room already had, or a read-only view over
// records it already reads; a category is UI organisation only and nothing
// persists it. The `legacy` ids are the flat tab names the server still
// emits and the old links still carry; each resolves to its subcategory.
// The minor safeguards, the 50 km rule and the verified-club rules are
// server rules and are untouched by where a page sits.
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
      id: 'player-review', labelKey: 'rm.cat.playerReview',
      subs: [
        { id: 'passport', labelKey: 'rm.tab.passport' },
        { id: 'evidence', labelKey: 'rm.tab.evidence' },
        { id: 'assessments', labelKey: 'rm.tab.assessments' },
        { id: 'combine', labelKey: 'rm.tab.combine' },
        { id: 'development', labelKey: 'rm.tab.development' },
      ],
    },
    {
      id: 'recruitment', labelKey: 'rm.cat.recruitment',
      subs: [
        // Internal talk first, shared communication second (M23 P3): the
        // Discussion never travels; Contact and Trial reach the player.
        { id: 'discussion', labelKey: 'rm.tab.discussion' },
        { id: 'contact', labelKey: 'rm.tab.contact' },
        { id: 'trial', labelKey: 'rm.tab.trial' },
        { id: 'inbox', labelKey: 'rm.tab.inbox' },
        { id: 'decision', labelKey: 'rm.tab.decision' },
      ],
    },
    {
      id: 'agreement', labelKey: 'rm.cat.agreement',
      subs: [
        { id: 'offer', labelKey: 'rm.tab.offer' },
        { id: 'signing', labelKey: 'rm.tab.signing' },
        { id: 'documents', labelKey: 'rm.tab.documents' },
      ],
    },
    {
      id: 'history', labelKey: 'rm.cat.history',
      subs: [
        { id: 'timeline', labelKey: 'rm.tab.timeline' },
        { id: 'past-trials', labelKey: 'rm.tab.past-trials' },
        { id: 'past-offers', labelKey: 'rm.tab.past-offers' },
      ],
    },
  ],
};

if (import.meta.env?.DEV) {
  const problems = validateCaseNav(ROOM_NAV);
  if (problems.length) throw new Error(`ROOM_NAV: ${problems.join('; ')}`);
}
