//// Request input: a route declares the fields it takes, and the input is valid as sent or refused. Nothing is
//// converted or coerced.
////
//// A refusal says what was wrong in fields a client can read: `error`, `field`, `problem` and the values the
//// problem needs (`min`, `max`, `expected`, `allowed`). `message` is English for developers and logs, never
//// quoting the value that was sent. This is the format the TypeScript server's `platform/schemas.mjs` produces
//// from valibot; the e2e batteries read it field by field.
////
//// ```gleam
//// let shape = {
////   use quiet_start <- input.field("quietStart", input.nullish(input.time_of_day()))
////   use email <- input.field("email", input.nullish(input.boolean()))
////   input.done(Prefs(quiet_start:, email:))
//// }
//// input.parse(shape, body, codes: [])
//// ```
////
//// Fields are checked in the order the shape names them and the first problem wins; a field the shape does not
//// name is refused once every named field has passed.

import gleam/dict.{type Dict}
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/regexp
import gleam/string
import scoutbox/platform/key_order.{type KeyOrder}
import scoutbox/platform/temporal

pub type Problem {
  Required
  UnknownField
  NotObject
  NotList
  NotText
  NotBoolean
  NotNumber
  NotWholeNumber
  Blank
  TooShort
  TooLong
  TooSmall
  TooLarge
  NotAllowed
  NotATime
  NotADate
  NotATimestamp
  Invalid
}

pub fn problem_name(problem: Problem) -> String {
  case problem {
    Required -> "required"
    UnknownField -> "unknown_field"
    NotObject -> "not_object"
    NotList -> "not_list"
    NotText -> "not_text"
    NotBoolean -> "not_boolean"
    NotNumber -> "not_number"
    NotWholeNumber -> "not_whole_number"
    Blank -> "blank"
    TooShort -> "too_short"
    TooLong -> "too_long"
    TooSmall -> "too_small"
    TooLarge -> "too_large"
    NotAllowed -> "not_allowed"
    NotATime -> "not_a_time"
    NotADate -> "not_a_date"
    NotATimestamp -> "not_a_timestamp"
    Invalid -> "invalid"
  }
}

/// What was wrong with one field, before it is named.
pub opaque type Issue {
  Issue(
    problem: Problem,
    phrase: String,
    min: Option(Int),
    max: Option(Int),
    expected: Option(String),
    allowed: Option(List(String)),
    /// The code a problem carries of its own (TIME_INVALID), unless the route names one for the field.
    code: Option(String),
    /// Inside a nested object: the field within it (`declarations.authorised`).
    within: Option(String),
    /// For an unknown field: every unknown field of its object, so a caller that knows the order they were sent in
    /// can name the first (`parse_in_order`).
    unknown: List(String),
  )
}

fn issue(problem: Problem, phrase: String) -> Issue {
  Issue(
    problem:,
    phrase:,
    min: None,
    max: None,
    expected: None,
    allowed: None,
    code: None,
    within: None,
    unknown: [],
  )
}

pub type Refusal {
  Refusal(
    error: String,
    field: String,
    problem: Problem,
    message: String,
    min: Option(Int),
    max: Option(Int),
    expected: Option(String),
    allowed: Option(List(String)),
  )
}

