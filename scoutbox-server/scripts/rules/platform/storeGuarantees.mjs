// The rules behind the store guarantees battery (e2e/platform/storeGuarantees.mjs) that are checked in this process:
// the catalogue constants, and every lifecycle state projecting through the journey as itself.
import { PLANS, ARCHETYPES } from '../../../catalogue.mjs';
import { ORG_PLANS } from '../../../repositories/orgs.ts';
import {
  ROOM_STATUSES,
  ROOM_STATUS_LABELS,
  TERMINAL_ROOM_STATUSES,
  stageForRoomStatus,
} from '../../../domains/recruitment/rooms/shared.mjs';
import { NULL_EVIDENCE_PROVIDER } from '../../../domains/recruitment/lifecycle/lifecycle.mjs';
import { buildRecruitmentJourney } from '../../recruitmentReadsFixture.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('platform/storeGuarantees');

section('§3 — the plans and archetypes are constants and cannot be emptied');
{
  ok(
    Object.keys(PLANS).length === 4 && ORG_PLANS.every((p) => PLANS[p]),
    'all 4 plans are present, and every plan an organisation can be on has its catalogue entry',
  );
  ok(ARCHETYPES.length === 5, 'the archetypes are the 5 catalogue entries');
}

section('§4 — every lifecycle state projects as itself');
{
  // A state that cannot be read back is a state a club can be trapped in. Driven off ROOM_STATUSES, so a new state is
  // covered the day it is added.
  const db = {
    recruitmentCases: ROOM_STATUSES.map((st, i) => ({
      id: `case-${st}`,
      orgId: 'org-legacy',
      playerId: 'pl-legacy',
      stage: stageForRoomStatus(st, 'academy'),
      createdAt: 1000 + i,
      room: { status: st, rev: 1, priority: 'normal' },
      history: [{ action: 'room_created', at: 1000 + i, detail: { status: st } }],
    })),
    roomDecisions: [],
    requests: [],
    trials: [],
    assessments: [],
    signings: [],
    recruitmentContacts: [],
  };
  const VIEWER = { kind: 'org_staff', orgId: 'org-legacy', role: 'recruitment_admin' };
  const OPTS = { now: 2000, evidence: NULL_EVIDENCE_PROVIDER };
  let projected = 0;
  const problems = [];
  for (const st of ROOM_STATUSES) {
    let out;
    try {
      out = buildRecruitmentJourney(db, `case-${st}`, VIEWER, OPTS);
    } catch (e) {
      problems.push(`${st}: threw ${e.message}`);
      continue;
    }
    if (!out.ok) {
      problems.push(`${st}: refused ${out.error}`);
      continue;
    }
    if (out.lifecycle.currentStage !== st) {
      problems.push(`${st}: read back as ${out.lifecycle.currentStage}`);
      continue;
    }
    if (out.lifecycle.label !== ROOM_STATUS_LABELS[st]) {
      problems.push(`${st}: label drifted`);
      continue;
    }
    if (out.lifecycle.terminal !== TERMINAL_ROOM_STATUSES.includes(st)) {
      problems.push(`${st}: terminality drifted`);
      continue;
    }
    projected += 1;
  }
  for (const p of problems) console.error(`   ${p}`);
  ok(
    projected === ROOM_STATUSES.length,
    `all ${ROOM_STATUSES.length} lifecycle states project with their own status, label and terminality`,
  );
  neg(problems.length === 0, 'and none of them is silently rewritten to a neighbouring state');

  // A signed case with two real history entries: projected as signed, nothing invented.
  const signed = {
    recruitmentCases: [
      {
        id: 'old-signed',
        orgId: 'org-legacy',
        playerId: 'pl-legacy',
        stage: 'review',
        createdAt: 1000,
        room: { status: 'signed', rev: 2 },
        history: [
          { action: 'room_created', at: 1000, detail: { status: 'watching' } },
          { action: 'room_status_changed', at: 1100, detail: { from: 'watching', to: 'signed' } },
        ],
      },
    ],
    roomDecisions: [],
    requests: [],
    trials: [],
    assessments: [],
    signings: [],
    recruitmentContacts: [],
  };
  const out = buildRecruitmentJourney(
    signed,
    'old-signed',
    { kind: 'org_staff', orgId: 'org-legacy', role: 'room_lead' },
    { now: 3000, evidence: NULL_EVIDENCE_PROVIDER },
  );
  ok(
    out.ok === true && out.lifecycle?.currentStage === 'signed',
    'a signed case projects through the journey as signed',
  );
  neg(out.outcome?.signing === null, 'with no signing invented to justify the status it was already in');
  ok(out.history?.entries.length === 2, 'and its two real history entries, neither more nor fewer');
}

done();
