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

type IsDirty = () => boolean;

const guards = new Set<IsDirty>();
let lastHash = typeof window !== 'undefined' ? window.location.hash : '';
let restoring = false;

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
 * Install the window-level hooks once: `beforeunload` for close/reload, and a
 * hash watcher that reverses a navigation the person declined. The hash
 * watcher runs BEFORE the app's own hashchange handler (registration order),
 * and restores the previous hash with replaceState so the app's handler then
 * sees no change worth acting on.
 */
export function installDirtyGuard(message: () => string) {
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!anyDirty()) return;
    e.preventDefault();
    // Modern browsers ignore custom text; setting returnValue is what
    // actually triggers the prompt.
    e.returnValue = '';
  };
  const onHash = () => {
    if (restoring) { restoring = false; return; }
    const next = window.location.hash;
    if (next === lastHash) return;
    if (anyDirty() && !window.confirm(message())) {
      restoring = true;
      try { window.history.replaceState(null, '', lastHash); } catch { /* sandboxed */ }
      // Some hosts do not fire hashchange for replaceState; make sure the
      // "restoring" latch cannot swallow the NEXT genuine change.
      setTimeout(() => { restoring = false; }, 0);
      return;
    }
    lastHash = next;
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('hashchange', onHash);
  return () => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('hashchange', onHash);
  };
}

/** Keep the remembered hash in step with programmatic navigation. */
export function noteNavigated() { lastHash = window.location.hash; }
