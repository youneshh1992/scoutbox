/**
 * Product catalogue — constants that are NOT user data.
 *
 * WHY THIS FILE EXISTS (M23-D2).
 *
 * `db.plans` and `db.archetypes` are product configuration: a billing plan
 * table and a fixed set of positional yardsticks. Both are read by production
 * routes, and both lived only inside `buildSeed()` — the demo-data builder.
 *
 * That is fine on a first boot, because the server starts from `buildSeed()`.
 * It is NOT fine on the restore path. `loadSnapshot()` does:
 *
 *     for (const key of Object.keys(db)) delete db[key];
 *     Object.assign(db, raw.db);
 *
 * — it DELETES the seeded object and replaces it with exactly what the
 * snapshot holds. A snapshot written before a collection existed therefore
 * removes it, and the next production read is a TypeError, not a 404.
 *
 * So these constants move here, where the seed and the migration can both
 * reach one definition. §23: one source of truth. The seed's behaviour is
 * unchanged — it imports the same values it used to declare inline.
 *
 * NOTE ON EMPTINESS. For a container of user data, empty is the correct
 * default: no rows means nothing happened. For these two, empty is a LIE with
 * consequences. An empty `plans` makes every `db.plans[org.plan]?.x ?? 18`
 * silently fall back, which would move a Grassroots organisation's attribution
 * window from 12 months to 18 — a billing change introduced by a persistence
 * bug. So the migration restores the catalogue rather than an empty object.
 */

/**
 * Billing plans, keyed by the value stored on `org.plan`.
 *
 * Read by the signing route and the plan view for the attribution window.
 * A missing key already falls back safely; a missing TABLE does not.
 */
export const PLANS = Object.freeze({
  Grassroots: {
    name: 'Grassroots',
    pricePerMonthGBP: 0,
    seats: 1,
    attributionWindowMonths: 12,
    antiCircumvention:
      'Signing a ScoutBox-discovered player inside the attribution window owes the signing fee and discovery sell-on regardless of how contact concluded. Radius and level walls are platform rules, not preferences.',
  },
  Academy: {
    name: 'Academy',
    pricePerMonthGBP: 99,
    seats: 3,
    attributionWindowMonths: 18,
    antiCircumvention:
      'Any signing of a ScoutBox-discovered player within the attribution window, however contact was concluded, owes the discovery fee. Off-platform approaches to circumvent the ledger are a terms breach and forfeit Trusted Partner eligibility.',
  },
  Pro: {
    name: 'Pro',
    pricePerMonthGBP: 349,
    seats: 15,
    attributionWindowMonths: 24,
    antiCircumvention:
      'Any signing of a ScoutBox-discovered player within the attribution window, however contact was concluded, owes the discovery fee. Off-platform approaches to circumvent the ledger are a terms breach and forfeit Trusted Partner eligibility.',
  },
  Agency: {
    name: 'Agency',
    pricePerMonthGBP: 499,
    seats: 10,
    attributionWindowMonths: 24,
    antiCircumvention:
      'Agencies additionally warrant that no representation approach is made to any player who has not accepted a contact request, and never to a minor under any circumstances.',
  },
});

/**
 * Positional archetypes — fixed yardsticks for the similarity lead shown
 * beside a player ("Statistical similarity — a lead, not a verdict.").
 *
 * These are not players and never become players. They carry no identity and
 * are never counted, ranked or shown as a score about a person.
 */
export const ARCHETYPES = Object.freeze([
  { id: 'arch-pressing-forward', label: 'Pressing forward', position: 'ST', foot: 'right', dob: '2002-01-01', heightCm: 185, weightKg: 80, stats: { appearances: 30, goals: 18, assists: 5 } },
  { id: 'arch-deep-playmaker', label: 'Deep-lying playmaker', position: 'CM', foot: 'left', dob: '2001-01-01', heightCm: 177, weightKg: 72, stats: { appearances: 30, goals: 3, assists: 10 } },
  { id: 'arch-ball-playing-cb', label: 'Ball-playing centre-back', position: 'CB', foot: 'right', dob: '2001-01-01', heightCm: 190, weightKg: 84, stats: { appearances: 30, goals: 2, assists: 1 } },
  { id: 'arch-direct-winger', label: 'Direct winger', position: 'RW', foot: 'left', dob: '2003-01-01', heightCm: 177, weightKg: 71, stats: { appearances: 30, goals: 10, assists: 11 } },
  { id: 'arch-sweeper-keeper', label: 'Sweeper keeper', position: 'GK', foot: 'right', dob: '2000-01-01', heightCm: 192, weightKg: 87, stats: { appearances: 30, goals: 0, assists: 0 } },
]);

/** A deep, writable copy — the exports are frozen so a caller cannot edit the catalogue. */
export const planCatalogue = () => structuredClone(PLANS);
export const archetypeCatalogue = () => structuredClone(ARCHETYPES);
