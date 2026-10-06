# ScoutBox permanent identity

Founder instruction, 5 October 2026 supersedes the earlier palette freeze: the existing ScoutBox logo and ScoutBox green are permanent; redesign the surrounding Player palette and all Player screens.

- Keep the existing ScoutBox wordmark, green square, proportions, typography and trademark treatment. Do not replace, redraw or restyle the logo.
- Keep ScoutBox green #00e676. Supporting Player colours may change: lavender, sky, peach, and richer dark surfaces distinguish content and states.
- Player UI uses SF Pro through Apple’s system font, with native sans-serif fallbacks elsewhere. Other portals retain Inter. Albert Sans remains the permanent wordmark exception.
- Explore identity through layout, hierarchy, spacing, football-specific presentation and interaction. Keep copy short and details available on demand.
- Preserve domain, safeguarding, auth, lifecycle, Offer/Signing, navigation and zero-emoji invariants. No push, merge or deployment without explicit authorization.

Approved Player direction: the Founder explicitly approved the vivid implementation on 5 October 2026 ("OH YES APPLY THIS IMMEDIATELY NOW WE ARE TALKING"). The implemented emerald, cyan, violet and magenta gradients, colourful icons, gradient messaging and animated season charts are the accepted visual baseline for continued Player UI work. Preserve this direction rather than reverting to the earlier restrained proposal.

## Messaging and icons — 5 October 2026

The Founder requested replacement of the previous icon family and social-media-inspired messaging. The shared icons now use locally bundled Phosphor Regular 2.1.1 (MIT); `icon-mapping.json` preserves call-site names and the regular geometry is shared, while Player now uses locally bundled duotone and filled variants. Inter and the permanent logo remain unchanged. Player messaging uses a searchable, avatar-led inbox, compact filters, softer bubbles and a larger send control. Portal message bubbles share the softer treatment. Requests, Trial, Offer, Signing, moderation and guardian controls retain their existing meaning.

## Vivid Player direction — latest Founder instruction, 5 October 2026

The Founder rejected the restrained first pass and explicitly authorized expressive gradients, colourful icons and small chart animations throughout Player. This supersedes earlier minimalism and flat-surface defaults. The logo and #00e676 remain fixed. The Player canvas uses emerald, cyan, violet and magenta light; primary controls and sent messages use green gradients. First-time appearance defaults to dark, while saved user choices remain respected. Statistics come from existing records, animations respect reduced motion, and visual identity rings do not imply verification or online presence. Safeguarding, auth and recruitment state rules remain protected.

## Theme refinement — latest Founder instruction, 5 October 2026

High-Voltage Cyber light mode uses 135-degree #00E676 → #0088FF controls, #00C8FF accents and #FFFFFF / #F4F6F8 surfaces. Midnight Stealth uses 135-degree #00E676 → #12161A controls on #0E131F / #161C24 surfaces. This supersedes the earlier purple/magenta canvas and pastel radial glows; remove them. Dark text-bearing gradients use a contrast scrim so white labels remain readable. The permanent logo and neon green are unchanged. Season metrics use ball / boot / pitch icons for goals / assists / matches. Hero pitch markings must be aligned and kept clear of text. Reusable web CSS and Tailwind equivalents live in design-system/player-theme/.

## Canvas and motion clarification — latest Founder instruction

Remove the embossed background pitch lines in both modes. Light mode returns to a multicolour canvas: ScoutBox green leads, with teal, blue, cool slate and a restrained warm sand edge. Use soft stationary blends rather than an all-green flood, purple/pink pastels or busy patterns. Neutral card surfaces and a neutral pocket behind the untouched logo preserve readability and the green square. Dark mode retains its approved carbon surfaces and restrained emerald/cyan glows. The small aligned pitch illustration in the Eastport card remains; it is separate from the removed canvas embossing. Season bars animate only once the plot is viewable, once per page visit, and respect reduced motion. Avoid pulsing or looping backgrounds.

