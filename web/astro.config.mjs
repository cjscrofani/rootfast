// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwind from '@astrojs/tailwind';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    platformProxy: { enabled: true },
  }),
  integrations: [
    tailwind({
      applyBaseStyles: false, // we ship our own base + reset in global.css
    }),
  ],
  vite: {
    ssr: {
      // Astro's Cloudflare adapter needs these handled at runtime, not bundled.
      external: ['node:async_hooks'],
    },
  },
});
