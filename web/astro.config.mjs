// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwind from '@astrojs/tailwind';

// https://astro.build/config
export default defineConfig({
  site: 'https://rootfast.org',
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
    // Stamped into the rendered-page cache key (src/middleware.ts) so pages
    // cached by one deployment are never served by the next: their HTML links
    // content-hashed CSS/JS that only exists in the build that produced it.
    define: {
      __BUILD_ID__: JSON.stringify(String(Date.now())),
    },
    ssr: {
      // Astro's Cloudflare adapter needs these handled at runtime, not bundled.
      external: ['node:async_hooks'],
    },
  },
});