fn when_some(
  value: Option(a),
  name: String,
  to_json: fn(a) -> Json,
) -> List(#(String, Json)) {
  case value {
    Some(v) -> [#(name, to_json(v))]
    None -> []
  }
}

pub fn refusal_json(r: Refusal) -> Json {
  json.object(refusal_fields(r))
}

/// The refusal's fields, for a route that adds its own after them.
pub fn refusal_fields(r: Refusal) -> List(#(String, Json)) {
  list.flatten([
    [
      #("error", json.string(r.error)),
      #("field", json.string(r.field)),
      #("problem", json.string(problem_name(r.problem))),
      #("message", json.string(r.message)),
    ],
    when_some(r.min, "min", json.int),
    when_some(r.max, "max", json.int),
    when_some(r.expected, "expected", json.string),
    when_some(r.allowed, "allowed", json.array(_, json.string)),
  ])
}

// ------------------------------------------------------------------------------------------------- checks

/// Judges a value that was sent (null included).
pub type Check(a) =
  fn(Dynamic) -> Result(a, Issue)

/// Judges a field: `None` when the input does not have it.
pub type Rule(a) =
  fn(Option(Dynamic)) -> Result(a, Issue)

/// The field must be sent.
pub fn required(check: Check(a)) -> Rule(a) {
  fn(value) {
    case value {
      None -> Error(issue(Required, "is required"))
      Some(v) -> check(v)
    }
  }
}

/// Absent or null is `None`.
pub fn nullish(check: Check(a)) -> Rule(Option(a)) {
  fn(value) {
    case value {
      None -> Ok(None)
      Some(v) ->
        case dynamic.classify(v) {
          "Nil" | "Null" -> Ok(None)
          _ -> check(v) |> option_ok
        }
    }
  }
}

/// Absent is `None`; a value that was sent, null included, must pass `check` (valibot's `optional`).
pub fn optional(check: Check(a)) -> Rule(Option(a)) {
  fn(value) {
    case value {
      None -> Ok(None)
      Some(v) -> check(v) |> option_ok
    }
  }
}

/// Absent is `None` (leave the value as it is), null is `Some(None)` (clear it), and anything else must pass
/// `check`.
pub fn clearable(check: Check(a)) -> Rule(Option(Option(a))) {
  fn(value) {
    case value {
      None -> Ok(None)
      Some(v) ->
        case dynamic.classify(v) {
          "Nil" | "Null" -> Ok(Some(None))
          _ ->
            case check(v) {
              Ok(a) -> Ok(Some(Some(a)))
              Error(e) -> Error(e)
            }
        }
    }
  }
}

fn option_ok(r: Result(a, Issue)) -> Result(Option(a), Issue) {
  case r {
    Ok(v) -> Ok(Some(v))
    Error(e) -> Error(e)
  }
}

fn string_check(v: Dynamic) -> Result(String, Issue) {
  case decode.run(v, decode.string) {
    Ok(s) -> Ok(s)
    Error(_) -> Error(issue(NotText, "must be text"))
  }
}

/// Text of at most `max` characters; may be empty. Length counts UTF-16 code units, as JavaScript does, so the
/// limits agree with the TypeScript server and the apps.
pub fn text(max: Int) -> Check(String) {
  fn(v) {
    case string_check(v) {
      Error(e) -> Error(e)
      Ok(s) -> at_most(s, max)
    }
  }
}

fn at_most(s: String, max: Int) -> Result(String, Issue) {
  case utf16_length(s) > max {
    True ->
      Error(
        Issue(
          ..issue(
            TooLong,
            "must be at most " <> int.to_string(max) <> " characters long",
          ),
          max: Some(max),
        ),
      )
    False -> Ok(s)
  }
}

/// A due date (schemas.mjs `dueDate`): a calendar day `YYYY-MM-DD` (the start of that UTC day), an ISO 8601
/// date-time with an offset or Z, or integer milliseconds. Null and "" are no date.
pub fn due_date() -> Check(Option(temporal.Due)) {
  fn(v) {
    let refused = fn(why: String) {
      Error(
        Issue(
          ..issue(
            NotADate,
            "must be a calendar day (YYYY-MM-DD) or an ISO 8601 date-time with an offset ("
              <> why
              <> ")",
          ),
          expected: Some(
            "YYYY-MM-DD, ISO 8601 with offset or Z, or integer milliseconds",
          ),
          code: Some("DATE_INVALID"),
        ),
      )
    }
    case decode.run(v, decode.optional(decode.dynamic)) {
      Ok(None) -> Ok(None)
      _ ->
        case decode.run(v, decode.string), decode.run(v, decode.int) {
          Ok(""), _ -> Ok(None)
          Ok(s), _ ->
            case temporal.day_start_ms(s), temporal.instant_ms(s) {
              Ok(ms), _ -> Ok(Some(temporal.Day(ms)))
              _, Ok(ms) -> Ok(Some(temporal.Instant(ms)))
              Error(Nil), Error(why) -> refused(why)
            }
          _, Ok(ms) -> Ok(Some(temporal.Instant(ms)))
          _, _ ->
            case decode.run(v, decode.float) {
              Ok(_) -> refused("not a whole number")
              Error(_) -> refused("not a date-time")
            }
        }
    }
  }
}

/// An instant (schemas.mjs `instant`): an ISO 8601 date-time with an offset or Z, or integer milliseconds. The value
/// is kept as sent (a fingerprint is of what was sent); `temporal.instant` reads it.
pub fn instant() -> Check(Dynamic) {
  fn(v) {
    case temporal.instant(v, 1900, 2100) {
      Ok(_) -> Ok(v)
      Error(why) ->
        Error(
          Issue(
            ..issue(
              NotATimestamp,
              "must be a date-time with an offset or Z, or whole milliseconds ("
                <> why
                <> ")",
            ),
            expected: Some("ISO 8601 with offset or Z, or integer milliseconds"),
            code: Some("TIMESTAMP_INVALID"),
          ),
        )
    }
  }
}

/// A calendar day `YYYY-MM-DD` a form may leave empty (schemas.mjs `dayOrBlank`, under `nullish`): "" is no day.
pub fn day_or_blank() -> Check(Option(String)) {
  fn(v) {
    let refused = fn(why: String) {
      Error(
        Issue(
          ..issue(
            NotADate,
            "must be a calendar day written YYYY-MM-DD (" <> why <> ")",
          ),
          expected: Some("YYYY-MM-DD"),
          code: Some("DATE_INVALID"),
        ),
      )
    }
    case decode.run(v, decode.string) {
      Ok("") -> Ok(None)
      Ok(s) ->
        case temporal.date_only(s) {
          Ok(s) -> Ok(Some(s))
          Error(why) -> refused(why)
        }
      Error(_) -> refused("not text")
    }
  }
}

/// A calendar day `YYYY-MM-DD` (schemas.mjs `dateOnly`): anything else, "" included, is DATE_INVALID.
pub fn date_only() -> Check(String) {
  fn(v) {
    let why = case decode.run(v, decode.string) {
      Ok(s) -> temporal.date_only(s)
      Error(_) -> Error("not text")
    }
    case why {
      Ok(s) -> Ok(s)
      Error(why) ->
        Error(
          Issue(
            ..issue(
              NotADate,
              "must be a calendar day written YYYY-MM-DD (" <> why <> ")",
            ),
            expected: Some("YYYY-MM-DD"),
            code: Some("DATE_INVALID"),
          ),
        )
    }
  }
}

/// At most `max` ids, none named twice (schemas.mjs `idsOnce`): `what` names one in the refusal ("player").
pub fn ids_once(max: Int, what: String) -> Check(List(String)) {
  let all = items_between(id(), 0, max)
  fn(v) {
    case all(v) {
      Error(e) -> Error(e)
      Ok(ids) ->
        case list.length(list.unique(ids)) == list.length(ids) {
          True -> Ok(ids)
          False -> Error(issue(Invalid, "must not name a " <> what <> " twice"))
        }
    }
  }
}

/// `?ids=a,b,c` for a batch read (schemas.mjs `idsText`): at most `max` ids of at most 80 characters each. More
/// are refused rather than dropped. Empty entries are skipped.
pub fn ids_text(max: Int) -> Check(List(String)) {
  fn(v) {
    case string_check(v) {
      Error(e) -> Error(e)
      Ok(s) -> {
        let ids = string.split(s, ",") |> list.filter(fn(x) { x != "" })
        case
          list.length(ids) > max,
          list.any(ids, fn(x) { utf16_length(x) > 80 })
        {
          True, _ ->
            Error(
              Issue(
                ..issue(
                  TooLong,
                  "must name at most " <> int.to_string(max) <> " ids",
                ),
                max: Some(max),
              ),
            )
          _, True ->
            Error(
              Issue(
                ..issue(TooLong, "must name ids of at most 80 characters"),
                max: Some(80),
              ),
            )
          False, False -> Ok(ids)
        }
      }
    }
  }
}

/// Any value at all (valibot's `unknown`): for a field a route judges itself, or ignores.
pub fn anything() -> Check(Dynamic) {
  fn(v) { Ok(v) }
}

/// An id: text of 1 to 80 characters (schemas.mjs `id`). Spaces count, unlike `required_text`.
pub fn id() -> Check(String) {
  id_of(80)
}

/// Text of 1 to `max` characters: an identifier another system hands out.
pub fn id_of(max: Int) -> Check(String) {
  fn(v) {
    case string_check(v) {
      Error(e) -> Error(e)
      Ok("") ->
        Error(Issue(..issue(TooShort, "must not be empty"), min: Some(1)))
      Ok(s) -> at_most(s, max)
    }
  }
}

/// Text of `min` to `max` characters (valibot's `pipe(string(), minLength(min), maxLength(max))`), judged in that
/// order. Length counts UTF-16 code units.
pub fn text_between(min: Int, max: Int) -> Check(String) {
  fn(v) {
    case string_check(v) {
      Error(e) -> Error(e)
      Ok(s) ->
        case utf16_length(s) < min {
          True ->
            Error(
              Issue(
                ..issue(
                  TooShort,
                  "must be at least "
                    <> int.to_string(min)
                    <> " characters long",
                ),
                min: Some(min),
              ),
            )
          False -> at_most(s, max)
        }
    }
  }
}

/// Text with something other than spaces in it, of at most `max` characters.
pub fn required_text(max: Int) -> Check(String) {
  fn(v) {
    case string_check(v) {
      Error(e) -> Error(e)
      Ok(s) ->
        case string.trim(s) {
          "" -> Error(issue(Blank, "must not be blank"))
          _ -> at_most(s, max)
        }
    }
  }
}

/// An e-mail address: something@something.something, no spaces, at most `max` characters.
pub fn email(max: Int) -> Check(String) {
  fn(v) {
    case string_check(v) {
      Error(e) -> Error(e)
      Ok(s) ->
        case at_most(s, max) {
          Error(e) -> Error(e)
          Ok(s) ->
            case looks_like_email(s) {
              True -> Ok(s)
              False -> Error(issue(Invalid, "is not valid"))
            }
        }
    }
  }
}

// /^[^@\s]+@[^@\s]+\.[^@\s]+$/
fn looks_like_email(s: String) -> Bool {
  let no_space = fn(part) {
    part != ""
    && !list.any(string.to_graphemes(part), fn(g) { string.trim(g) == "" })
  }
  case string.split(s, "@") {
    [local, domain] ->
      no_space(local)
      && no_space(domain)
      && case string.split(domain, ".") {
        [_] -> False
        parts -> {
          let assert Ok(last) = list.last(parts)
          let first =
            list.take(parts, list.length(parts) - 1) |> string.join(".")
          no_space(first) && no_space(last)
        }
      }
    _ -> False
  }
}

pub fn boolean() -> Check(Bool) {
  fn(v) {
    case decode.run(v, decode.bool) {
      Ok(b) -> Ok(b)
      Error(_) -> Error(issue(NotBoolean, "must be true or false"))
    }
  }
}

/// A list of at most `max` items, each passing `item`. A bad item is refused under the list's name.
pub fn list_of(item: Check(a), max: Int) -> Check(List(a)) {
  fn(v) {
    case decode.run(v, decode.list(decode.dynamic)) {
      Error(_) -> Error(issue(NotList, "must be a list"))
      Ok(items) ->
        case list.length(items) > max {
          True ->
            Error(
              Issue(
                ..issue(
                  TooLong,
                  "must be at most " <> int.to_string(max) <> " items long",
                ),
                max: Some(max),
              ),
            )
          False -> list.try_map(items, item)
        }
    }
  }
}

/// A JSON number. Erlang decodes `178` as an integer and `178.5` as a float; both are numbers here.
fn number_value(v: Dynamic) -> Result(Float, Issue) {
  case decode.run(v, decode.int), decode.run(v, decode.float) {
    Ok(n), _ -> Ok(int.to_float(n))
    _, Ok(f) -> Ok(f)
    _, _ -> Error(issue(NotNumber, "must be a number"))
  }
}

fn in_range(n: Float, min: Int, max: Int) -> Result(Nil, Issue) {
  case n <. int.to_float(min), n >. int.to_float(max) {
    True, _ ->
      Error(
        Issue(
          ..issue(TooSmall, "must be at least " <> int.to_string(min)),
          min: Some(min),
        ),
      )
    _, True ->
      Error(
        Issue(
          ..issue(TooLarge, "must be at most " <> int.to_string(max)),
          max: Some(max),
        ),
      )
    False, False -> Ok(Nil)
  }
}

/// A claim's value: a finite number, or text of at most `max` characters.
pub type NumberOrText {
  Number(Float)
  Text(String)
}

pub fn number_or_text(max: Int) -> Check(NumberOrText) {
  fn(v) {
    case number_value(v), string_check(v) {
      Ok(n), _ -> Ok(Number(n))
      _, Ok(s) -> at_most(s, max) |> result_map_text
      _, _ -> Error(issue(Invalid, "must be a number or text"))
    }
  }
}

fn result_map_text(r: Result(String, Issue)) -> Result(NumberOrText, Issue) {
  case r {
    Ok(s) -> Ok(Text(s))
    Error(e) -> Error(e)
  }
}

/// A number from `min` to `max`.
pub fn number(min: Int, max: Int) -> Check(Float) {
  fn(v) {
    case number_value(v) {
      Error(e) -> Error(e)
      Ok(n) -> in_range(n, min, max) |> result_replace(n)
    }
  }
}

/// A whole number from `min` to `max` (JavaScript's safe integers: `4.0` is the whole number 4).
pub fn whole_number(min: Int, max: Int) -> Check(Int) {
  fn(v) {
    case number_value(v) {
      Error(e) -> Error(e)
      Ok(n) ->
        case float.floor(n) == n {
          False -> Error(issue(NotWholeNumber, "must be a whole number"))
          True -> in_range(n, min, max) |> result_replace(float.truncate(n))
        }
    }
  }
}

/// A whole number written as text, as a query string carries it: digits only, so `1.5`, `-1` and ` 7` are
/// refused rather than read as some other number (schemas.mjs `wholeNumberText`).
pub fn whole_number_text(min: Int, max: Int) -> Check(Int) {
  fn(v) {
    case string_check(v) {
      Error(e) -> Error(e)
      Ok(s) ->
        case
          s != ""
          && string.length(s) <= 15
          && all_digits(string.to_graphemes(s)),
          int.parse(s)
        {
          True, Ok(n) ->
            in_range(int.to_float(n), min, max) |> result_replace(n)
          _, _ -> Error(issue(NotWholeNumber, "must be a whole number"))
        }
    }
  }
}

fn result_replace(r: Result(Nil, Issue), value: a) -> Result(a, Issue) {
  case r {
    Ok(Nil) -> Ok(value)
    Error(e) -> Error(e)
  }
}

/// A wall-clock time, HH:MM on the 24-hour clock. Anything else, a non-string included, is TIME_INVALID.
pub fn time_of_day() -> Check(String) {
  fn(v) {
    case decode.run(v, decode.string) {
      Ok(s) ->
        case is_hhmm(s) {
          True -> Ok(s)
          False -> Error(not_a_time())
        }
      Error(_) -> Error(not_a_time())
    }
  }
}

fn not_a_time() -> Issue {
  Issue(
    ..issue(NotATime, "must be a time written HH:MM (24-hour)"),
    expected: Some("HH:MM"),
    code: Some("TIME_INVALID"),
  )
}

/// HH:MM, 00:00 to 23:59.
pub fn is_hhmm(s: String) -> Bool {
  case string.to_graphemes(s) {
    [h1, h2, ":", m1, m2] ->
      case int.parse(h1 <> h2), int.parse(m1), int.parse(m2) {
        Ok(h), Ok(m), Ok(_) ->
          h >= 0 && h <= 23 && m >= 0 && m <= 5 && all_digits([h1, h2, m1, m2])
        _, _, _ -> False
      }
    _ -> False
  }
}

fn all_digits(graphemes: List(String)) -> Bool {
  list.all(graphemes, fn(g) { string.contains("0123456789", g) })
}

/// One of a fixed vocabulary. Its refusal lists the values as `allowed`.
/// `one_of` for some of a vocabulary's values, in the order given, each with the text its generated `pairs` give
/// it, so a value's text is never typed by hand.
pub fn one_of_these(pairs: List(#(String, a)), values: List(a)) -> Check(a) {
  values
  |> list.map(fn(v) {
    let assert Ok(pair) = list.find(pairs, fn(p) { p.1 == v })
      as "a vocabulary's pairs hold every value"
    pair
  })
  |> one_of
}

pub fn one_of(values: List(#(String, a))) -> Check(a) {
  let names = list.map(values, fn(pair) { pair.0 })
  fn(v) {
    let refused =
      Issue(
        ..issue(NotAllowed, "must be one of " <> string.join(names, ", ")),
        allowed: Some(names),
      )
    case decode.run(v, decode.string) {
      Error(_) -> Error(refused)
      Ok(s) ->
        case list.key_find(values, s) {
          Ok(value) -> Ok(value)
          Error(Nil) -> Error(refused)
        }
    }
  }
}

/// The length of `s` in UTF-16 code units: what JavaScript's `length` reports.
pub fn utf16_length(s: String) -> Int {
  string.to_utf_codepoints(s)
  |> list.fold(0, fn(n, cp) {
    case string.utf_codepoint_to_int(cp) > 0xFFFF {
      True -> n + 2
      False -> n + 1
    }
  })
}

/// The longest prefix of whole characters that fits in `n` UTF-16 units.
pub fn utf16_take(s: String, n: Int) -> String {
  utf16_take_loop(string.to_graphemes(s), n, "")
}

fn utf16_take_loop(graphemes: List(String), room: Int, acc: String) -> String {
  case graphemes {
    [g, ..rest] ->
      case utf16_length(g) <= room {
        True -> utf16_take_loop(rest, room - utf16_length(g), acc <> g)
        False -> acc
      }
    [] -> acc
  }
}

// ------------------------------------------------------------------------------------------------- shapes

/// An object's fields, read in order.
pub opaque type Shape(a) {
  Shape(
    run: fn(Dict(String, Dynamic), List(String)) -> Result(a, #(String, Issue)),
  )
}

/// Reads the field `name` with `rule`, then the rest of the shape.
pub fn field(name: String, rule: Rule(b), next: fn(b) -> Shape(a)) -> Shape(a) {
  Shape(fn(fields, named) {
    case rule(option.from_result(dict.get(fields, name))) {
      Error(issue) -> Error(#(name, issue))
      Ok(value) -> next(value).run(fields, [name, ..named])
    }
  })
}

/// The end of a shape: `value` is the input read. Any field the shape did not name is refused.
pub fn done(value: a) -> Shape(a) {
  Shape(fn(fields, named) {
    // The TypeScript server reports the first unknown field in the order it was sent; an Erlang map has no
    // order, so here it is the first in key order, and every one is kept for `parse_in_order` to choose from.
    case
      dict.keys(fields)
      |> list.sort(string.compare)
      |> list.filter(fn(k) { !list.contains(named, k) })
    {
      [first, ..] as unknown ->
        Error(#(
          first,
          Issue(
            ..issue(UnknownField, "is not a field this request takes"),
            unknown:,
          ),
        ))
      [] -> Ok(value)
    }
  })
}

/// The end of a shape that lets fields it did not name through (valibot's `looseObject`).
pub fn loose(value: a) -> Shape(a) {
  Shape(fn(_, _) { Ok(value) })
}

/// A nested object read with its own shape. Its refusals name the field inside it (`declarations.extra`).
pub fn object(shape: Shape(a)) -> Check(a) {
  fn(v) {
    case decode.run(v, decode.dict(decode.string, decode.dynamic)) {
      Error(_) -> Error(issue(NotObject, "must be an object"))
      Ok(fields) ->
        case shape.run(fields, []) {
          Ok(value) -> Ok(value)
          Error(#(field, i)) ->
            Error(
              Issue(
                ..i,
                within: Some(case i.within {
                  Some(inner) -> path(field, inner)
                  None -> field
                }),
              ),
            )
        }
    }
  }
}

/// `field.inner`, or `field[i]…` for an item of a list.
fn path(field: String, inner: String) -> String {
  case inner {
    "[" <> _ -> field <> inner
    _ -> field <> "." <> inner
  }
}

/// A list of at most `max` items, each passing `item`. A bad item is refused naming it (`events[1].status`).
pub fn items(item: Check(a), max: Int) -> Check(List(a)) {
  fn(v) {
    case decode.run(v, decode.list(decode.dynamic)) {
      Error(_) -> Error(issue(NotList, "must be a list"))
      Ok(values) ->
        case list.length(values) > max {
          True ->
            Error(
              Issue(
                ..issue(
                  TooLong,
                  "must be at most " <> int.to_string(max) <> " items long",
                ),
                max: Some(max),
              ),
            )
          False ->
            list.index_map(values, fn(value, i) { #(i, value) })
            |> list.try_map(fn(pair) {
              case item(pair.1) {
                Ok(a) -> Ok(a)
                Error(e) -> {
                  let at = "[" <> int.to_string(pair.0) <> "]"
                  Error(
                    Issue(
                      ..e,
                      within: Some(case e.within {
                        Some(inner) -> path(at, inner)
                        None -> at
                      }),
                    ),
                  )
                }
              }
            })
        }
    }
  }
}

/// A list whose items each pass `item` (refused naming the item), then holding between `min` and `max` of them, in
/// the order valibot's `pipe(array(item), minLength, maxLength)` judges it.
pub fn items_between(item: Check(a), min: Int, max: Int) -> Check(List(a)) {
  let all = items(item, 1_000_000)
  fn(v) {
    case all(v) {
      Error(e) -> Error(e)
      Ok(values) -> {
        let n = list.length(values)
        case n < min, n > max {
          True, _ ->
            Error(
              Issue(
                ..issue(TooShort, case min {
                  1 -> "must not be empty"
                  _ ->
                    "must be at least " <> int.to_string(min) <> " items long"
                }),
                min: Some(min),
              ),
            )
          _, True ->
            Error(
              Issue(
                ..issue(
                  TooLong,
                  "must be at most " <> int.to_string(max) <> " items long",
                ),
                max: Some(max),
              ),
            )
          False, False -> Ok(values)
        }
      }
    }
  }
}

/// `check`, then `holds` over what it read: a value `holds` refuses is refused under this field's own name with
/// `phrase` (valibot's `pipe(…, check(fn, message))`), never under one of its items or keys.
pub fn refine(
  check: Check(a),
  holds: fn(a) -> Bool,
  phrase: String,
) -> Check(a) {
  fn(v) {
    case check(v) {
      Error(e) -> Error(e)
      Ok(a) ->
        case holds(a) {
          True -> Ok(a)
          False -> Error(issue(Invalid, phrase))
        }
    }
  }
}

/// `matching`, refused with the schema's own words (valibot's `regex(pattern, message)`).
pub fn matching_said(pattern: String, phrase: String) -> Check(String) {
  let check = matching(pattern)
  fn(v) {
    case check(v) {
      Error(e) if e.problem == Invalid -> Error(Issue(..e, phrase:))
      other -> other
    }
  }
}

/// Text that matches `pattern` in full; anything else is not valid (valibot's `regex`).
pub fn matching(pattern: String) -> Check(String) {
  let assert Ok(re) = regexp.from_string("^(?:" <> pattern <> ")$")
  fn(v) {
    case string_check(v) {
      Error(e) -> Error(e)
      Ok(s) ->
        case regexp.check(re, s) {
          True -> Ok(s)
          False -> Error(issue(Invalid, "is not valid"))
        }
    }
  }
}

/// A list of distinct values, each passing `item` (refused naming the item), with at least `min` of them:
/// schemas.mjs `distinctList`.
pub fn distinct_list(item: Check(a), min: Int) -> Check(List(a)) {
  let all = items(item, 1_000_000)
  fn(v) {
    case all(v) {
      Error(e) -> Error(e)
      Ok(values) ->
        case
          list.length(values) < min,
          list.length(list.unique(values)) != list.length(values)
        {
          True, _ ->
            Error(
              Issue(
                ..issue(TooShort, case min {
                  1 -> "must not be empty"
                  _ ->
                    "must be at least " <> int.to_string(min) <> " items long"
                }),
                min: Some(min),
              ),
            )
          False, True -> Error(issue(Invalid, "must not name a value twice"))
          False, False -> Ok(values)
        }
    }
  }
}

/// A request that takes no fields.
pub fn nothing() -> Shape(Nil) {
  done(Nil)
}

/// Reads `input` with `shape`. `root` names the input as a whole ("body", "query"); `codes` gives a field a
/// refusal code of its own (`[#("email", "EMAIL_INVALID")]`), which wins over a problem's own code.
pub fn parse(
  shape: Shape(a),
  input: Dynamic,
  root root: String,
  codes codes: List(#(String, String)),
) -> Result(a, Refusal) {
  parse_coded(shape, input, root:, codes:, default: "FIELD_INVALID")
}

/// `parse` for a route whose schema renames the generic refusal (`codes: { FIELD_INVALID: 'OFFER_INPUT_INVALID' }`
/// in the TypeScript server): `default` is the code of a refusal no field code and no problem code names.
pub fn parse_coded(
  shape: Shape(a),
  input: Dynamic,
  root root: String,
  codes codes: List(#(String, String)),
  default default: String,
) -> Result(a, Refusal) {
  parse_in_order(shape, input, key_order.Unknown, root:, codes:, default:)
}

/// `parse_coded` for input whose key order is known (`key_order.of` the body's text): of several unknown fields,
/// the first sent is named, as the TypeScript server names it.
pub fn parse_in_order(
  shape: Shape(a),
  input: Dynamic,
  order: KeyOrder,
  root root: String,
  codes codes: List(#(String, String)),
  default default: String,
) -> Result(a, Refusal) {
  case decode.run(input, decode.dict(decode.string, decode.dynamic)) {
    Error(_) ->
      Error(Refusal(
        error: list.key_find(codes, root)
          |> option.from_result
          |> option.unwrap(default),
        field: root,
        problem: NotObject,
        message: root <> " must be an object.",
        min: None,
        max: None,
        expected: None,
        allowed: None,
      ))
    Ok(fields) ->
      case shape.run(fields, []) {
        Ok(value) -> Ok(value)
        Error(#(field, i)) -> {
          let field = case i.within {
            Some(inner) -> path(field, inner)
            None -> field
          }
          let field = first_sent(field, i, order)
          let coded = code_for(codes, field)
          let error = case coded, i.code {
            Ok(code), _ -> code
            Error(Nil), Some(code) -> code
            Error(Nil), None -> default
          }
          Error(Refusal(
            error:,
            field:,
            problem: i.problem,
            message: field <> " " <> i.phrase <> ".",
            min: i.min,
            max: i.max,
            expected: i.expected,
            allowed: i.allowed,
          ))
        }
      }
  }
}

/// An unknown field's path, naming the first of its object's unknown fields the order says was sent.
fn first_sent(field: String, i: Issue, order: KeyOrder) -> String {
  case i.problem, i.unknown {
    UnknownField, [_, _, ..] -> {
      let steps = key_order.steps(field)
      let parent = list.take(steps, list.length(steps) - 1)
      let parent_path =
        string.drop_end(field, string.length(last_name(i, field)))
      case key_order.keys(order, parent) {
        Some(sent) ->
          case list.find(sent, list.contains(i.unknown, _)) {
            Ok(k) -> parent_path <> k
            Error(Nil) -> field
          }
        None -> field
      }
    }
    _, _ -> field
  }
}

/// The unknown field `done` named, at the end of the path: the first of them in key order.
fn last_name(i: Issue, _field: String) -> String {
  case i.unknown {
    [first, ..] -> first
    [] -> ""
  }
}

/// An object whose keys are names it chooses (valibot's `record`): each key passes `key` and each value `value`.
/// Entries come back in key order; `key_order.sort` puts them in the order sent.
pub fn entries(
  key: Check(String),
  value: Check(a),
) -> Check(List(#(String, a))) {
  fn(v) {
    case decode.run(v, decode.dict(decode.string, decode.dynamic)) {
      Error(_) -> Error(issue(NotObject, "must be an object"))
      Ok(fields) ->
        dict.to_list(fields)
        |> list.sort(fn(a, b) { string.compare(a.0, b.0) })
        |> list.try_map(fn(pair) {
          let #(k, raw) = pair
          let inside = fn(e: Issue) {
            Issue(
              ..e,
              within: Some(case e.within {
                Some(inner) -> path(k, inner)
                None -> k
              }),
            )
          }
          case key(dynamic.string(k)) {
            Error(e) -> Error(inside(e))
            Ok(_) ->
              case value(raw) {
                Ok(a) -> Ok(#(k, a))
                Error(e) -> Error(inside(e))
              }
          }
        })
    }
  }
}

/// An object whose keys are names it chooses, read as valibot's `record` reads it: a list is accepted too, as an
/// object keyed by its indexes (`[1]` is `{ "0": 1 }`). Entries come back in key order, a list's in index order.
pub fn record(
  key: Check(String),
  value: Check(a),
) -> Check(List(#(String, a))) {
  let as_object = entries(key, value)
  fn(v) {
    case decode.run(v, decode.list(decode.dynamic)) {
      Ok(items) ->
        case
          list.index_map(items, fn(item, i) {
            #(dynamic.string(int.to_string(i)), item)
          })
          |> dynamic.properties
          |> as_object
        {
          Ok(found) ->
            Ok(
              list.sort(found, fn(a, b) {
                int.compare(index_of(a.0), index_of(b.0))
              }),
            )
          Error(e) -> Error(e)
        }
      Error(_) -> as_object(v)
    }
  }
}

fn index_of(key: String) -> Int {
  case int.parse(key) {
    Ok(n) -> n
    Error(Nil) -> 0
  }
}

/// Trimmed text with something in it, or `None`: for a value a shape has read.
pub fn filled(s: Option(String)) -> Option(String) {
  case s {
    Some(s) ->
      case string.trim(s) {
        "" -> None
        trimmed -> Some(trimmed)
      }
    None -> None
  }
}

/// `tags[3].name` → `tags.*.name`.
/// The code `codes` gives `field`, as the TypeScript schemas' `fieldCodeFor` finds it: list indexes are dropped
/// (`tags[1]` is `tags`), then the exact path, then each enclosing subtree written `path.*`, innermost first, so
/// `terms.*` covers `terms` itself and every field inside it.
fn code_for(
  codes: List(#(String, String)),
  field: String,
) -> Result(String, Nil) {
  let assert Ok(index) = regexp.from_string("\\[[0-9]+\\]")
  let keys =
    regexp.replace(index, field, "")
    |> string.split(".")
    |> list.filter(fn(k) { k != "" })
  case list.key_find(codes, string.join(keys, ".")) {
    Ok(code) -> Ok(code)
    Error(Nil) -> subtree_code(codes, list.reverse(keys))
  }
}

fn subtree_code(
  codes: List(#(String, String)),
  reversed: List(String),
) -> Result(String, Nil) {
  case reversed {
    [] -> Error(Nil)
    [_, ..outer] ->
      case
        list.key_find(codes, string.join(list.reverse(reversed), ".") <> ".*")
      {
        Ok(code) -> Ok(code)
        Error(Nil) -> subtree_code(codes, outer)
      }
  }
}
