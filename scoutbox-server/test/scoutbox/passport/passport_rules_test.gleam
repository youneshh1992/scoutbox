//// The Passport rules' calls the recorder can't keep (scripts/rules/passport/passport.mjs in the TypeScript tree):
//// a share secret is random, and an absent date is not a value `when_of` can be given.

import gleam/list
import gleam/option.{None}
import gleam/string
import scoutbox/passport/passport_rules

/// U3: "share secrets are high-entropy url-safe strings (24 random bytes)".
pub fn share_secrets_are_high_entropy_url_safe_strings_test() {
  let s1 = passport_rules.mint_share_secret()
  let s2 = passport_rules.mint_share_secret()
  assert string.length(s1) >= 32
  assert s1 != s2
  let url_safe =
    string.to_graphemes(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
    )
  assert list.all(string.to_graphemes(s1), list.contains(url_safe, _))
  // Only the hash is stored: it is the 64 hex digits the schema requires.
  assert string.length(passport_rules.sha256(s1)) == 64
}

/// U1: `normWhen(null) === null`. An absent date never reaches `when_of`; the sources pass it over.
pub fn an_absent_date_is_no_date_test() {
  assert option.then(None, passport_rules.when_of) == None
}
