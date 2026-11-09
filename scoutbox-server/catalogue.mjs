/**
 * Product catalogue — constants that are NOT user data.
 *
 * The billing plans and the positional archetypes are product configuration: no route writes them, and they are read
 * from here and nowhere else. Changing one is a release. `orgs.plan` is one of the PLANS keys (its
 * CHECK; repositories/orgs.mjs ORG_PLANS is derived from this object), so a plan lookup never falls back.
 */

function deepFreeze(v) {
  if (v && typeof v === 'object') { for (const x of Object.values(v)) deepFreeze(x); Object.freeze(v); }
  return v;
}

/**
 * Billing plans, keyed by the value stored on `org.plan`.
 *
 * Read by the signing route and the plan view for the attribution window.
 */
export const PLANS = deepFreeze({
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
export const ARCHETYPES = deepFreeze([
  { id: 'arch-pressing-forward', label: 'Pressing forward', position: 'ST', foot: 'right', dob: '2002-01-01', heightCm: 185, weightKg: 80, stats: { appearances: 30, goals: 18, assists: 5 } },
  { id: 'arch-deep-playmaker', label: 'Deep-lying playmaker', position: 'CM', foot: 'left', dob: '2001-01-01', heightCm: 177, weightKg: 72, stats: { appearances: 30, goals: 3, assists: 10 } },
  { id: 'arch-ball-playing-cb', label: 'Ball-playing centre-back', position: 'CB', foot: 'right', dob: '2001-01-01', heightCm: 190, weightKg: 84, stats: { appearances: 30, goals: 2, assists: 1 } },
  { id: 'arch-direct-winger', label: 'Direct winger', position: 'RW', foot: 'left', dob: '2003-01-01', heightCm: 177, weightKg: 71, stats: { appearances: 30, goals: 10, assists: 11 } },
  { id: 'arch-sweeper-keeper', label: 'Sweeper keeper', position: 'GK', foot: 'right', dob: '2000-01-01', heightCm: 192, weightKg: 87, stats: { appearances: 30, goals: 0, assists: 0 } },
]);

