import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  server: { host: '0.0.0.0', port: 3000 },
  vite: {
    ssr: {
      noExternal: ['framer-motion'],
      external: ['better-sqlite3', '@node-rs/bcrypt', 'sharp', 'busboy', 'exifr'],
    },
    optimizeDeps: {
      exclude: ['better-sqlite3', '@node-rs/bcrypt', 'sharp'],
    },
  },
});
