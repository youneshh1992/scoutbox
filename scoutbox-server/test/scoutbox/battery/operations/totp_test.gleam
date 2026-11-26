//// Checks of the rules from the rules suites of operations/clubOperations, first generated from the TypeScript
//// server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import scoutbox/identity/totp

// clubOperations: b32encode — TOTP matches RFC 6238 vector at t=59s
pub fn totp_matches_rfc_6238_vector_at_t_59s_test() {
  assert totp.b32encode(<<
      49,
      50,
      51,
      52,
      53,
      54,
      55,
      56,
      57,
      48,
      49,
      50,
      51,
      52,
      53,
      54,
      55,
      56,
      57,
      48,
    >>)
    == "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
}

// clubOperations: totp — TOTP matches RFC 6238 vector at t=59s
pub fn totp_matches_rfc_6238_vector_at_t_59s_2_test() {
  assert totp.totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000) == "287082"
}

// clubOperations: totp — TOTP matches RFC 6238 vector at t=1111111109s
pub fn totp_matches_rfc_6238_vector_at_t_1111111109s_test() {
  assert totp.totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1_111_111_109_000)
    == "081804"
}

// clubOperations: totp — TOTP matches RFC 6238 vector at t=1234567890s
pub fn totp_matches_rfc_6238_vector_at_t_1234567890s_test() {
  assert totp.totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1_234_567_890_000)
    == "005924"
}

// clubOperations: totp — TOTP ±1 step drift window accepts an adjacent code
pub fn totp_1_step_drift_window_accepts_an_adjacent_code_test() {
  assert totp.totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1_000_000_000_000)
    == "864010"
}

// clubOperations: totpValid — TOTP ±1 step drift window accepts an adjacent code
pub fn totp_1_step_drift_window_accepts_an_adjacent_code_2_test() {
  assert totp.valid(
      "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      "864010",
      1_000_000_029_000,
    )
    == True
}

// clubOperations: totpValid — TOTP rejects a wrong code
pub fn totp_rejects_a_wrong_code_test() {
  assert totp.valid(
      "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      "000000",
      1_000_000_000_000,
    )
    == False
}
