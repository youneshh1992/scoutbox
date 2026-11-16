//// Stored JSON text comes back as the same JSON, keys in the order they were written.

import gleam/json
import scoutbox/platform/json_text

fn round(text: String) -> String {
  let assert Ok(j) = json_text.parse(text)
  json.to_string(j)
}

pub fn keys_keep_the_order_they_were_written_in_test() {
  assert round("{\"to\":\"shortlisted\",\"from\":\"watching\",\"a\":1}")
    == "{\"to\":\"shortlisted\",\"from\":\"watching\",\"a\":1}"
}

pub fn nested_values_and_whitespace_test() {
  assert round(" { \"x\" : [ 1 , true , null , { } , [ ] ] , \"y\" : -2.5 } ")
    == "{\"x\":[1,true,null,{},[]],\"y\":-2.5}"
}

pub fn escapes_and_unicode_test() {
  assert round("[\"a\\\"b\\\\c\\n\\u00e9\\ud83d\\ude00—\"]")
    == "[\"a\\\"b\\\\c\\né😀—\"]"
}

pub fn an_exponent_without_a_fraction_test() {
  let assert Ok(j) = json_text.parse("1e3")
  assert json.to_string(j) == json.to_string(json.float(1000.0))
}

pub fn malformed_text_is_refused_test() {
  assert json_text.parse("{\"a\":}") == Error(Nil)
  assert json_text.parse("[1,]") == Error(Nil)
  assert json_text.parse("{} x") == Error(Nil)
  assert json_text.parse("\"open") == Error(Nil)
}
