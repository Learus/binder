import { defineConfig } from 'vite';
import { apiPlugin } from './server/api.ts';

export default defineConfig({
  plugins: [apiPlugin()],
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 5173 },
  // three.js alone is ~700 kB; one chunk is fine for a local app.
  build: { chunkSizeWarningLimit: 1500 },
});
