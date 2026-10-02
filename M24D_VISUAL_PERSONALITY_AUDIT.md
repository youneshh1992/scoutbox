# M24D — Visual personality audit

The "generic generated UI" language the brief names — outlined and nested
cards, pills on everything, decorative icons in circles, emoji, repeated
green outlines, equal-weight actions, long copy, little whitespace — audited
across the five applications. **Fixed** means changed in this pass;
**kept** means left deliberately, with the reason; **later** means noted
for a dedicated pass because the screen is a mature workflow that this
brief says not to redesign.

## Fixed in this pass

| App | Screen | Problem | Change |
|---|---|---|---|
| Player | Entry / sign-up | two outlined role cards, emoji in icon circles (🏃 / 🛡️), a 🔗 link, check-list cards with ✓ / 🛡, avatar circles on the demo rows, step dots, nested cards in every step, two sign-in forms each with a primary button | rows with an arrow (Player · Parent · Guardian · Use an invitation code), one sentence of copy, plain promise lists with the brand square, one sign-in form at a time with one primary action, steps as plain groups ("Step n of 5"), errors as plain text with role=alert |
| Player | Opportunities | six categories; the Board a category of its own; Current stage and Tasks as separate pages | five categories; Board a page of the journey; Overview carries stage, shared records and tasks |
| Player | Profile / You / Home / Board / Trial / Threads / Journey / Signing / Offer / Agent | 97 decorative emoji in headings, labels, chips and stat tiles (⚽ 👕 🧤 🔥 📍 🎂 📈 🎓 📷 ✔ 📋 🎬 📎 📊 ⚑ …) | removed; headings read as headings; stat tiles are value + label; the Report control keeps its lucide flag |
| Agent | Entry | agency card with `agency` / plan pills, demo roster as outlined buttons with role pills, the duplicate "agency / Agent" badge, a demo pill | AGENCY / name in plain text / "Choose a profile to continue." / three rows Name — Role → |
| Pro, Grassroots | Entry | nine pills across the organisation cards (type, plan, Trusted Partner, Verified / pending), outlined card boxes, a demo pill, long introduction copy | organisation rows (name, one quiet line, arrow, the chosen one named in green), one sentence under the headline, the three points desktop-only, a quiet demo note |
| Grassroots | Register club | a boxed form with its own heading and a three-sentence paragraph | one sentence; the fields; one primary action |
| Trust & Safety | Entry | — | one sentence under the headline (already minimal) |
| Pro, Grassroots, Agent | Sidebar | 22 Recruitment links always visible under five labels; six-page groups; Organisation six flat pages | one section and one group open at a time (4 links visible); seven groups of ≤ 4; Organisation in two groups of three |
| Pro, Grassroots, Agent | Account block | four pills (type, Verified, Trusted Partner, 🛡 Safeguarding Certified) | one quiet line of standing: "club · Verified club · Trusted Partner · Safeguarding Certified" |
| Trust & Safety | Sidebar / top bar | Cases 7 tabs, Operations 6 tabs; a `demo data` pill; 🛡 on the certified pill | nine groups of ≤ 5 (Evidence, Delivery & Billing added); "Demo data" as quiet text; no emoji |
| Pro, Grassroots | Integrations, Organisation, Verification, Search, Rooms, Pipeline, Coverage, Calibration, Groups, Transition packs, Budgets | 146 decorative emoji in headings, notices, notifications and buttons (🔎 ✅ 🔗 👥 🔑 🚫 🔐 🔄 🎯 🙈 📎 🤝 📋 👁 📂 📊 👋 🎞 📄 💬 📨 ✉ 🔓 🎫 🌙 💾 🔔 ⚖ 🪪 🛑 📝 🎟 🌐 🎬 📅 🗂 🎉 ✍ ⚑ 🎥 …) | removed |

Totals: **243 emoji removed** across the five applications (every decorative
pictograph); **9 → 0 pills** on the Pro entry, **5 → 0** on the Agent entry,
**4 → 0** on the portal account block, **1 → 0** on the Trust & Safety top
bar; **22 → 4** visible Recruitment links; Player entry **2 outlined cards +
6 inner cards → 0**, **3 icon circles → 0**, **5 step dots → 0**.

## Kept, deliberately

| App | Screen | Element | Why |
|---|---|---|---|
| Pro, Grassroots | Rooms, Offers, Evidence, Budgets | 🔒 before a private note / a privacy notice | it is the one glyph that says "this is the club's own and never leaves" — a meaning, not decoration; the Offer and Signing suites also assert it beside the private note |
| Pro, Grassroots, Player | Passport history | 🏅 before an achievement record | an achievement marker the Player and Passport suites assert |
| All | status and verification chips (`.pill` on submitted / published / verified / tier / stage) | state encoded in form as well as text — the brief's "pills everywhere" is about decoration; these carry state and the suites read them |
| All | ✓ ✕ ➤ ⚠ ★ ✅ (typographic marks in status text) | they are text, not pictures, and several suites assert the exact status strings ("✓ Accepted — signing pending", "➤ Issued — awaiting response", "✅") |
| Player | Sign-in / submit buttons as rounded pills | the approved M24C submit shape; one per step |
| Player | the bright green introduction panel | the approved entry-screen scheme (M24C.3) — reduced to a headline and one sentence |

## Noted for a later pass (mature workflow screens; not redesigned here)

| App | Screen | Problem |
|---|---|---|
| Pro, Grassroots | Recruitment Room | several `.section` panels stacked with their own borders inside the case (nested panels); action rows where every button has equal weight |
| Pro, Grassroots | Integrations / Organisation | long explanatory notices above forms; outlined notice boxes repeated per block |
| Player | Profile ("You") | many small bordered cards in a column; chips for every attribute; the identity row could be the reference's profile introduction throughout |
| Player | Board page | four sections now on one page — long on a phone; a second pass could make Fit, Invites and Follow-ups progressive |
| Agent | Client detail | pill rows for tiers and relationship state on every card |
| Trust & Safety | Review queue | equal-weight Approve / Reject / Escalate on every row; dense copy |

None of these change what a screen does; all are presentation.
