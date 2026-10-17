import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test('on a phone: search tenant → see balance → record payment → confirm → receipt', async ({ page }) => {
  await signIn(page, 'accountant');
  // No horizontal scrolling of the page itself.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  await page.getByRole('link', { name: 'Record Payment' }).click();
  await page.getByLabel(/Search by tenant name/).fill('Mug');
  await page.locator('tbody tr').first().click();
  await expect(page.getByText('Current outstanding')).toBeVisible();
  await page.getByLabel('Payment amount (RWF)').fill('10000');
  await page.getByLabel('Payment method *').selectOption({ label: 'Mobile Money' });
  // Mobile money needs its transaction reference.
  await expect(page.getByRole('button', { name: 'Review payment' })).toBeDisabled();
  await page.getByLabel(/Transaction reference/).fill(`E2E-MOMO-${Date.now()}`);
  const overpaid = await page.getByText(/exceeds current outstanding|no outstanding balance/).count();
  if (overpaid) await page.getByRole('button', { name: 'Record excess as advance payment' }).click();
  await page.getByRole('button', { name: 'Review payment' }).click();
  await page.getByRole('button', { name: 'Confirm payment' }).click();
  await expect(page.getByText('PAYMENT SUCCESSFUL')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print receipt' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  // The navigation menu opens from the menu button.
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('link', { name: 'Daily Operations' }).click();
  await expect(page.getByRole('heading', { name: 'Daily Operations' })).toBeVisible();
});
