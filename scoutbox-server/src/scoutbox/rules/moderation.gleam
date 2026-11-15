//// Text moderation (domain.ts `moderateText`): children cannot share contact details through the platform, and
//// steering language goes to a human at once. False positives are acceptable: nothing is punished automatically.
////
//// The patterns are domain.ts's, read by Erlang's PCRE instead of V8. Each is case-insensitive as there (`/i`),
//// and `\b`, `\s` and `\d` are ASCII in both.

import gleam/list
import gleam/regexp.{type Regexp}
import scoutbox/rows/moderation_flags.{
  type Flag, Email, EmailObfuscated, MeetOffPlatform, PersonalProbing,
  PhoneNumber, PhoneSpelled, Secrecy, SocialHandle, SocialPlatform, Url,
}
import scoutbox/rows/moderation_log.{type Severity, Contact, Grooming}

pub type Hit {
  Hit(flags: List(Flag), severity: Severity)
}

fn patterns() -> List(#(Flag, Severity, String)) {
  [
    #(Email, Contact, "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}"),
    #(
      EmailObfuscated,
      Contact,
      "\\b[a-z0-9._%+-]{2,}\\s*(\\(|\\[)?\\s*at\\s*(\\)|\\])?\\s*[a-z0-9-]{2,}\\s*(\\(|\\[)?\\s*dot\\s*(\\)|\\])?\\s*[a-z]{2,}\\b",
    ),
    #(PhoneNumber, Contact, "(\\+?\\d[\\d\\s().-]{7,}\\d)"),
    #(
      PhoneSpelled,
      Contact,
      "\\b(zero|one|two|three|four|five|six|seven|eight|nine)([\\s-]+(zero|one|two|three|four|five|six|seven|eight|nine)){6,}\\b",
    ),
    #(SocialHandle, Contact, "(^|\\s)@[a-z0-9_.]{3,}"),
    #(
      SocialPlatform,
      Contact,
      "\\b(whatsapp|snapchat|instagram|telegram|discord|tiktok|signal|wickr|kik|viber|dm me|dms)\\b",
    ),
    #(Url, Contact, "\\bhttps?:\\/\\/|www\\.[a-z0-9-]+\\.[a-z]{2,}"),
    #(
      MeetOffPlatform,
      Contact,
      "\\b(meet (me|us) (at|outside)|off the app|off[- ]platform)\\b",
    ),
    #(
      Secrecy,
      Grooming,
      "\\b(don'?t tell (your|ur|any)|keep (this|it) (between us|a? ?secret|quiet)|(our|a) little secret|come alone)\\b",
    ),
    #(
      PersonalProbing,
      Grooming,
      "\\b(what school (do|does)|home alone|are you alone|where do you live|send (me )?(more )?(photos|pictures|pics) of (you|yourself))\\b",
    ),
  ]
}

fn compiled() -> List(#(Flag, Severity, Regexp)) {
  list.map(patterns(), fn(p) {
    let assert Ok(re) =
      regexp.compile(
        p.2,
        regexp.Options(case_insensitive: True, multi_line: False),
      )
      as "the moderation patterns compile"
    #(p.0, p.1, re)
  })
}

/// `Ok(Nil)` when the text passes; otherwise the flags it raised, in pattern order, and the worst severity.
pub fn check(text: String) -> Result(Nil, Hit) {
  let hits = list.filter(compiled(), fn(p) { regexp.check(p.2, text) })
  case hits {
    [] -> Ok(Nil)
    _ ->
      Error(
        Hit(
          flags: list.map(hits, fn(p) { p.0 }),
          severity: case list.any(hits, fn(p) { p.1 == Grooming }) {
            True -> Grooming
            False -> Contact
          },
        ),
      )
  }
}
