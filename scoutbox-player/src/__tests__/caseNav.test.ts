/// <reference types="jest" />
// The player's recruitment navigation model (M24B/M24D): the rules the
// portals' e2e/caseNav.test.mjs asserts, and the `?cat=&tab=` resolution the
// Opportunities screen relies on.
import { PLAYER_NAV, PLAYER_LEGACY_SUBS, playerDefaultLocation, playerLocation, playerCategoryFor } from '../caseNav';

describe('PLAYER_NAV shape', () => {
  test('five categories, none wider than three pages, none wider than the portal limit of five', () => {
    expect(PLAYER_NAV.categories).toHaveLength(5);
    for (const c of PLAYER_NAV.categories) {
      expect(c.subs.length).toBeGreaterThan(0);
      expect(c.subs.length).toBeLessThanOrEqual(3);
      expect(c.subs.length).toBeLessThanOrEqual(5);
    }
  });

  test('category ids are unique and subcategory ids are unique within and across categories', () => {
    const cats = PLAYER_NAV.categories.map((c) => c.id);
    expect(new Set(cats).size).toBe(cats.length);
    const subs = PLAYER_NAV.categories.flatMap((c) => c.subs.map((s) => s.id));
    expect(new Set(subs).size).toBe(subs.length);
  });

  test('every category and subcategory carries a label key', () => {
    for (const c of PLAYER_NAV.categories) {
      expect(c.labelKey).toMatch(/^cat/);
      for (const s of c.subs) expect(typeof s.labelKey).toBe('string');
    }
  });

  test('every legacy subcategory alias resolves to a subcategory that exists', () => {
    const subs = new Set(PLAYER_NAV.categories.flatMap((c) => c.subs.map((s) => s.id)));
    for (const target of Object.values(PLAYER_LEGACY_SUBS)) expect(subs.has(target)).toBe(true);
  });
});

describe('playerLocation', () => {
  test('nothing given → the first page of the first category', () => {
    expect(playerDefaultLocation()).toEqual({ category: 'journey', sub: 'overview' });
    expect(playerLocation(undefined, undefined)).toEqual({ category: 'journey', sub: 'overview' });
  });

  test('a known category and tab resolve exactly', () => {
    expect(playerLocation('offer', 'offer-documents')).toEqual({ category: 'offer', sub: 'offer-documents' });
  });

  test('a known category with an unknown tab falls back to that category\'s first page', () => {
    expect(playerLocation('trial', 'nonsense')).toEqual({ category: 'trial', sub: 'invitation' });
  });

  test('an unknown category with a known tab finds the tab\'s category', () => {
    expect(playerLocation('nonsense', 'signing-contract')).toEqual({ category: 'signing', sub: 'signing-contract' });
  });

  test('links written before M24D still land: stage and tasks fold into the overview, the board tabs into the board page', () => {
    expect(playerLocation('journey', 'stage')).toEqual({ category: 'journey', sub: 'overview' });
    expect(playerLocation('journey', 'tasks')).toEqual({ category: 'journey', sub: 'overview' });
    expect(playerLocation('journey', 'board-fit')).toEqual({ category: 'journey', sub: 'board' });
    // The former Board category is a page of the journey now.
    expect(playerLocation('board', undefined)).toEqual({ category: 'journey', sub: 'board' });
  });

  test('repeated query parameters use the first value', () => {
    expect(playerLocation(['contact', 'offer'], ['requests', 'messages'])).toEqual({ category: 'contact', sub: 'requests' });
  });

  test('unknown values never throw and land on the default', () => {
    expect(() => playerLocation('x', 'y')).not.toThrow();
    expect(playerLocation('x', 'y')).toEqual({ category: 'journey', sub: 'overview' });
    expect(playerLocation('', '')).toEqual({ category: 'journey', sub: 'overview' });
  });
});

describe('playerCategoryFor', () => {
  test('a notification about a trial, offer or signing opens that category; an inbox item opens Contact', () => {
    expect(playerCategoryFor('trial')).toBe('trial');
    expect(playerCategoryFor('offer')).toBe('offer');
    expect(playerCategoryFor('signing')).toBe('signing');
    expect(playerCategoryFor('inbox')).toBe('contact');
    for (const k of ['trial', 'offer', 'signing', 'inbox'] as const) {
      expect(PLAYER_NAV.categories.some((c) => c.id === playerCategoryFor(k))).toBe(true);
    }
  });
});