## Player typography — latest Founder instruction

The Founder chose SF Pro, not New York, throughout Player. This explicitly supersedes the earlier Player Inter invariant. All Player text and inputs use the platform system font: SF Pro on Apple platforms, the native sans-serif elsewhere. Do not redistribute Apple font binaries or fetch fonts at runtime. Preserve weights, italic styles, accessibility scaling, and the permanent Albert Sans ScoutBox wordmark. Portal typography is outside this Player change.

## Home finishing touches

The Home next-action card uses its green/blue gradient at 70% opacity over a neutral surface; its CTA uses 80%. Apply these opacities in both light and dark modes over their respective neutral panel surfaces. Text and icons stay fully opaque. The Home player name uses 700 weight, reduced from 800. The light-mode appearance sun uses golden yellow (#B88600), not an automatically assigned blue.

## Record presentation and timelines — latest Founder instruction

Across Player, expanded details must group facts with readable labels, values and spacing instead of loose dotted metadata paragraphs. Use RecordPanel, DetailFact, InfoNote and MetricTiles for evidence, invitations, check-ins and comparable records; shared Disclosure supplies consistent spacing; each record owns its surface. Keep all existing data, provenance, state labels and handlers.

Use the shared TimelineItem/EventRow for chronology: a continuous green rail, a steady green point and a gentle 2.8-second pulsing halo. Pulse only while the screen/app is active; reduced motion leaves steady points. Chronology markers never imply live presence, verification, talent or success. Wrap sibling timeline items without layout gaps and mark the final item so its rail ends. Passport, club history, achievements, profile/recruitment activity, development history, transaction events, Box Cam/Combine histories and Offer/Signing revision histories share this treatment.

### Player messaging — Founder reference, 5 October 2026
Use the latest Instagram inbox reference: visible rounded search, avatar shortcuts, compact filter pills and unboxed rows with a single-line message preview. Tapping a row opens the full message in a conversational bubble. Keep actual request decisions, trial scheduling, moderation, guardian routing and Offer/Signing destinations intact. No invented presence, contacts or unsupported call/compose controls. Keep unread counts attached closely to the navigation icon. Apply in light and dark themes.

### Invitations and action cards — Founder refinement, 5 October 2026
Do not stack an invitation's date, venue, notes and controls as plain paragraphs. Use the shared InvitationCard: calendar/identity header with a restrained brand tint, a venue row, short labelled supporting details, and a separate response footer. Dates are selectable full-size tiles with explicit selected state; real session times retain the organiser timezone. Apply to Player and guardian requests, squad invitations and trial-day cards. Shared RecordPanel handles related assignments, check-ins and records. Never infer verification from a decorative icon or merge trial/assessment/offer/signing states.

## Semantic icons and information hierarchy — Founder refinement, 5 October 2026

Match icons to the meaning of their label throughout Player. Opportunity board uses the board-on-legs vector; Football Passport and sports CV use the passport-and-globe vector. Composed titles must resolve the same icon as plain text. Never default unrelated headings to stacked layers.

Messages uses a squared outline speech bubble with a short central dash. The unread badge overlaps the actual upper-right corner of the icon, including when selected; do not anchor the badge to the wider navigation pill. The badge uses a contrasting raspberry red with white count, while the active label retains ScoutBox green.

Remove the shared filled disclosure body and loose stacks of muted paragraphs. Present status as labelled status rows, counts as metric tiles, record values as DetailFact rows, and explanations as discrete icon-led GuidanceNote rows with meaningful headings where applicable. Visibility separates profile access, Academy+, medical sharing and weekly counts. Apply the same hierarchy to CV, preferences, safeguarding, setup instructions, agent details and recruitment records. Preserve every domain state, safety statement, provenance and action handler.

## Development and lighter controls — Founder refinement, 5 October 2026

In light mode, gradient buttons and selected navigation controls use 70% of their previous gradient opacity, over a neutral surface. Text and icons remain fully opaque. Apply the shared Gradient control flag to primary buttons, page tabs, recruitment categories, main navigation, Home CTA and message send. Preserve dark-mode gradient strength and non-control art.

My goals uses a clear goal/category/status header and compact individual action cards with type icons, due labels and explicit completion/reopen controls. Completion remains a server-derived task count, never a development score or player progress percentage. Evidence is available in an expandable record list. Reviews use author initials/name, review type, date and an accent rail beside the feedback, with a separate lock-labelled internal-note notice. Never render internal club note content. Keep review snapshots and next-review dates accessible.

Player metadata uses a football-pitch position badge, location pin and calendar-labelled availability pill on Home, Football and Profile. Do not imply online presence or verification through an availability icon. Preserve the exact logo and core ScoutBox green.

## Flat records and social verification — latest Founder refinement

Location, position and availability appear in that order as icon-and-text rows, without boxes or pills. Keep the selected map-pin, pitch and calendar icons. A verified player's name has a bright blue filled verification seal immediately after it: 22px, a 6px gap, vertically centred in the name row. Render it only when identityVerified is true; do not create a separate Verified label. Preserve unverified and guardian-managed states.

Remove nested grey RecordPanel backgrounds and boxed GuidanceNote/InfoNote treatments throughout Player. Use one outer surface, a compact person/organisation identity, aligned label/value facts, light separators and a clear action area. Apply to agents, representation, transitions, exposure, requests, consent, coach references, transactions and placement check-ins. Consent uses two independent unchecked acknowledgements; all required explanatory text stays visible before a pending decision and the same grant requirements remain enforced. Notifications use an icon-led empty state and activity rows.

Gradient controls now use 70% of their previous opacity in BOTH themes, including bottom navigation. Home's night hero gradient is 49% (70% of its previous 70%); the night CTA is 56% (70% of its previous 80%). Labels and icons stay opaque. This supersedes the earlier instruction to leave night-mode control strength unchanged.

### Player metadata alignment
Centre the location/position/availability group beneath the name as a single block. Each row shares a 20px icon column, an 8px gap and a 20px text line. Align all text starts; do not centre individual rows independently.

### Restored bordered player metadata — latest Founder decision
Restore the earlier position badge beside location, with the bordered availability pill beneath. Football and Profile centre the metadata below the name. Home restores position/location above the name and availability below it beside the joined date. This supersedes the unboxed location-first vertical layout. Keep the 22px blue verification badge and its centred placement after the name.

### Metadata order clarification
Keep the restored bordered format, but put location first and the position badge second on the same row. Availability remains in its pill below.

### Verification badge finishing adjustment
Reduce the 22px verification badge by 5% to 20.9px. Keep the 6px horizontal gap and row centring; use a 1px downward optical adjustment to align the seal with the visible name lettering.

## Final Player design approval — 5 October 2026

The Founder approved the complete current design and requested it be made
permanent. This section resolves earlier conflicting exploratory instructions:

- Preserve the implemented light/dark canvases, system typography, semantic
  icons, social inbox, connected green timelines, invitations, goals/reviews,
  flat records, consent presentation and notifications.
- Location first, bordered position badge second on the same row; bordered
  availability pill below. Profile/Football centre the group beneath the name.
  Home keeps its restored placement above/below the name respectively.
- Verification seal: bright blue, 20.9px (5% smaller than 22px), 6px name gap,
  centred row with 1px downward optical adjustment; verified identities only.
- Gradient controls in both themes use 70% of previous opacity. Home hero:
  light 70%, dark 49%; CTA 56%. Text/icons remain fully opaque.
- Treat the checked-in source and current reference captures as the approved
  baseline. Further design changes require a new Founder instruction.

This approval is for saving the application locally. It does not authorize a
push, merge or deployment. See `HANDOFF_CLAUDE_UI.md` for rebuild instructions.
