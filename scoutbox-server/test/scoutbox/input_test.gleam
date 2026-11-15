import gleam/dynamic
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import scoutbox/platform/input

type Prefs {
  Prefs(start: option.Option(String), email: option.Option(Bool))
}

fn shape() -> input.Shape(Prefs) {
  use start <- input.field("quietStart", input.nullish(input.time_of_day()))
  use email <- input.field("email", input.nullish(input.boolean()))
  input.done(Prefs(start:, email:))
}

fn body(pairs: List(#(String, dynamic.Dynamic))) -> dynamic.Dynamic {
  dynamic.properties(pairs |> list.map(fn(p) { #(dynamic.string(p.0), p.1) }))
}

fn refusal_text(r: Result(a, input.Refusal)) -> String {
  let assert Error(refusal) = r
  json.to_string(input.refusal_json(refusal))
}

pub fn absent_and_null_are_none_test() {
  assert input.parse(shape(), body([#("email", dynamic.nil())]), "body", [])
    == Ok(Prefs(None, None))
}

pub fn valid_input_is_read_as_sent_test() {
  assert input.parse(
      shape(),
      body([
        #("quietStart", dynamic.string("22:00")),
        #("email", dynamic.bool(False)),
      ]),
      "body",
      [],
    )
    == Ok(Prefs(Some("22:00"), Some(False)))
}

pub fn a_time_refusal_carries_its_code_and_expected_test() {
  assert refusal_text(
      input.parse(
        shape(),
        body([#("quietStart", dynamic.string("25:00"))]),
        "body",
        [],
      ),
    )
    == "{\"error\":\"TIME_INVALID\",\"field\":\"quietStart\",\"problem\":\"not_a_time\",\"message\":\"quietStart must be a time written HH:MM (24-hour).\",\"expected\":\"HH:MM\"}"
}

pub fn a_route_code_wins_over_the_problem_code_test() {
  let assert Error(r) =
    input.parse(shape(), body([#("quietStart", dynamic.int(7))]), "body", [
      #("quietStart", "FIELD_INVALID"),
    ])
  assert r.error == "FIELD_INVALID"
}

pub fn a_number_is_not_a_boolean_test() {
  assert refusal_text(
      input.parse(shape(), body([#("email", dynamic.int(0))]), "body", []),
    )
    == "{\"error\":\"FIELD_INVALID\",\"field\":\"email\",\"problem\":\"not_boolean\",\"message\":\"email must be true or false.\"}"
}

pub fn an_unknown_field_is_refused_after_the_known_ones_test() {
  let assert Error(r) =
    input.parse(
      shape(),
      body([
        #("bogus", dynamic.int(1)),
        #("email", dynamic.string("yes")),
      ]),
      "body",
      [],
    )
  assert r.field == "email"
  let assert Error(r) =
    input.parse(shape(), body([#("bogus", dynamic.int(1))]), "body", [])
  assert r.problem == input.UnknownField
}

pub fn a_list_is_not_an_object_test() {
  assert refusal_text(
      input.parse(shape(), dynamic.list([dynamic.int(1)]), "body", []),
    )
    == "{\"error\":\"FIELD_INVALID\",\"field\":\"body\",\"problem\":\"not_object\",\"message\":\"body must be an object.\"}"
}

pub fn too_long_counts_utf16_units_like_javascript_test() {
  let one = input.nullish(input.text(3))
  // Two emoji are four UTF-16 units: over a limit of 3, as JavaScript counts.
  let assert Error(_) = one(Some(dynamic.string("😀😀")))
  let assert Ok(Some(_)) = one(Some(dynamic.string("abc")))
  assert input.utf16_length("é😀") == 3
}

pub fn hhmm_test() {
  assert input.is_hhmm("00:00")
  assert input.is_hhmm("23:59")
  assert !input.is_hhmm("24:00")
  assert !input.is_hhmm("7:00")
  assert !input.is_hhmm("07:60")
  assert !input.is_hhmm("+7:00")
}
