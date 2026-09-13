import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://example.com',
  output: 'static',
  vite: {
    optimizeDeps: {
      exclude: ['maplibre-gl'],
    },
  },
});
