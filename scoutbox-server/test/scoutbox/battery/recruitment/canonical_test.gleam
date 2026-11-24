//// Checks of the rules from the rules suites of recruitment/signings, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import scoutbox/platform/canonical

// signings: payloadFingerprint — A11 the fingerprint is deep and canonical
pub fn a11_the_fingerprint_is_deep_and_canonical_test() {
  assert canonical.to_string(
      canonical.Object([
        #(
          "contract",
          canonical.Object([
            #("startDate", canonical.Str("2027-07-01")),
            #("endDate", canonical.Null),
          ]),
        ),
      ]),
    )
    == "{\"contract\":{\"endDate\":null,\"startDate\":\"2027-07-01\"}}"
}

// signings: payloadFingerprint — A11 the fingerprint is deep and canonical
pub fn a11_the_fingerprint_is_deep_and_canonical_2_test() {
  assert canonical.to_string(
      canonical.Object([
        #(
          "contract",
          canonical.Object([
            #("startDate", canonical.Str("2027-07-02")),
            #("endDate", canonical.Null),
          ]),
        ),
      ]),
    )
    == "{\"contract\":{\"endDate\":null,\"startDate\":\"2027-07-02\"}}"
}

// signings: payloadFingerprint — A11 the fingerprint is deep and canonical
pub fn a11_the_fingerprint_is_deep_and_canonical_3_test() {
  assert canonical.to_string(
      canonical.Object([
        #(
          "a",
          canonical.Object([#("b", canonical.Int(1)), #("c", canonical.Int(2))]),
        ),
      ]),
    )
    == "{\"a\":{\"b\":1,\"c\":2}}"
}

// signings: payloadFingerprint — A11 the fingerprint is deep and canonical
pub fn a11_the_fingerprint_is_deep_and_canonical_4_test() {
  assert canonical.to_string(
      canonical.Object([
        #(
          "a",
          canonical.Object([#("c", canonical.Int(2)), #("b", canonical.Int(1))]),
        ),
      ]),
    )
    == "{\"a\":{\"b\":1,\"c\":2}}"
}
