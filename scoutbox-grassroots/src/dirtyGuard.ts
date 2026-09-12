// M18.2 — unsaved-change protection.
//
// A form that has been edited and not saved registers itself here. Every way
// of leaving the page — the sidebar, a hash change, the browser Back button,
// a tab close or reload — asks this registry first. Nothing is ever blocked
// by a form that is NOT dirty: a guard that fires on a clean form trains
// people to click through it, and then it protects nobody.
//
// The registry holds functions rather than flags so the form's own state is
// the single source of truth: "dirty" is whatever the form says it is at the
// moment someone tries to leave.
//
// Why the hash decision lives in the app's own handler (guardHashChange) and
// not in a second window listener: React may render synchronously inside the
// first hashchange listener, unmounting the dirty form before a later
// listener gets to ask it anything. The M18.2 live suite (J3) caught exactly
// that — a second listener saw zero registered forms and let a dirty form go.
// One handler, one decision, before any state changes.

type IsDirty = () => boolean;

const guards = new Set<IsDirty>();
let lastHash = typeof window !== 'undefined' ? window.location.hash : '';

export function registerDirtyGuard(isDirty: IsDirty): () => void {
  guards.add(isDirty);
  return () => { guards.delete(isDirty); };
}

export const anyDirty = () => [...guards].some((f) => { try { return f(); } catch { return false; } });

/**
 * Ask before leaving. Returns true when navigation may proceed. The browser's
 * own confirm is used on purpose: it is modal, keyboard-operable, announced by
 * screen readers, and cannot be missed under a toast.
 */
export function confirmLeave(message: string): boolean {
  if (!anyDirty()) return true;
  return window.confirm(message);
}

/**
 * The app's hashchange/popstate handler calls this FIRST. Returns true when
 * the navigation may proceed. When the person declines, the previous hash is
 * restored with replaceState (which fires no hashchange) and false is
 * returned, so the caller changes nothing. A second call for the same event
 * (hashchange and popstate both fire on Back) sees no change and returns true
 * — the caller then re-applies the state it is already in.
 */
export function guardHashChange(message: () => string): boolean {
  const next = window.location.hash;
  if (next === lastHash) return true;
  if (anyDirty() && !window.confirm(message())) {
    try { window.history.replaceState(null, '', lastHash || '#/'); } catch { /* sandboxed */ }
    return false;
  }
  lastHash = next;
  return true;
}

/** Install the window-level hook for close and reload. Returns the uninstaller. */
export function installDirtyGuard() {
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!anyDirty()) return;
    e.preventDefault();
    // Modern browsers ignore custom text; setting returnValue is what
    // actually triggers the prompt.
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  return () => { window.removeEventListener('beforeunload', onBeforeUnload); };
}

/** Keep the remembered hash in step with programmatic (pushState/replaceState) navigation. */
export function noteNavigated() { lastHash = window.location.hash; }
