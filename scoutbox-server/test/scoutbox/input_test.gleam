import gleam/dynamic
import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import scoutbox/platform/input
import scoutbox/platform/key_order

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

fn day(v: dynamic.Dynamic) -> Result(option.Option(String), input.Refusal) {
  let shape = {
    use date <- input.field("date", input.nullish(input.day_or_blank()))
    input.done(option.flatten(date))
  }
  input.parse(shape, body([#("date", v)]), "body", [])
}

pub fn a_calendar_day_may_be_left_blank_test() {
  assert day(dynamic.string("2026-02-28")) == Ok(Some("2026-02-28"))
  assert day(dynamic.string("")) == Ok(None)
  assert day(dynamic.nil()) == Ok(None)
}

pub fn a_day_refusal_says_why_as_temporal_ts_does_test() {
  let why = fn(v) {
    let text = refusal_text(day(v))
    assert string.contains(text, "\"error\":\"DATE_INVALID\"")
    text
  }
  assert string.contains(
    why(dynamic.string("2026-02-30")),
    "(no such day in that month)",
  )
  assert string.contains(why(dynamic.string("2026-13-01")), "(no such month)")
  assert string.contains(
    why(dynamic.string("1899-01-01")),
    "(year outside 1900–2100)",
  )
  assert string.contains(why(dynamic.string("1 May")), "(wrong shape)")
  assert string.contains(why(dynamic.int(20_260_501)), "(not text)")
}

// ------------------------------------------------------------------------------------------------- key order

fn parsed_text(text: String, s: input.Shape(a)) -> Result(a, input.Refusal) {
  let assert Ok(raw) = json.parse(text, decode.dynamic)
  input.parse_in_order(
    s,
    raw,
    key_order.of(text),
    root: "body",
    codes: [],
    default: "FIELD_INVALID",
  )
}

pub fn the_first_unknown_field_sent_is_named_test() {
  let assert Error(r) =
    parsed_text(
      "{\"outcome\": \"CLEAR\", \"clearance\": \"CLEAR\"}",
      input.nothing(),
    )
  assert r.field == "outcome"
  // Without an order, the first in key order.
  let assert Error(r) =
    input.parse(
      input.nothing(),
      body([
        #("outcome", dynamic.string("CLEAR")),
        #("clearance", dynamic.string("CLEAR")),
      ]),
      "body",
      [],
    )
  assert r.field == "clearance"
}

pub fn a_nested_unknown_field_is_named_in_the_order_sent_test() {
  let party = {
    use id <- input.field("subjectId", input.required(input.id()))
    input.done(id)
  }
  let s = {
    use parties <- input.field(
      "parties",
      input.required(input.items(input.object(party), 6)),
    )
    input.done(parties)
  }
  let assert Error(r) =
    parsed_text(
      "{\"parties\": [{\"subjectId\": \"pl-1\", \"guardianConsent\": true, \"dob\": \"2000-01-01\"}]}",
      s,
    )
  assert r.field == "parties[0].guardianConsent"
  assert r.problem == input.UnknownField
}

pub fn entries_keep_the_order_sent_test() {
  let text = "{\"rules\": {\"FIFA-8.1\": 1, \"FIFA-11.1\": 2, \"ENG-6.3\": 3}}"
  let s = {
    use rules <- input.field(
      "rules",
      input.required(input.entries(input.text(40), input.whole_number(0, 9))),
    )
    input.done(rules)
  }
  let assert Ok(rules) = parsed_text(text, s)
  assert list.map(rules, fn(x) { x.0 }) == ["ENG-6.3", "FIFA-11.1", "FIFA-8.1"]
  let sent = key_order.keys(key_order.of(text), [key_order.Key("rules")])
  assert key_order.sort(rules, sent)
    == [#("FIFA-8.1", 1), #("FIFA-11.1", 2), #("ENG-6.3", 3)]
}

pub fn key_order_reads_nested_lists_and_escapes_test() {
  let order =
    key_order.of("{\"a\\u00e9\": [{\"y\": 1, \"x\": [2, 3]}], \"b\": null}")
  assert key_order.keys(order, []) == Some(["aé", "b"])
  assert key_order.keys(order, key_order.steps("aé[0]")) == Some(["y", "x"])
  assert key_order.of("not json") == key_order.Unknown
}

fn drawing_shape() -> input.Shape(List(#(String, dynamic.Dynamic))) {
  use d <- input.field(
    "d",
    input.required(
      input.record(input.text(40), input.anything())
      |> input.refine(fn(es) { list.length(es) <= 3 }, "has at most 3 keys"),
    ),
  )
  input.done(d)
}

pub fn a_record_reads_a_list_as_an_object_of_its_indexes_test() {
  let text = "{\"d\": [\"a\", {\"y\": 1, \"x\": 2}]}"
  let assert Ok(entries) = parsed_text(text, drawing_shape())
  let order = key_order.at(key_order.of(text), [key_order.Key("d")])
  assert json.to_string(key_order.object_json(entries, order))
    == "{\"0\":\"a\",\"1\":{\"y\":1,\"x\":2}}"
}

pub fn a_refined_value_is_refused_under_its_own_name_test() {
  let text = "{\"d\": {\"a\": 1, \"b\": 2, \"c\": 3, \"e\": 4}}"
  let assert Error(r) = parsed_text(text, drawing_shape())
  assert r.field == "d"
  assert r.problem == input.Invalid
  assert refusal_text(Error(r)) |> string.contains("d has at most 3 keys.")
}

pub fn an_object_is_written_back_as_javascript_orders_it_test() {
  let text =
    "{\"d\": {\"b\": 1.5, \"a\": [1, {\"z\": 2.0, \"y\": null}], \"3\": true, \"1\": \"x\"}}"
  let s = {
    use d <- input.field(
      "d",
      input.required(input.record(input.text(40), input.anything())),
    )
    input.done(d)
  }
  let assert Ok(entries) = parsed_text(text, s)
  let order = key_order.at(key_order.of(text), [key_order.Key("d")])
  assert json.to_string(key_order.object_json(entries, order))
    == "{\"1\":\"x\",\"3\":true,\"b\":1.5,\"a\":[1,{\"z\":2,\"y\":null}]}"
}

pub fn a_loose_shape_lets_fields_it_does_not_name_through_test() {
  let loose = {
    use email <- input.field("email", input.nullish(input.boolean()))
    input.loose(email)
  }
  assert input.parse(
      loose,
      body([#("email", dynamic.bool(True)), #("other", dynamic.int(1))]),
      "body",
      [],
    )
    == Ok(Some(True))
  // The fields it names are still judged.
  let assert Error(r) =
    input.parse(loose, body([#("email", dynamic.int(1))]), "body", [])
  assert r.field == "email"
}

pub fn a_list_over_its_limit_is_refused_as_valibot_words_it_test() {
  let ids = {
    use ids <- input.field("ids", input.nullish(input.items(input.id(), 1)))
    input.done(ids)
  }
  assert refusal_text(
      input.parse(
        ids,
        body([
          #("ids", dynamic.list([dynamic.string("a"), dynamic.string("b")])),
        ]),
        "body",
        [],
      ),
    )
    == "{\"error\":\"FIELD_INVALID\",\"field\":\"ids\",\"problem\":\"too_long\",\"message\":\"ids must be at most 1 items long.\",\"max\":1}"
}
