// A spec with every kind of field, the record type fieldSpecs.ts derives from it (checked by npm run typecheck), and
// records of that type, which testFieldSpecs.mjs types, stores and reads back to show the type is what comes back.
import { text, int, num, bool, oneOf, date, group, type RecordOf } from '../repositories/fieldSpecs.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const req = { req: true } as const;

export const SAMPLE_SPEC = [
  text('id', 'id', 80, { req: true, nonEmpty: true }),
  int('count', 'count', { req: true, def: 0 }),
  num('score', 'score'),
  bool('active', 'active', req),
  oneOf('status', 'status', ['open', 'closed'], req),
  date('born', 'born'),
  group('by', [text('id', 'by_id', 80, req), text('name', 'by_name', 120)]),
  group('review', [int('at', 'review_at', req), text('note', 'review_note', 200)], { nullable: true }),
  group(
    'filters',
    [
      oneOf('foot', 'foot', ['left', 'right']),
      int('days', 'days'),
      group('registry', [text('provider', 'registry_provider', 40, req), int('checkedAt', 'registry_checked_at')], {
        nullable: true,
        sparse: true,
      }),
    ],
    { sparse: true },
  ),
];

export type Sample = RecordOf<typeof SAMPLE_SPEC>;
type Expected = {
  id: string;
  count: number;
  score: number | null;
  active: boolean;
  status: 'open' | 'closed';
  born: string | null;
  by: { id: string; name: string | null };
  review: { at: number; note: string | null } | null;
  filters: { foot?: 'left' | 'right'; days?: number; registry?: { provider?: string; checkedAt?: number } };
};
export const SAMPLE_TYPE_IS_EXPECTED: Equal<Sample, Expected> = true;

export const FULL: Sample = {
  id: 'r-1',
  count: 3,
  score: 7.5,
  active: true,
  status: 'open',
  born: '2009-02-28',
  by: { id: 'u-1', name: 'Sam' },
  review: { at: 1_700_000_000_000, note: 'seen twice' },
  filters: { foot: 'left', days: 7, registry: { provider: 'fa', checkedAt: 1_700_000_000_000 } },
};
export const UNSET: Sample = {
  id: 'r-2',
  count: 0,
  score: null,
  active: false,
  status: 'closed',
  born: null,
  by: { id: 'u-2', name: null },
  review: null,
  filters: {},
};

// @ts-expect-error an enum holds only its values
export const WRONG_STATUS: Sample = { ...UNSET, status: 'pending' };
// @ts-expect-error a required field is never null
export const NULL_REQUIRED: Sample = { ...UNSET, active: null };
// @ts-expect-error a sparse group leaves an unset key out rather than holding null
export const NULL_IN_SPARSE: Sample = { ...UNSET, filters: { days: null } };
