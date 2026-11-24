//// Checks of the rules from the rules suites of recruitment/contacts, recruitment/decisions, recruitment/offers,
//// recruitment/trials, first generated from the TypeScript server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/option.{None, Some}
import scoutbox/battery/base
import scoutbox/platform/idempotency

// contacts: normaliseClientKey — [neg] a client key must be short text
pub fn neg_a_client_key_must_be_short_text_test() {
  assert idempotency.client_key(Some(base.body("42")))
    == Error("clientKey must be text.")
}

// contacts: normaliseClientKey — [neg] a client key must be short text
pub fn neg_a_client_key_must_be_short_text_2_test() {
  assert idempotency.client_key(
      Some(base.body(
        "\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"",
      )),
    )
    == Error("clientKey must be 1–64 characters.")
}

// contacts: normaliseClientKey — absent is no key; whitespace is trimmed
pub fn absent_is_no_key_whitespace_is_trimmed_test() {
  assert idempotency.client_key(None) == Ok(None)
}

// contacts: normaliseClientKey — absent is no key; whitespace is trimmed
pub fn absent_is_no_key_whitespace_is_trimmed_2_test() {
  assert idempotency.client_key(Some(base.body("\" k1 \""))) == Ok(Some("k1"))
}

// decisions: normaliseDecisionClientKey — [neg] U22 client key "xxxxxxxxxxxxxxxxxxx refused in the Decision vocabulary
pub fn neg_u22_client_key_xxxxxxxxxxxxxxxxxxx_refused_in_the_decision_vocabular_test() {
  assert idempotency.client_key(
      Some(base.body(
        "\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"",
      )),
    )
    == Error("clientKey must be 1–64 characters.")
}

// decisions: normaliseDecisionClientKey — [neg] U22 client key 1 refused in the Decision vocabulary
pub fn neg_u22_client_key_1_refused_in_the_decision_vocabulary_test() {
  assert idempotency.client_key(Some(base.body("1")))
    == Error("clientKey must be text.")
}

// decisions: normaliseDecisionClientKey — [neg] U22 client key {} refused in the Decision vocabulary
pub fn neg_u22_client_key_refused_in_the_decision_vocabulary_test() {
  assert idempotency.client_key(Some(base.body("{}")))
    == Error("clientKey must be text.")
}

// decisions: normaliseDecisionClientKey — [neg] U22 client key [] refused in the Decision vocabulary
pub fn neg_u22_client_key_refused_in_the_decision_vocabulary_2_test() {
  assert idempotency.client_key(Some(base.body("[]")))
    == Error("clientKey must be text.")
}

// decisions: normaliseDecisionClientKey — [neg] U22 client key true refused in the Decision vocabulary
pub fn neg_u22_client_key_true_refused_in_the_decision_vocabulary_test() {
  assert idempotency.client_key(Some(base.body("true")))
    == Error("clientKey must be text.")
}

// decisions: normaliseDecisionClientKey — U22b a key is optional and kept as given
pub fn u22b_a_key_is_optional_and_kept_as_given_test() {
  assert idempotency.client_key(None) == Ok(None)
}

// decisions: normaliseDecisionClientKey — U22b a key is optional and kept as given
pub fn u22b_a_key_is_optional_and_kept_as_given_2_test() {
  assert idempotency.client_key(Some(base.body("\"k-1\""))) == Ok(Some("k-1"))
}

// offers: normaliseOfferClientKey — [neg] A30 clientKey "xxxxxxxxxxxxxxx refused
pub fn neg_a30_clientkey_xxxxxxxxxxxxxxx_refused_test() {
  assert idempotency.client_key(
      Some(base.body(
        "\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"",
      )),
    )
    == Error("clientKey must be 1–64 characters.")
}

// offers: normaliseOfferClientKey — [neg] A30 clientKey 1 refused
pub fn neg_a30_clientkey_1_refused_test() {
  assert idempotency.client_key(Some(base.body("1")))
    == Error("clientKey must be text.")
}

// offers: normaliseOfferClientKey — [neg] A30 clientKey {} refused
pub fn neg_a30_clientkey_refused_test() {
  assert idempotency.client_key(Some(base.body("{}")))
    == Error("clientKey must be text.")
}

// offers: normaliseOfferClientKey — [neg] A30 clientKey [] refused
pub fn neg_a30_clientkey_refused_2_test() {
  assert idempotency.client_key(Some(base.body("[]")))
    == Error("clientKey must be text.")
}

// offers: normaliseOfferClientKey — [neg] A30 clientKey true refused
pub fn neg_a30_clientkey_true_refused_test() {
  assert idempotency.client_key(Some(base.body("true")))
    == Error("clientKey must be text.")
}

// offers: normaliseOfferClientKey — A30b a key is optional and trimmed
pub fn a30b_a_key_is_optional_and_trimmed_test() {
  assert idempotency.client_key(None) == Ok(None)
}

// offers: normaliseOfferClientKey — A30b a key is optional and trimmed
pub fn a30b_a_key_is_optional_and_trimmed_2_test() {
  assert idempotency.client_key(Some(base.body("\" k \""))) == Ok(Some("k"))
}

// trials: normaliseTrialClientKey — U56 a client key is optional
pub fn u56_a_client_key_is_optional_test() {
  assert idempotency.client_key(None) == Ok(None)
}

// trials: normaliseTrialClientKey — U56 a client key is optional
pub fn u56_a_client_key_is_optional_2_test() {
  assert idempotency.client_key(Some(base.body("\"k-1\""))) == Ok(Some("k-1"))
}

// trials: normaliseTrialClientKey — [neg] U56b too long, numeric, object or list keys are refused (an empty string is simply no key)
pub fn neg_u56b_too_long_numeric_object_or_list_keys_are_refused_an_empty_strin_test() {
  assert idempotency.client_key(
      Some(base.body(
        "\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"",
      )),
    )
    == Error("clientKey must be 1–64 characters.")
}

// trials: normaliseTrialClientKey — [neg] U56b too long, numeric, object or list keys are refused (an empty string is simply no key)
pub fn neg_u56b_too_long_numeric_object_or_list_keys_are_refused_an_empty_strin_2_test() {
  assert idempotency.client_key(Some(base.body("12")))
    == Error("clientKey must be text.")
}

// trials: normaliseTrialClientKey — [neg] U56b too long, numeric, object or list keys are refused (an empty string is simply no key)
pub fn neg_u56b_too_long_numeric_object_or_list_keys_are_refused_an_empty_strin_3_test() {
  assert idempotency.client_key(Some(base.body("{}")))
    == Error("clientKey must be text.")
}

// trials: normaliseTrialClientKey — [neg] U56b too long, numeric, object or list keys are refused (an empty string is simply no key)
pub fn neg_u56b_too_long_numeric_object_or_list_keys_are_refused_an_empty_strin_4_test() {
  assert idempotency.client_key(Some(base.body("[]")))
    == Error("clientKey must be text.")
}
