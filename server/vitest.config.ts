import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const envFile = resolve(import.meta.dirname, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('TEST_DATABASE_URL is not set. Tests need their own database (see .env.example).');
// Tests wipe the database they run against. Never let that be anything but a dedicated test database.
if (!/_test(\?|$)/.test(new URL(testUrl).pathname)) throw new Error('TEST_DATABASE_URL must point at a database whose name ends in "_test".');

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    // All files share one database, so they run one after another.
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      // Tests must never send real e-mail or SMS, whatever the developer's .env contains.
      SMTP_HOST: '', SMTP_FROM: '', SMTP_USER: '', SMTP_PASS: '', SMS_PROVIDER: '', SMS_API_KEY: '', SMS_USERNAME: '',
      NODE_ENV: 'test', DATABASE_URL: testUrl, DISABLE_SCHEDULER: 'true', DISABLE_RATE_LIMIT: 'true',
      SESSION_SECRET: process.env.SESSION_SECRET ?? 'test-secret-test-secret-test-secret-0000', STORAGE_DIR: resolve(import.meta.dirname, '../.test-storage'),
    },
  },
});
