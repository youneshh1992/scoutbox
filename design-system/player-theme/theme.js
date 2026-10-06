/* Load in <head> before CSS, without defer, to avoid an incorrect first frame.
   Explicit preference: light/dark. Missing preference follows the OS. */
(() => {
  const key = 'sb-theme:player';
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { const saved = localStorage.getItem(key); if (saved === 'light' || saved === 'dark') preference = saved; } catch {}
  const apply = () => {
    const scheme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    root.dataset.theme = scheme;
    root.classList.toggle('dark', scheme === 'dark');
    root.classList.toggle('light', scheme === 'light');
    root.style.colorScheme = scheme;
  };
  window.ScoutBoxTheme = Object.freeze({
    set(value) {
      if (!['light', 'dark', 'system'].includes(value)) throw new TypeError('Expected light, dark or system');
      preference = value;
      try { value === 'system' ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {}
      apply();
    },
    getPreference: () => preference,
  });
  media.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    preference = event.newValue === 'light' || event.newValue === 'dark' ? event.newValue : 'system';
    apply();
  });
  apply();
})();
