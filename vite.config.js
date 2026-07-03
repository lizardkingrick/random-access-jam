import { defineConfig } from 'vite';

// PWA plugin is added in the polish milestone; keep the base config minimal.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
  },
});
