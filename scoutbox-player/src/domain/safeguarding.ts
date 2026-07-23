// Safeguarding logic — MIRRORS scoutbox-server/domain.mjs. The server is the
// enforcement point (it rejects under-age sign-ups with 403 ADULTS_ONLY);
// this copy exists so the app can explain the rule before a request is made.

export const ADULT_AGE: Record<string, number> = {
  DEFAULT: 18,
  KR: 19,
  TH: 20,
  EG: 21,
  SG: 21,
  NZ: 18,
};

export function adultAgeFor(country: string): number {
  return ADULT_AGE[country] ?? ADULT_AGE.DEFAULT;
}

export function ageOn(dob: string, onDate: Date = new Date()): number {
  const birth = new Date(dob);
  let age = onDate.getFullYear() - birth.getFullYear();
  const m = onDate.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && onDate.getDate() < birth.getDate())) age--;
  return age;
}

export function isAdult(dob: string, country: string): boolean {
  return ageOn(dob) >= adultAgeFor(country);
}

export const SAFEGUARDING_PROMISES = [
  'You never pay to be seen. Discovery is free for every player, forever.',
  'No unsolicited contact. Clubs can only file a request — nothing reaches you unless it is accepted.',
  'Every scouting action on your profile is attributed to a named scout at a named organisation, on an append-only ledger.',
  'Your medical data is yours. No organisation sees any of it unless sharing is switched on.',
] as const;

// The under-18 rules, shown to children and parents in plain language.
export const U18_PROMISES = [
  'Parents own every under-18 account. A guardian verifies their ID and accepts the safeguarding disclaimer before a child profile can exist.',
  'No child receives direct messages. Ever. Scouts contact the parent — the conversation happens between adults.',
  'No comments, no likes, no followers, no public messaging. Profiles are app-only, hidden from public browsing and search engines.',
  'Only verified clubs can see under-18 profiles. Agencies cannot — the API refuses on every endpoint.',
  'Trial invitations replace open chat. The parent receives the invite and accepts or declines.',
  'All communications are logged and visible to the parent. AI moderation blocks personal contact details, with one-click reporting and blocking on every screen.',
] as const;
