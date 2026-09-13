# M21 — development terminology

The canonical vocabulary for the Development Hub (§160). One word, one meaning,
in the server, in three clients, in two languages and in every document.

The rule the whole list serves:

> ScoutBox should document and coordinate development — not claim to measure a
> player's worth, ceiling or future.

`assertDevelopmentVocabulary()` runs at boot and refuses to start a server whose
own labels have drifted towards a rating, and `m21E2E` cross-checks this file
against the code in both directions — a term approved here that the code does
not use, or a forbidden name the code does use, fails the suite.

---

## Approved

| Term | What it means, exactly |
|---|---|
| **Development Plan** | A container: a player, an owner, a visibility, a status and a set of goals. It is a record of agreed work, not a measurement. |
| **Development Goal** | One objective inside a plan, in a structured category, with an optional target date and an optional objective target. |
| **Development Action** | One concrete step under a goal, with a type, an optional due date and an optional assignee. |
| **Development Review** | An append-only entry recording what a reviewer saw at a point in time. Corrected by supersession, never edited. |
| **Player reflection** | A player's own words about their own development. Never presented as an assessment. |
| **Guardian reflection** | The same, written by the guardian of a minor. |
| **Coach review** | A review written by staff of the organisation that owns the plan, with the organisation attributed. |
| **Linked evidence** | A reference to a canonical record — Passport evidence, an assessment, a Box Cam session, a Combine result, a trial report. Resolved live; never copied. |
| **Target met** | The one measurement the goal states has been reached. It does not mean the goal is achieved. |
| **Target not met** | The stated measurement has been taken and is short of the number. |
| **No current valid measurement** | There is no production-valid measurement to compare — because none exists, because the only ones are simulated, because they were taken under a different protocol version, or because the supporting result was invalidated. Four reasons, four sentences. |
| **Evidence unavailable** | A link points at a record that cannot be resolved for this viewer right now. The link stays; the content does not travel. |
| **Achieved** | The plan owner or reviewer marked the agreed objective complete. **Not** a ScoutBox finding that the player permanently possesses the ability. The sentence travels with the word wherever it appears. |
| **Blocked** | The goal cannot progress for a stated structural reason: waiting for an assessment, scheduling, facility, waiting for a coach review, or other. |
| **Overdue** | A due date has passed. A fact about a date, never a characterisation of a person. |
| **Evidence confidence** | The M16.2 Trust Score, shown as context about the *evidence*. Never development progress. |

## Forbidden

These do not exist in ScoutBox and are not planned. Each is refused for the
same reason: a single blended figure invites a decision about a person that the
figure cannot support.

- Development Score
- Potential Score
- Improvement Score
- Readiness Score
- Growth Score
- Academy Score
- Player Progress Rating
- Player Rating
- Development Rating
- Development Ranking
- Coach Ranking

Also refused, in identifier form, on any client-supplied field: `developmentScore`,
`potentialScore`, `progressPercent`, `percentDeveloped`, `ceiling`,
`projectedCeiling`, `talentScore`, and their snake_case spellings.

The two lists are separate on purpose. Prose has to be able to say "ScoutBox
does not measure a player's ceiling" while `ceiling` remains a forbidden field
name — the copy scan looks for the product NAMES, the payload scan looks for the
identifiers.

## Allowed to say, and how

| Instead of | Say |
|---|---|
| "60% developed" | "3 of 5 actions completed" |
| "Development Score 82" | "4 active goals · 2 actions due · last review 12 Aug" |
| "Player lacks football intelligence" | "Improve scanning before receiving possession" |
| "3 hours Box Cam = 70% developed" | "Box Cam session linked as observed training" |
| "This is the best development plan for a winger" | "A template is empty structure — ScoutBox does not know what a good plan for this player contains" |
| "Reminder sent" | "Due and overdue are worked out when you open the page. There is no background scheduler in this build." |

## Words this milestone deliberately does not offer

- **`availability / rehabilitation`** as a goal category (§13 permits it *only*
  if the repository already supports it safely). It does not: there is no
  medical vocabulary, no consent model for health data and no retention rule for
  it. A structured, filterable field for a diagnosis inside a football coaching
  record is not something to add by default.
- **`injury_or_unavailable`** as a blocked reason (§48), for the same reason. A
  blocked goal can say `other` in the author's own words, which keeps health
  information out of a structured field.
