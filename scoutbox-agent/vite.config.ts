import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The shared design system imports React from outside this app's root; resolve it here.
  resolve: { dedupe: ['react', 'react-dom'] },
  // M24A — the shared design system (../design-system) sits outside this app's
  // root, so the dev server must be allowed to serve its font files; the
  // self-contained demo bundle inlines them (there is no /assets beside a
  // single HTML file), the normal build emits them as hashed assets.
  server: { port: 5176, fs: { allow: ['..'] } },
  build: { assetsInlineLimit: process.env.VITE_DEMO === '1' ? 400 * 1024 : 4096 },
});
