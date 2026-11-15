// Writes test/fixtures/rule_cases.json: what the TypeScript server's own rules (domain.ts) decide for many
// cases, so the Gleam test can check the ported rules against every one:
//   - visibility: visibleToOrg for players born either side of each country's adult cutoff (29 February
//     included), against every kind of organisation, on fixed days (a leap day among them);
//   - moderation: moderateText's flags and severity over a corpus of near-misses and hits.
// Regenerate with `node dev/rule_cases.mjs` (Node ≥ 22.18 strips types).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { visibleToOrg, moderateText } = await import(path.join(HERE, '../../../scoutbox/scoutbox-server/domain.ts'));

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const days = ['2026-11-15', '2028-02-29', '2027-03-01', '2027-02-28', '2030-01-01'].map((d) => Date.parse(`${d}T12:00:00Z`));
const countries = ['GB', 'KR', 'TH', 'EG', 'SG', 'NZ', 'US'];
const ages = { KR: 19, TH: 20, EG: 21, SG: 21 };
const orgs = [
  { name: 'agency', type: 'agency', verified: true, level: 'agency', location: null },
  { name: 'verified club', type: 'club', verified: true, level: 'pro', location: { lat: 51.889, lng: 1.02 } },
  { name: 'unverified club', type: 'club', verified: false, level: 'academy', location: { lat: 53.408, lng: -2.983 } },
  { name: 'verified grassroots', type: 'club', verified: true, level: 'grassroots', location: { lat: 51.552, lng: -0.022 } },
  { name: 'unverified grassroots', type: 'club', verified: false, level: 'grassroots', location: { lat: 53.451, lng: -2.24 } },
  { name: 'grassroots without a ground', type: 'club', verified: true, level: 'grassroots', location: null },
];
const near = { lat: 51.5, lng: -0.1 }; // within 50 km of the verified grassroots club, far from the others
const visibility = [];
for (const now of days) {
  const today = new Date(now);
  for (const country of countries) {
    const years = ages[country] ?? 18;
    const cutoff = Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth(), today.getUTCDate());
    const dobs = new Set([iso(cutoff - DAY), iso(cutoff), iso(cutoff + DAY), iso(cutoff + 2 * DAY)]);
    for (const y of [today.getUTCFullYear() - years, today.getUTCFullYear() - years - 1]) {
      if (new Date(Date.UTC(y, 1, 29)).getUTCDate() === 29) dobs.add(`${y}-02-29`);
    }
    for (const dob of dobs)
      for (const level of ['amateur', 'semi_pro', 'pro'])
        for (const location of [near, null])
          for (const org of orgs) {
            const player = { dob, country, level, location };
            // visibleToOrg reads the clock through isAdult; give it this case's day.
            const RealDate = Date;
            globalThis.Date = class extends RealDate {
              constructor(...a) { super(...(a.length ? a : [now])); }
              static now() { return now; }
            };
            const visible = visibleToOrg(player, org);
            globalThis.Date = RealDate;
            visibility.push({ now, dob, country, level, location, org: org.name, visible });
          }
  }
}

const texts = [
  'keep this a secret from everyone', 'Keep it between us', "don't tell your parents", 'dont tell ur coach',
  'our little secret', 'come alone to training', 'what school do you go to', 'are you alone right now',
  'where do you live?', 'send me more pics of yourself', 'send photos of you', 'home alone tonight?',
  'email me at player@example.com', 'player (at) example (dot) com', 'john at gmail dot com',
  'call +44 7700 900123', 'ring 07700-900-123', 'one two three four five six seven', 'zero one two three',
  'follow me @striker_99', 'my handle is @ab', 'add me on WhatsApp', 'DM me', 'dms open', 'snapchat later',
  'visit https://example.com', 'www.example-club.com', 'meet me at the park', 'lets talk off the app',
  'off-platform is easier', 'Scored twice in the cup final', 'Signed for the academy in 2024',
  'Top scorer, 12 goals', 'Played at Wembley', 'secretary of the club', 'signalled for a penalty',
  'Moved to the U18s', 'alone in the box, scored', 'tell your team well done', 'atdotcom',
  'Won player of the month', '', '   ', 'keep quiet about the transfer', 'kik off at 3pm',
];
const moderation = texts.map((text) => {
  const r = moderateText(text);
  return { text, flags: r.flags, severity: r.severity };
});

const out = path.join(HERE, '../test/fixtures/rule_cases.json');
fs.writeFileSync(out, `${JSON.stringify({ visibility, moderation })}\n`);
console.log(`wrote ${visibility.length} visibility and ${moderation.length} moderation cases`);
