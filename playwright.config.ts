import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests drive the real web app against the real API and the DEMO database
 * (run `npm run db:seed -- --reset` first). They record sample payments, so never point
 * them at a database with real data.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5173', channel: 'chrome', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1360, height: 900 } }, testIgnore: /mobile/ },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel: 'chrome' }, testMatch: /mobile/ },
  ],
  webServer: [
    { command: 'npm run dev:server', url: 'http://localhost:4000/health', reuseExistingServer: true, timeout: 60_000, env: { DISABLE_RATE_LIMIT: 'true' } },
    { command: 'npm run dev:web', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 60_000 },
  ],
});
