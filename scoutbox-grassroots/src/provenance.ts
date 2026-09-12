// M18.2 — the one place provenance becomes words.
//
// Until M18.1 the Passport screen, the Room evidence list and the Second Look
// changes each carried their own copy of "provenance id → label", and one of
// those copies fell back to "Player-provided" for anything it did not know —
// which is how Box Cam evidence was badged as something the player typed.
// The canonical vocabulary lives here and only here. Every surface imports
// this module; none of them hard-codes a label.
//
// Colour is never the only signal: every entry carries its label, a short
// glyph, and a one-line explanation (from the server where it sends one).
// An unrecognised provenance says "Source unavailable" and explains that
// nobody is being credited with confirming it. It is never guessed.
import { t } from './i18n';

/** The server's PROVENANCE vocabulary (m15/shared.mjs), in rank order. */
export const PROVENANCE_TYPES = [
  'player_submitted', 'guardian_submitted', 'system_recorded', 'historical_migration',
  'box_cam_observed', 'scoutbox_reviewed', 'verified_coach_confirmed',
  'verified_club_confirmed', 'authoritative_registry',
  // Not a Passport provenance but a source badge surfaces use next to them.
  'combine_verified', 'simulated_demo',
] as const;
export type ProvenanceType = (typeof PROVENANCE_TYPES)[number];

export type ProvenanceTone = 'neutral' | 'reviewed' | 'coach' | 'confirmed' | 'demo';

interface ProvenanceEntry {
  labelKey: string;
  tone: ProvenanceTone;
  /** A text glyph so the badge is distinguishable without colour. */
  glyph: string;
}

const TABLE: Record<ProvenanceType, ProvenanceEntry> = {
  player_submitted: { labelKey: 'prov.player', tone: 'neutral', glyph: '·' },
  guardian_submitted: { labelKey: 'prov.guardian', tone: 'neutral', glyph: '·' },
  system_recorded: { labelKey: 'prov.system', tone: 'neutral', glyph: '·' },
  historical_migration: { labelKey: 'prov.historic', tone: 'neutral', glyph: '·' },
  // Box Cam is first-party observation and ranks BELOW a ScoutBox review, so
  // it deliberately keeps the neutral tone rather than a confirmation colour.
  box_cam_observed: { labelKey: 'prov.boxCam', tone: 'neutral', glyph: '◉' },
  scoutbox_reviewed: { labelKey: 'prov.reviewed', tone: 'reviewed', glyph: '✓' },
  verified_coach_confirmed: { labelKey: 'prov.coach', tone: 'coach', glyph: '✓' },
  verified_club_confirmed: { labelKey: 'prov.club', tone: 'confirmed', glyph: '✓' },
  authoritative_registry: { labelKey: 'prov.registry', tone: 'confirmed', glyph: '✓' },
  combine_verified: { labelKey: 'prov.combineVerified', tone: 'confirmed', glyph: '✓' },
  simulated_demo: { labelKey: 'prov.simulated', tone: 'demo', glyph: '≈' },
};

const TONE_CLASS: Record<ProvenanceTone, string> = {
  neutral: '', reviewed: 'gold', coach: 'blue', confirmed: 'green', demo: 'gold',
};

export interface ProvenancePresentation {
  known: boolean;
  label: string;
  glyph: string;
  tone: ProvenanceTone;
  /** The pill class for the existing stylesheet. */
  pillClass: string;
  /** The honest one-liner: the server's copy when it sent one, otherwise ours. */
  note: string;
}

export function provenanceOf(type: string | null | undefined, serverCopy?: string | null): ProvenancePresentation {
  const entry = type ? TABLE[type as ProvenanceType] : undefined;
  if (!entry) {
    return {
      known: false, label: t('prov.unknown'), glyph: '?', tone: 'neutral', pillClass: 'pill',
      note: t('prov.unknownNote'),
    };
  }
  return {
    known: true,
    label: t(entry.labelKey),
    glyph: entry.glyph,
    tone: entry.tone,
    pillClass: `pill ${TONE_CLASS[entry.tone]}`.trim(),
    note: serverCopy || t(`${entry.labelKey}Note`, ''),
  };
}

/** True when a provenance means someone other than the subject confirmed it. */
export const isConfirmedProvenance = (type: string | null | undefined) =>
  ['scoutbox_reviewed', 'verified_coach_confirmed', 'verified_club_confirmed', 'authoritative_registry', 'combine_verified'].includes(String(type));
