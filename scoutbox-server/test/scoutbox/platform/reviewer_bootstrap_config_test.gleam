//// `config.reviewer_bootstrap_from`: what the bootstrap settings read as. The boots themselves, and the refusals,
//// are in the `platform/sessionsAndPorts` battery (R).

import gleam/list
import gleam/option.{None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/config.{ReviewerBootstrap}

fn from(settings: List(#(String, String))) {
  config.reviewer_bootstrap_from(fn(name) { list.key_find(settings, name) })
}

const id = #("TS_REVIEWER_BOOTSTRAP_ID", "tsr-root")

const secret = #("TS_REVIEWER_BOOTSTRAP_SECRET", "root-reviewer-secret")

pub fn unset_is_none_test() {
  assert from([]) == Ok(None)
  assert from([
      #("TS_REVIEWER_BOOTSTRAP_ID", ""),
      #("TS_REVIEWER_BOOTSTRAP_SECRET", ""),
    ])
    == Ok(None)
}

pub fn the_name_defaults_to_the_id_test() {
  assert from([id, secret])
    == Ok(
      Some(ReviewerBootstrap("tsr-root", "tsr-root", "root-reviewer-secret")),
    )
}

pub fn the_name_is_trimmed_test() {
  assert from([id, secret, #("TS_REVIEWER_BOOTSTRAP_NAME", "  Root Reviewer ")])
    == Ok(
      Some(ReviewerBootstrap(
        "tsr-root",
        "Root Reviewer",
        "root-reviewer-secret",
      )),
    )
}

pub fn the_limits_are_post_ts_reviewers_own_test() {
  let ok = fn(settings) { from(settings) |> result.is_ok }
  assert ok([#("TS_REVIEWER_BOOTSTRAP_ID", "abc"), secret])
  assert !ok([#("TS_REVIEWER_BOOTSTRAP_ID", "ab"), secret])
  assert ok([#("TS_REVIEWER_BOOTSTRAP_ID", string.repeat("a", 40)), secret])
  assert !ok([#("TS_REVIEWER_BOOTSTRAP_ID", string.repeat("a", 41)), secret])
  assert !ok([#("TS_REVIEWER_BOOTSTRAP_ID", "-root"), secret])
  assert ok([id, #("TS_REVIEWER_BOOTSTRAP_SECRET", string.repeat("s", 12))])
  assert !ok([id, #("TS_REVIEWER_BOOTSTRAP_SECRET", string.repeat("s", 11))])
  assert !ok([id, #("TS_REVIEWER_BOOTSTRAP_SECRET", string.repeat("s", 201))])
  assert ok([
    id,
    secret,
    #("TS_REVIEWER_BOOTSTRAP_NAME", string.repeat("n", 80)),
  ])
  assert !ok([
    id,
    secret,
    #("TS_REVIEWER_BOOTSTRAP_NAME", string.repeat("n", 81)),
  ])
  assert !ok([id, secret, #("TS_REVIEWER_BOOTSTRAP_NAME", "   ")])
}

pub fn a_half_set_bootstrap_is_an_error_test() {
  assert from([id]) |> result.is_error
  assert from([secret]) |> result.is_error
  assert from([#("TS_REVIEWER_BOOTSTRAP_NAME", "Root")]) |> result.is_error
}
