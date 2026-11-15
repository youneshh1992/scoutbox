import gleam/bit_array
import gleam/option.{None, Some}
import scoutbox/identity/mfa_routes
import scoutbox/identity/roles
import scoutbox/identity/totp
import scoutbox/platform/paging

// RFC 6238 appendix B, SHA-1, the last six digits of each eight-digit vector.
pub fn rfc_6238_vectors_test() {
  let secret = totp.b32encode(bit_array.from_string("12345678901234567890"))
  assert totp.totp(secret, 59_000) == "287082"
  assert totp.totp(secret, 1_111_111_109_000) == "081804"
  assert totp.totp(secret, 1_111_111_111_000) == "050471"
  assert totp.totp(secret, 1_234_567_890_000) == "005924"
  assert totp.totp(secret, 2_000_000_000_000) == "279037"
}

pub fn base32_round_trips_test() {
  let bytes = <<0, 1, 2, 250, 251, 252, 253, 254, 255, 7, 99>>
  assert totp.b32decode(totp.b32encode(bytes)) == bytes
  assert totp.b32encode(bit_array.from_string("foobar")) == "MZXW6YTBOI"
}

pub fn a_code_from_the_next_step_is_accepted_test() {
  let secret = totp.b32encode(<<1:size(160)>>)
  let now = 1_800_000_000_000
  assert totp.valid(secret, totp.totp(secret, now + 30_000), now)
  assert !totp.valid(secret, totp.totp(secret, now + 90_000), now)
}

pub fn the_lead_tier_test() {
  assert roles.is_lead_role("Head of Recruitment")
  assert roles.is_lead_role("club OWNER")
  assert !roles.is_lead_role("Senior Scout")
}

pub fn uri_component_matches_javascript_test() {
  assert mfa_routes.uri_component("Maria Keane") == "Maria%20Keane"
  assert mfa_routes.uri_component("Zoë O'Neil&co") == "Zo%C3%AB%20O'Neil%26co"
}

pub fn cursors_round_trip_and_junk_is_refused_test() {
  let cursor = paging.encode_cursor([paging.IntKey(42)])
  assert paging.read(paging.Query(None, Some(cursor)), [paging.IntKind])
    == Ok(paging.Page(50, Some([paging.IntKey(42)])))
  assert paging.read(paging.Query(None, Some("junk")), [paging.IntKind])
    == Error(paging.CursorInvalid)
  assert paging.read(paging.Query(Some("101"), None), [paging.IntKind])
    == Error(paging.LimitInvalid)
  assert paging.read(paging.Query(Some("1.5"), None), [paging.IntKind])
    == Error(paging.LimitInvalid)
}
