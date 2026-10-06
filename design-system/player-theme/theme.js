/* Player's approved dark theme is fixed, including for saved light preferences. */
(() => {
  const root = document.documentElement;
  root.dataset.theme = 'dark';
  root.classList.toggle('dark', true);
  root.classList.toggle('light', false);
  root.style.colorScheme = 'dark';
  window.ScoutBoxTheme = Object.freeze({ getPreference: () => 'dark' });
})();
