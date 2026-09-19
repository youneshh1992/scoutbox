# M23 P5.6E — the client surfaces

Five apps. Four of them changed; the admin app did not need to. Every surface
below is the **canonical** one for its job: nothing here is a second Inbox, a
second Trial screen or a second transaction workflow.

## 1. ScoutBox Player (Expo web)

### My Agent → the disclosure section

`components/MyAgentSection.tsx`, inside the existing My Agent card.

- One section per **active** relationship, `testID="my-agent-disclosure-{id}"`.
- Three rows, `testID="my-agent-d-{key}"`, each with:
  - the choice in words,
  - its state as a **word** ("On" / "Off") in a pill, not a bare switch — so a
    screen reader and a glance get the same answer,
  - a one-line explanation of what it opens,
  - its own button, `testID="my-agent-d-{key}-toggle"`.
- A closing line saying each is separate, each starts off, and each can be turned
  off at any time.
- Fits 390 and 360 with no horizontal scroll (A8, N4).

### Shared opportunities

`AgentSharedOpportunities`, its own card, `testID="agent-shared-opportunities"`.

- **Absent** rather than empty when there is nothing: a card reading "your agent
  has shared nothing" would be a nudge about having an agent.
- Each row names the agent who shared it and says applying is the player's own act.
- **No Apply button.** They apply on the opportunity's own screen, in their own
  name (D18).
- Returns `null` for a guardian-managed account.

## 2. ScoutBox Agent

Four additions to the existing client detail tabs — no new destination, because an
agent's participation is a property of a client, not a new part of the app.

| Tab | Handle | What it shows |
| --- | --- | --- |
| Contacts | `client-contacts` | the club, the message addressed to them both, the state, the time |
| Contacts (refused) | `contacts-no-access` | the named reason, saying whose choice it was |
| Trials | `client-trials` | state, sessions, venue name and town |
| Trials (refused) | `trials-no-access` | the named reason |
| Opportunities | `share-{oppId}` | a **Share** control, never an Apply |
| Opportunities | `share-state-{oppId}`, `share-withdraw-{id}` | what was shared, and taking it back |
| Transactions | `tx-handoffs`, `handoff-{id}` | invitations from clubs: the club's name and the deadline |

The handoff rows show the **club** and **when the invitation runs out** — what a
person needs — rather than an internal case id to read. The case reference reaches
the workspace, which is what needs it (F2, F2b).

## 3. ScoutBox Club (Pro)

### The Contact tab

| Handle | What it is |
| --- | --- |
| `ct-routing` | who this contact can reach — a stated fact, not a hidden default |
| `ct-agent-party` | that the client's agent may be a party, because the client chose that |
| `ct-agent-refused` | the named code when they may not be |
| `ct-mode` | a `<fieldset>` + `<legend>` — a named group, not loose radios |
| `ct-mode-player_only`, `ct-mode-both` | exactly two options |

The note under the chooser says asking is a request, that permission depends on the
relationship, the licence and the player's own choice, that it is decided again at
send — and that **no option reaches an agent instead of the player**.

### The Decision tab → the handoff section

| Handle | What it is |
| --- | --- |
| `handoff-section` | with `data-available="0" \| "1"` |
| `handoff-state` | the invitation's status pill and whether the client was represented — rendered **only once an invitation exists** |
| `handoff-blockers` / `handoff-blocker-{code}` | every reason as its own element, so a refusal is readable and testable |
| `handoff-invite` | shown only when available |
| `handoff-withdraw` | shown only while it is still an invitation |

The section's closing line is the server's own `honest` string: an invitation to
open a transaction workspace, not an offer, carrying no terms and no fee,
committing nobody to anything.

## 4. ScoutBox Grassroots

The same two surfaces, from the same components: `ct-agent-party`, the mode
chooser, and the handoff section. A privacy rule that differed between the two
club apps would be a privacy rule with a hole in it (AL2), and a real grassroots
browser session confirms the app grew **no** Agent destination (N1).

## 5. ScoutBox Admin (Trust & Safety)

Unchanged. T&S reads the Agent domain through the read-only console P5.6B and
P5.6C built. P5.6E adds no T&S surface and no T&S write, and the admin key is not
a session on any of the new routes (AS11).

## 6. Demo mode

Every new surface has a demo mirror, and the mirrors keep the refusals:

- `scoutbox-agent/src/agentDemo.ts` carries both a disclosed client and a
  `DISCLOSURE_WITHHELD` refusal (AM1). A demo where everything is open would teach
  the wrong model of whose choice this is.
- `scoutbox-player/src/data/m24mock.ts` changes **one** disclosure at a time,
  exactly as the server does (AM2).
- `scoutbox-club/src/roomsDemo.ts` and the grassroots mirror carry the routing view
  and the handoff section.

## 7. EN and FR

Every string added in this milestone exists in both languages in all four apps.
The live suite loads the agent's trial projection in French and asserts that no
i18n key leaks onto the screen and that the French screen withholds **exactly**
what the English one withholds (N6, N6b, N6c) — because a translation is a second
place for a leak to hide.
