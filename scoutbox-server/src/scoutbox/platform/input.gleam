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
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string

pub type Problem {
  Required
  UnknownField
  NotObject
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
  Invalid
}

pub fn problem_name(problem: Problem) -> String {
  case problem {
    Required -> "required"
    UnknownField -> "unknown_field"
    NotObject -> "not_object"
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

fn optional(
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
  json.object(
    list.flatten([
      [
        #("error", json.string(r.error)),
        #("field", json.string(r.field)),
        #("problem", json.string(problem_name(r.problem))),
        #("message", json.string(r.message)),
      ],
      optional(r.min, "min", json.int),
      optional(r.max, "max", json.int),
      optional(r.expected, "expected", json.string),
      optional(r.allowed, "allowed", json.array(_, json.string)),
    ]),
  )
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
    // order, so here it is the first in key order. Either way, one is named.
    case
      dict.keys(fields)
      |> list.sort(string.compare)
      |> list.find(fn(k) { !list.contains(named, k) })
    {
      Ok(unknown) ->
        Error(#(
          unknown,
          issue(UnknownField, "is not a field this request takes"),
        ))
      Error(Nil) -> Ok(value)
    }
  })
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
  case decode.run(input, decode.dict(decode.string, decode.dynamic)) {
    Error(_) ->
      Error(Refusal(
        error: list.key_find(codes, root)
          |> option.from_result
          |> option.unwrap("FIELD_INVALID"),
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
          let error = case list.key_find(codes, field), i.code {
            Ok(code), _ -> code
            Error(Nil), Some(code) -> code
            Error(Nil), None -> "FIELD_INVALID"
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
