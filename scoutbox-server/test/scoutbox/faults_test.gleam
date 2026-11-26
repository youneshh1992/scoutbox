//// The fault layer. These are the checks the TypeScript server moved from the platform/contracts battery (§12) to
//// its scripts/testPlatformHelpers.mjs, made of this server's own layer, plus how its rules count. The production
//// boot's refusal of SCOUTBOX_FAULTS stays in the battery (§43), over HTTP.

import gleam/list
import scoutbox/platform/faults

pub fn rules_parse_test() {
  let assert Ok(rules) =
    faults.parse("delay:/org/players/*/trust:1500;unavailable:/org/rooms/*")
  assert list.length(rules) == 2
}

pub fn an_unknown_kind_is_refused_test() {
  let assert Error(_) = faults.parse("explode:/x")
}

/// A fault can never apply to every route by accident.
pub fn a_rule_needs_a_path_test() {
  let assert Error(_) = faults.parse("delay")
}

/// In production the layer is disabled and loads no rules, even when the variable is set.
pub fn production_is_inert_test() {
  let assert Ok(prod) = faults.start(False, "unavailable:/org/players")
  assert !faults.enabled(prod)
  assert faults.rules(prod) == []
  assert faults.for_path(prod, "/org/players") == faults.Pass
  assert !faults.should_fail(prod, "unit.sqlite_commit")
}

/// Development with no rules is enabled and a no-op.
pub fn development_without_rules_is_a_no_op_test() {
  let assert Ok(dev) = faults.start(True, "")
  assert faults.enabled(dev)
  assert faults.rules(dev) == []
  assert faults.for_path(dev, "/org/players") == faults.Pass
}

/// `*` matches exactly one segment, and only where it stands.
pub fn a_star_is_one_segment_test() {
  let assert Ok(dev) = faults.start(True, "unavailable:/org/players/*")
  let assert faults.Fail(status: 503, ..) =
    faults.for_path(dev, "/org/players/pl-1")
  assert faults.for_path(dev, "/org/players") == faults.Pass
  assert faults.for_path(dev, "/org/players/pl-1/notes") == faults.Pass
  assert faults.for_path(dev, "/org/rooms/pl-1") == faults.Pass
}

/// `retryable` fails its first N hits, then lets requests through; `internal:STEP:0` only counts.
pub fn hits_are_counted_test() {
  let assert Ok(dev) =
    faults.start(True, "retryable:/ok:2;internal:unit.after_commit:0")
  let assert faults.Fail(status: 503, ..) = faults.for_path(dev, "/ok")
  let assert faults.Fail(status: 503, ..) = faults.for_path(dev, "/ok")
  assert faults.for_path(dev, "/ok") == faults.Pass
  assert !faults.should_fail(dev, "unit.after_commit")
  assert !faults.should_fail(dev, "unit.after_commit")
  assert list.map(faults.rules(dev), fn(r) { r.hits }) == [3, 2]
}
