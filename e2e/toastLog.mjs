/**
 * M23 P5.6E repair pass — the toast recorder.
 *
 * WHY THIS EXISTS.
 *
 * Every ScoutBox client shows a transient toast for **3,500 ms** and then removes
 * it from the DOM (`App.tsx`: `setTimeout(() => setToast(null), 3500)` in the
 * agent, club, grassroots and admin apps alike). A live test that asserts on a
 * toast by polling `body.innerText` every 250 ms is therefore asserting on a
 * window that closes by itself: when the machine is starved — four Chromium
 * instances competing for CPU is enough — two consecutive polls can land either
 * side of the whole 3.5-second lifetime and the assertion fails on a toast that
 * really did render.
 *
 * That is exactly the m23AgentLive B16 failure observed in the P5.6E
 * verification battery: a test-only race on transient UI, not a product race.
 *
 * THE FIX, AND WHY IT IS NOT A SLEEP.
 *
 * Record each toast as the browser renders it, instead of sampling for it. A
 * MutationObserver installed **before the page script runs** appends every
 * `.toast` element's text to `window.__toastLog`. The log is append-only and
 * lives as long as the document, so a slow poll cannot lose an entry: the
 * assertion reads real observable product state — a toast element that actually
 * appeared in the DOM — with the timing dependency removed rather than padded.
 *
 * Install it on the CONTEXT, not the page: `addInitScript` on a context applies
 * to every page opened in it and is registered before any page exists, so there
 * is no window in which a `goto` could outrun the installation.
 */

/** Registered on the browser context; runs in the page before any app code. */
const RECORDER = () => {
  // A page may be re-navigated; keep one log per document.
  window.__toastLog = [];
  const seen = new WeakSet();
  const scan = () => {
    for (const el of document.querySelectorAll('.toast')) {
      if (seen.has(el)) continue;
      seen.add(el);
      window.__toastLog.push(el.textContent || '');
    }
  };
  const start = () => {
    scan();
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
};

/**
 * Wrap `browser.newContext` so every context records toasts. Returns a function
 * with the same signature, so a suite changes `browser.newContext(` to
 * `newContext(` and nothing else.
 */
export function toastRecordingContexts(browser) {
  return async (options) => {
    const ctx = await browser.newContext(options);
    await ctx.addInitScript(RECORDER);
    return ctx;
  };
}

/**
 * Wait for a toast matching `re` to have been recorded. Polls the append-only
 * log, so it reports a toast that appeared and vanished before the first poll.
 */
export async function waitToast(page, re, ms = 20000) {
  for (let i = 0; i < Math.ceil(ms / 200); i++) {
    const log = await page.evaluate(() => window.__toastLog ?? []).catch(() => []);
    if (log.some((t) => re.test(t))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Every toast this document has shown, for a sweep or a diagnostic. */
export const toastLog = (page) => page.evaluate(() => window.__toastLog ?? []).catch(() => []);
