// A check that fails for a reason recorded in docs/known-issues.md.
//
// It still runs and is reported, but it does not fail the battery, so the rest of the battery can stay in CI.
// When it starts to pass, it fails the battery instead: remove the known-issues entry and turn it back into an
// ordinary check. Never use this to hide a new failure; add the entry first.
export function knownFailure(cond, msg, issue) {
  if (cond) {
    console.error(
      `✗ ${msg}: this known failure now passes; remove "${issue}" from docs/known-issues.md and make it an ordinary check`,
    );
    process.exitCode = 1;
  } else {
    console.log(`! known failure (docs/known-issues.md: ${issue}): ${msg}`);
  }
}
