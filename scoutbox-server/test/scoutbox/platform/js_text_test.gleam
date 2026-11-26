//// `js_text.lower` against JavaScript's `toLowerCase` (Node 22), case by case.

import scoutbox/platform/js_text

pub fn lower_test() {
  assert js_text.lower("JOSÉ") == "josé"
  assert js_text.lower("İstanbul") == "i̇stanbul"
  assert js_text.lower("ǅ") == "ǆ"
  assert js_text.lower("ẞ") == "ß"
}

pub fn final_sigma_test() {
  assert js_text.lower("ΟΔΥΣΣΕΑΣ") == "οδυσσεας"
  assert js_text.lower("ΣΑΣ Σ") == "σας σ"
  assert js_text.lower("ΑΣ.") == "ας."
  assert js_text.lower("Σ") == "σ"
  assert js_text.lower("ΟΔΥΣΣΕΑΣ Παπαδόπουλος") == "οδυσσεας παπαδόπουλος"
}
