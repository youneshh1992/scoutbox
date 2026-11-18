// The transaction rules behind the agent transactions persistence battery (e2e/agents/transactionsPersistence.mjs),
// checked in this process: the staleness verdict and the status machine the routes use, over the records the battery
// plants on disk.
import {
  partyRevisionOf,
  snapshotStaleness,
  actorTransitionAllowed,
  TRANSACTION_STATUSES,
} from '../../../domains/agents/transactions/transaction.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('agents/transactionsPersistence');

section('pure — the staleness verdict and the machine are the same functions the routes use');
{
  const rev = partyRevisionOf({
    parties: [],
    agentUserId: 'a',
    representations: [],
    consents: [],
    facetStates: {},
    policyVersions: [],
    blockedSubjectIds: [],
    minorSubjectIds: [],
  });
  neg(
    snapshotStaleness({ compliance: { evaluationId: 'e', partyRevision: 'different' } }, rev) === 'INPUTS_CHANGED',
    'a snapshot taken under different inputs is INPUTS_CHANGED',
  );
  neg(
    snapshotStaleness({}, rev) === 'NO_SNAPSHOT',
    'no snapshot at all is NO_SNAPSHOT — the absence of an evaluation is never a clearance',
  );
  neg(
    !actorTransitionAllowed('HALF_WRITTEN', 'ACTIVE') && !actorTransitionAllowed('ARCHIVED', 'ACTIVE'),
    'an unknown status and an archived one authorise no transition',
  );
  ok(TRANSACTION_STATUSES.length === 10, 'the ten states the routes and this suite share');
}

done();
