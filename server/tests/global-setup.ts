import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Brings the test database schema up to date (also proves the migrations apply cleanly). */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL!;
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
}
