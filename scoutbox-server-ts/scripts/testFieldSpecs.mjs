// Field specs (repositories/fieldSpecs.ts): a record of the type a spec declares (fieldSpecsSample.ts, checked by
// npm run typecheck) is typed unchanged, stored in the table the spec's DDL creates and decoded back equal; defaults,
// absent groups and junk are handled as the spec says. Run with: npm test
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tableDdl, typeSpec, encode, decode, insertSql } from '../repositories/fieldSpecs.ts';
import { SAMPLE_SPEC, FULL, UNSET } from './fieldSpecsSample.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

test('a record of the declared type is typed unchanged, stored and decoded back equal', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(tableDdl('samples', SAMPLE_SPEC));
  for (const sample of [FULL, UNSET]) {
    const t = typeSpec(SAMPLE_SPEC, sample, 'samples');
    assert.ok(t.ok, t.reason);
    assert.deepEqual(t.record, sample);
    db.prepare(insertSql('samples', SAMPLE_SPEC)).run(encode(SAMPLE_SPEC, t.record));
    const row = db.prepare('SELECT * FROM samples WHERE id = ?').get(sample.id);
    assert.deepEqual(decode(SAMPLE_SPEC, row), sample);
  }
  db.close();
});

test('absent fields take their default, null or nothing, as the declared type says', () => {
  const t = typeSpec(SAMPLE_SPEC, { id: 'r-3', active: true, status: 'open', by: { id: 'u-3' } }, 'samples');
  assert.ok(t.ok, t.reason);
  assert.deepEqual(t.record, {
    id: 'r-3',
    count: 0,
    score: null,
    active: true,
    status: 'open',
    born: null,
    by: { id: 'u-3', name: null },
    review: null,
    filters: {},
  });
});

test('junk is refused naming the record and the field, never the value', () => {
  for (const [over, pattern] of [
    [{ status: 'pending' }, /^samples\.status must be one of open\|closed \(got a string\)$/],
    [{ active: null }, /^samples\.active is required \(got null\)$/],
    [{ born: '2009-02-30' }, /^samples\.born must be a date/],
    [{ review: { note: 'x' } }, /^samples\.review\.at is required/],
    [{ filters: { days: 1.5 } }, /^samples\.filters\.days must be an integer \(got a number\)$/],
    [{ colour: 'red' }, /^samples carries field\(s\) this build does not store: colour$/],
  ]) {
    const t = typeSpec(SAMPLE_SPEC, { ...FULL, ...over }, 'samples');
    assert.equal(t.ok, false, String(pattern));
    assert.match(t.reason, pattern);
  }
});

console.log(`\n${passed} field spec checks passed`);
