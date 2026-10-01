// M24B — the Agent's case navigation: a CLIENT (one representation
// relationship) and a TRANSACTION workspace, each as category → subcategory.
//
// The agent's authorization is exactly as frozen in M23: every subcategory
// here reads an endpoint the agent already had, and every one of those
// endpoints refuses on its own terms (client disclosure, scope, licence) at
// read time. Nothing here exposes a club's assessment, decision rationale,
// Room discussion, another client, or same-agency data without authorisation
// — because nothing here reads anything new. A category is UI organisation
// only; it is never persisted.
import { validateCaseNav, type CaseNavModel } from '../../design-system/caseNav';

export const CLIENT_NAV: CaseNavModel = {
  id: 'client',
  categories: [
    {
      id: 'overview', labelKey: 'clients.cat.overview',
      subs: [
        { id: 'summary', labelKey: 'clients.tab.summary', legacy: ['overview'] },
        { id: 'journey', labelKey: 'clients.tab.journey' },
        { id: 'tasks', labelKey: 'clients.tab.tasks' },
        { id: 'activity', labelKey: 'clients.tab.activity' },
      ],
    },
    {
      id: 'player', labelKey: 'clients.cat.player',
      subs: [
        { id: 'profile', labelKey: 'clients.tab.profile' },
        { id: 'representation', labelKey: 'clients.tab.representation' },
        { id: 'compliance', labelKey: 'clients.tab.compliance' },
      ],
    },
    {
      id: 'recruitment', labelKey: 'clients.cat.recruitment',
      subs: [
        { id: 'contacts', labelKey: 'clients.tab.contacts' },
        { id: 'trials', labelKey: 'clients.tab.trials' },
        { id: 'opportunities', labelKey: 'clients.tab.opportunities' },
      ],
    },
    {
      id: 'transaction', labelKey: 'clients.cat.transaction',
      subs: [
        { id: 'offers', labelKey: 'clients.tab.offers' },
        { id: 'signings', labelKey: 'clients.tab.signings' },
        { id: 'documents', labelKey: 'clients.tab.documents' },
      ],
    },
    {
      id: 'history', labelKey: 'clients.cat.history',
      subs: [
        { id: 'timeline', labelKey: 'clients.tab.timeline' },
        { id: 'past-offers', labelKey: 'clients.tab.past-offers' },
        { id: 'past-signings', labelKey: 'clients.tab.past-signings' },
      ],
    },
  ],
};

export const TRANSACTION_NAV: CaseNavModel = {
  id: 'transaction',
  categories: [
    {
      id: 'workspace', labelKey: 'tx.cat.workspace',
      subs: [
        { id: 'overview', labelKey: 'txTab.overview' },
        { id: 'parties', labelKey: 'txTab.parties' },
        { id: 'compliance', labelKey: 'txTab.compliance' },
      ],
    },
    {
      id: 'records', labelKey: 'tx.cat.records',
      subs: [
        { id: 'documents', labelKey: 'txTab.documents' },
        { id: 'messages', labelKey: 'txTab.messages' },
        { id: 'timeline', labelKey: 'txTab.timeline' },
      ],
    },
  ],
};

if (import.meta.env?.DEV) {
  for (const m of [CLIENT_NAV, TRANSACTION_NAV]) {
    const problems = validateCaseNav(m);
    if (problems.length) throw new Error(`${m.id}: ${problems.join('; ')}`);
  }
}
