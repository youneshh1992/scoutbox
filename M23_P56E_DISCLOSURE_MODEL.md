# M23 P5.6E — the disclosure model

The client's three choices are the root of most of what an agent can see across
the other apps. This document is about how they behave, because the behaviour is
the safeguard.

## 1. Three choices, on one record

```js
DISCLOSURE_KEYS = ['clubPresence', 'contactRouting', 'trialVisibility'];
DISCLOSURE_DEFAULT = { clubPresence: false, contactRouting: false, trialVisibility: false };
```

They live on `representationAgreements[].disclosure`, not in a store of their own,
because they are properties of one relationship with one agent. A client with two
agents makes the choice twice, about two different people — which is the point.

| Choice | What it opens | Who sees the effect |
| --- | --- | --- |
| `clubPresence` | that this player is represented, and by whom | clubs looking at the player |
| `contactRouting` | the agent may be a party to a club's approach | the club, and the agent |
| `trialVisibility` | the agent may read the trial schedule | the agent |

## 2. Every one starts off

Confirming a representation relationship turns **none** of them on. This is
deliberate and asserted three ways: purely (`DISCLOSURE_DEFAULT`), over HTTP (D2)
and in a real browser (A4). A client who signs with an agent has agreed to be
represented; they have not agreed to be visible, to be routed, or to have their
trials read.

## 3. Each is its own request

`PATCH /player/agent/relationships/:id/sharing` changes what the body names and
nothing else. Turning one on leaves the other two exactly as they were (E4, A11),
and each change is one history entry with one rev bump.

The route also carries `shareWithAgencyStaff` (P5.6B's separate choice about
colleagues) — one route, one rev, one history entry, because two routes racing on
one record is how a rev gets lost.

## 4. A boolean or nothing

A key present with a value that is not a boolean is **refused**, and the whole
request is refused with it:

```
REPRESENTATION_INPUT_INVALID  field: disclosure.clubPresence
"Each disclosure is true or false. Send the choice as a boolean; nothing is
 assumed from another kind of value."
```

This started as a defect. The first implementation read `=== true` and coerced
everything else to `false`, which meant a client sending `'yes'` — from a
mistyped integration, a stale client, a hand-rolled request — would have had a
choice they were trying to turn **on** silently turned **off**. A privacy setting
is the last place to guess at an intention. See defect **E-11**.

An unknown key reaches no field at all; the three are the three (AP16).

## 5. Turning one off is immediate, and rewrites nothing

Off takes effect at the next action. It does not reach backwards:

- A contact that was validly routed to the agent **stays** in the agent's list
  (AS1, N3b). The message really was delivered to both; a record that pretended
  otherwise would be a lie about what happened (§22).
- The **next** contact does not route (AS2, N3c), and the club is told the reason
  as a code — `DISCLOSURE_WITHHELD` — with no quote from the client (AS3, N3d).
- A stored routing snapshot is never edited. It says in words that a later change
  does not rewrite it.

And off always works. A client can close a disclosure on a relationship that has
already ended (AR8): the one thing a person must always be able to do is stop
sharing.

## 6. Nobody else can make the choice

The agent, the agency administrator and the club are each refused on this route
(AP12). Another player reaching for this relationship's id is told it does not
exist rather than that it is not theirs (AP13). A guardian-managed account has no
disclosure to make, because it holds no relationship to disclose (AP14).

The agent is **notified** that a choice changed — `representation_disclosure`, in
the mutable `representation` category — and is told to open the relationship to
see which parts they can currently see. The notification does not say **which**
choice moved, and neither does the event payload. A stream should not carry a
person's privacy choices around.

## 7. What a disclosure is not

It is not consent to a transaction (P5.6C's consent ledger owns that). It is not
a mandate (the agreement is). It is not a licence (P5.6C's facets are). And it is
not a fee arrangement — no disclosure field, notification, event or screen in this
milestone has anywhere for a fee, a commission or a salary to arrive.
