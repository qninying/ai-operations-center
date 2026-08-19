/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev-only proxy to mcp-server's real HTTP API (STORY-005). Deliberately not CORS
// headers on the backend — that would be a production security surface question for
// a server that will eventually serve real DMV data, worth its own decision later,
// not something to add casually here. This proxy has zero footprint in the built
// dist/ output; it only exists for `npm run dev`. Where the built frontend actually
// reaches the backend in a real deployment is an open question this walking
// skeleton doesn't answer yet — noted honestly, not silently assumed solved.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
  },
})
