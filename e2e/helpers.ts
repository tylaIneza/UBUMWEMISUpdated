import { expect, type Page } from '@playwright/test';

export const PASSWORD = process.env.SEED_PASSWORD ?? 'Demo@Pass2026';

export async function signIn(page: Page, role: 'admin' | 'manager' | 'accountant' | 'cashier' | 'staff' | 'viewer') {
  await page.goto('/login');
  await page.getByLabel('E-mail address').fill(`${role}@demo.rw`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

/** "1,234,000 RWF" → 1234000 */
export const rwf = (text: string | null) => Number((text ?? '').replace(/[^\d.-]/g, ''));
