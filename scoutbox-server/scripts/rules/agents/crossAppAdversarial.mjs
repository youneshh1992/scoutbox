// The rules behind the agent cross-app adversarial battery (e2e/agents/crossAppAdversarial.mjs), checked in this
// process: an agreement row that names no individual, and the production event registry contract as boot runs it.
import { agreementInForce } from '../../../domains/agents/core/shared.mjs';
import { assertEventRegistry } from '../../../domains/platform/eventRegistry.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('agents/crossAppAdversarial');

section('RA — Trust: an agreement naming nobody');
ok(
  !agreementInForce({ id: 'x', agentUserId: null, status: 'active', confirmedAt: 1, startAt: 1, endAt: null }, 2),
  'RA9 and a NAMED individual: a row naming nobody counts for nothing',
);

section('RM — the event registry contract');
{
  const problems = assertEventRegistry({ mode: 'production' });
  neg(
    problems.length === 0,
    `RM10 and the production registry contract reports no problems at all (${problems.join(' | ') || 'none'})`,
  );
}

done();
