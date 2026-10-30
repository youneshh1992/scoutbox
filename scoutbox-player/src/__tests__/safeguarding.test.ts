/// <reference types="jest" />
// The app's mirror of the server's age rule (scoutbox-server/domain.mjs). The
// server enforces it; the app explains it before a request is made, so the two
// must agree on the boundary day.
import { ADULT_AGE, adultAgeFor, ageOn, isAdult, SAFEGUARDING_PROMISES, U18_PROMISES } from '../domain/safeguarding';

const ON = new Date('2026-10-14T12:00:00Z');

describe('adultAgeFor', () => {
  test('18 by default, with the country exceptions', () => {
    expect(adultAgeFor('GB')).toBe(18);
    expect(adultAgeFor('ZZ')).toBe(ADULT_AGE.DEFAULT);
    expect(adultAgeFor('KR')).toBe(19);
    expect(adultAgeFor('TH')).toBe(20);
    expect(adultAgeFor('EG')).toBe(21);
    expect(adultAgeFor('SG')).toBe(21);
  });
});

describe('ageOn', () => {
  test('the birthday itself counts; the day before does not', () => {
    expect(ageOn('2008-10-14', ON)).toBe(18);
    expect(ageOn('2008-10-15', ON)).toBe(17);
    expect(ageOn('2008-10-13', ON)).toBe(18);
  });
  test('a birthday later in the year is not reached yet', () => { expect(ageOn('2008-12-01', ON)).toBe(17); });
  test('a birthday earlier in the year has passed', () => { expect(ageOn('2008-01-31', ON)).toBe(18); });
});

describe('isAdult', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(ON); });
  afterEach(() => { jest.useRealTimers(); });
  test('eighteen today is an adult in a default country but not where the age is nineteen', () => {
    expect(isAdult('2008-10-14', 'GB')).toBe(true);
    expect(isAdult('2008-10-14', 'KR')).toBe(false);
  });
  test('seventeen is a child everywhere', () => {
    expect(isAdult('2008-10-15', 'GB')).toBe(false);
    expect(isAdult('2009-01-01', 'NZ')).toBe(false);
  });
});

describe('the promises shown to players and parents', () => {
  test('are non-empty plain sentences and the under-18 rules name the guardian ownership and the no-direct-message rule', () => {
    expect(SAFEGUARDING_PROMISES.length).toBeGreaterThan(0);
    expect(U18_PROMISES.length).toBeGreaterThan(0);
    for (const p of [...SAFEGUARDING_PROMISES, ...U18_PROMISES]) expect(p.trim().length).toBeGreaterThan(20);
    expect(U18_PROMISES.some((p) => /Parents own every under-18 account/.test(p))).toBe(true);
    expect(U18_PROMISES.some((p) => /No child receives direct messages/.test(p))).toBe(true);
  });
});
