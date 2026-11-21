// The rules behind the platform API battery (e2e/platform/api.mjs) that are checked in this process: the similarity
// score behind a profile's similar players and "more like this".
import { similarityScore } from '../../../domain.ts';
import { ARCHETYPES } from '../../../catalogue.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('platform/api');

// Ages are taken today; these birth dates are far enough from any birthday to give whole-year differences.
const base = {
  position: 'ST',
  foot: 'right',
  dob: '2002-01-01',
  heightCm: 185,
  weightKg: 80,
  stats: { appearances: 30, goals: 18, assists: 5 },
};
const like = (over) => ({ ...base, ...over });

section('§1 — the similarity score: position, foot, age, output, build; at most 100');
{
  ok(similarityScore(base, base) === 100, 'a profile is 100 like itself');
  for (const a of ARCHETYPES) ok(similarityScore(a, a) === 100, `the ${a.label} archetype is 100 like itself`);
  ok(similarityScore(base, like({ position: 'CF' })) === 83, 'the same position group earns 18 of the 35');
  ok(similarityScore(base, like({ position: 'CB' })) === 65, 'another group earns none of them');
  ok(
    similarityScore(like({ position: null }), like({ position: null })) === 100,
    'two unknown positions count as the same position',
  );
  neg(similarityScore(like({ position: null }), base) === 65, 'and an unknown one is in no group');
  ok(similarityScore(base, like({ foot: 'left' })) === 90, 'the other foot loses 10');
  ok(similarityScore(base, like({ dob: '2000-01-01' })) === 94, 'each year apart costs 3 of the 15');
  ok(similarityScore(base, like({ dob: '1990-01-01' })) === 85, 'and the age part never goes below 0');
  ok(
    similarityScore(base, like({ stats: { appearances: 30, goals: 3, assists: 5 } })) === 88,
    'output per 90 minutes apart costs 25 for each goal or assist a game',
  );
  ok(
    similarityScore(like({ stats: null }), like({ stats: { appearances: 0, goals: 0, assists: 0 } })) === 100,
    'no stats and no appearances both read as no output',
  );
  ok(
    similarityScore(like({ heightCm: null, weightKg: null }), like({ heightCm: 180, weightKg: 75 })) === 100,
    'an unknown height and weight read as 180 cm and 75 kg',
  );
  ok(similarityScore(base, like({ heightCm: 191, weightKg: 86 })) === 95, 'build: half a point a cm, a third a kg');
  ok(similarityScore(base, like({ heightCm: 186 })) === 100, 'and the total is rounded, a half up (99.5 is 100)');
  ok(
    similarityScore(base, like({ heightCm: 189, weightKg: 81 })) === 98,
    'and to the nearest whole point (97.67 is 98)',
  );
  ok(
    similarityScore(
      base,
      like({ position: 'GK', foot: 'left', dob: '1980-01-01', heightCm: 150, stats: { appearances: 1, goals: 9 } }),
    ) === 0,
    'nothing alike is 0',
  );
  ok(similarityScore(base, ARCHETYPES[1]) === similarityScore(ARCHETYPES[1], base), 'the score is symmetric');
}

done();
