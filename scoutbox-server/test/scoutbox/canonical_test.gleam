import gleeunit/should
import scoutbox/platform/canonical.{Array, Int, Null, Object, Str}

/// The expected text is what domains/platform/values.ts `canonicalJson` writes for the same value.
pub fn sorts_keys_and_escapes_as_typescript_does_test() {
  Object([
    #(
      "terms",
      Object([
        #("role", Str("CM")),
        #("offerType", Str("direct_recruitment")),
        #("startDate", Null),
      ]),
    ),
    #("recipientMessage", Str("Hé \"q\"")),
    #("expiresAt", Int(1_793_511_000_000)),
    #("documents", Array([Str("a"), Str("b")])),
  ])
  |> canonical.to_string
  |> should.equal(
    "{\"documents\":[\"a\",\"b\"],\"expiresAt\":1793511000000,\"recipientMessage\":\"Hé \\\"q\\\"\",\"terms\":{\"offerType\":\"direct_recruitment\",\"role\":\"CM\",\"startDate\":null}}",
  )
}
