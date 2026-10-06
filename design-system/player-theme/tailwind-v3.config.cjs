// Tailwind v3 alternative. Adjust content globs for your project.
module.exports = {
  content: ['./src/**/*.{html,js,jsx,ts,tsx}', './index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: { ui: ['var(--sb-font-ui)'] },
      colors: {
        scoutbox: 'var(--sb-green)', canvas: 'var(--sb-bg)',
        surface: 'var(--sb-surface)', ink: 'var(--sb-text)',
        muted: 'var(--sb-muted)', edge: 'var(--sb-border)',
        focus: 'var(--sb-focus)', 'action-ink': 'var(--sb-on-gradient)',
      },
      backgroundImage: { 'sb-action': 'var(--sb-control)', 'sb-progress': 'var(--sb-gradient)' },
    },
  },
};
