// The checks a rules suite (scripts/rules/<domain>/<battery>.mjs) makes: a battery's checks of the server's own rules,
// moved out of the battery because they call the rules in this process rather than over HTTP. They keep the
// battery's wording: `ok(condition, message)`, `neg(condition, message)` for a refusal or an absence, `section(name)`.
//
//   const { ok, neg, section, done } = rulesSuite('platform/storeGuarantees');
//   …
//   done();   prints the count and sets the exit code
//
// Every assertion goes through this module, so a tool can follow each one back to the rule calls it checks.

/** The assertion helpers for the rules suite of `battery`. */
export function rulesSuite(battery) {
  let passed = 0;
  let negatives = 0;
  let failed = 0;
  const ok = (condition, message) => {
    if (condition) {
      passed++;
      console.log(`✓ ${message}`);
    } else {
      failed++;
      console.error(`✗ ${message}`);
      process.exitCode = 1;
    }
  };
  const neg = (condition, message) => {
    negatives++;
    ok(condition, `[neg] ${message}`);
  };
  const section = (name) => console.log(`\n— ${name} —`);
  const done = () => {
    console.log(`\n${battery} rules: ${passed} checks passed, ${negatives} negative, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  };
  return { ok, neg, section, done };
}
