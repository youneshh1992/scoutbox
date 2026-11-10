/**
 * Runs a side effect of an act that has already committed (a broadcast, a notification). Its failure is logged, not
 * thrown: the act stands, and the caller has already answered for it.
 */
export const sideEffectRunner = (tag) => (label, fn) => {
  try {
    return fn();
  } catch (e) {
    console.error(`${tag} side_effect_failed ${label}: ${e?.message ?? e}`);
    return undefined;
  }
};
