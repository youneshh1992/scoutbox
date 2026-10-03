# M24F — Emoji audit

Definition used by the gate: any Unicode **Extended_Pictographic** code
point (the property emoji keyboards draw from) in product-owned UI source —
`.ts .tsx .js .jsx .css .html .json` under the five applications'
`src/`, the design system and the launcher page: screens, components,
translations, demo fixtures, seed UI strings, navigation and status labels,
empty states, headings, buttons, notifications. Comments are stripped
before scanning; user-generated content (names, messages) is never touched
— the rule concerns ScoutBox-authored UI. Typographic symbols that are not
pictographic (✓ ✕ ✗ → ← ○ ● ■ ◷ ▲ ▼ ⌘ ⊘ ↻ ➤) are not emoji and stay.

## Before

| Pictograph | Occurrences | Where |
|---|---|---|
| ✅ | 65 | toast strings, "Verified Clip" pills and labels, task lists, Player upload / threads / profile |
| ⚠ ⚠️ | 36 | notices, warnings, risk flags, toasts, Player section titles; 9 in source comments |
| 🔒 | 15 | privacy / internal notes, suppressed-report notices, medical-data note |
| ⏳ | 11 | "await" markers in the journey strip, room case, pending transfers |
| 🏅 | 7 | achievements on the passport and season wrap |
| ▶ | 6 | "view" / "play" links, "Next best action", "Video available" |
| ⌛ | 6 | the EXPIRED glyph in the offer / signing glyph maps |
| ⭐ | 6 | coach-reference headings, vouch pills, a notification text |
| ↩️ | 5 | reversal / withdrawal toasts, a coach-review note |
| 📂 ℹ️ ⏰ ⬜ ↔ ⏱ ☑ ☐ ⤴️ | 2 each | a demo notification, an info notice, a deferral toast, task checkboxes, "org ↔ player", temporal checks, consent checkboxes, "upload large" titles |
| ⚽ 🔭 🌱 🤝 🛡️ 🔗 | 1 each | the launcher page's app tiles |
| ™ ▪ | 3 | source comments only (the wordmark recipe) |
| **Total** | **182** (169 in UI code, 13 in comments) | 56 files |

## Policy and outcome

| Outcome | Count | Rule |
|---|---|---|
| Replaced with a functional icon from the shared lucide set | 44 | a mark that communicates state or kind: ⚠ → `triangle-alert` (16), 🔒 → `lock-keyhole` (13), ⏳ → `clock` (8), the task list ✅ / ⬜ → `circle-check` / `clock` (2, with an accessible label), ℹ️ → `info` (2), 🏅 → `trophy` (2), ⏱ → `timer` (1) |
| Replaced with words or a typographic glyph | 13 | ▶ view → "View clip", ▶ play → "Play"; ☑ / ☐ → "Acknowledged ·" prefix; ⌛ → ◷ (geometric, not pictographic) in the three glyph maps; ↔ → an em dash; "✅" as a pill label → "Done"; "✅ " session prefix → "Done · " |
| Deleted (decorative) | 112 | every toast / notify string, every pill or heading prefix (the pill or heading already says it), ⭐, 📂, ⤴️, ↩️, "▶ Next best action", the launcher tiles |
| Comments reworded | 13 | "⚠ Circular-import discipline" → "NOTE — circular-import discipline"; the wordmark comments say "small-square glyph" and "TM" |
| **Remaining unauthorized product emoji** | **0** | `e2e/m24fVisualAudit.test.mjs` — the gate fails the build on any new one |
| Documented exceptions | none | the gate's `ALLOW` set is empty; a future exception must be listed there with its reason |

The Player's React Native text cannot host the portals' SVG icon inline, so
its pictographs became words (the component's own `Icon` is used where a
glyph stands alone). The i18n files carried none of the pictographs; the
demo fixtures (`m13demo.ts`, `mockClient.ts`, `trustMock.ts`) carried three,
now plain text.

## The gate

`node e2e/m24fVisualAudit.test.mjs` — "emoji gate: 0 hardcoded product
emoji in UI source". It names the file, line and code point of any hit.
