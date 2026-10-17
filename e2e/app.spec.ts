import { expect, test } from '@playwright/test';
import { rwf, signIn } from './helpers';

test('sign-in is required and wrong credentials are refused clearly', async ({ page }) => {
  await page.goto('/payments');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('E-mail or phone number').fill('manager@demo.rw');
  await page.getByLabel('Password', { exact: true }).fill('not-the-password');
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page.getByRole('alert')).toContainText('incorrect');
});

test('dashboard shows live figures, the demo banner and a working building filter', async ({ page }) => {
  await signIn(page, 'manager');
  await expect(page.getByText('DEMO DATA — sample records')).toBeVisible();
  const rooms = page.locator('.stat', { hasText: 'Rooms' }).first().locator('.v');
  const all = Number(await rooms.textContent());
  expect(all).toBeGreaterThan(50);
  await page.getByLabel('Property filter').selectOption({ label: 'UBUMWE HOUSE' });
  await expect(rooms).not.toHaveText(String(all));
  expect(Number(await rooms.textContent())).toBeLessThan(all);
  await expect(page.locator('.meter-row')).toHaveCount(1);
  // Room map: clicking a room opens its details.
  await page.locator('.room-chip.OCCUPIED').first().click();
  await expect(page.getByRole('dialog')).toContainText('Current tenant');
  await page.getByRole('button', { name: 'Open room page' }).click();
  await expect(page.getByRole('tab', { name: 'Rent Ledger' })).toBeVisible();
});

test('daily workflow: search tenant → record payment → overpayment is caught → confirm → receipt', async ({ page }) => {
  await signIn(page, 'cashier');
  await page.goto('/daily');
  // Pick someone who has not paid this month.
  await page.locator('section', { hasText: 'Who has not paid' }).locator('tbody tr').first().click();
  await expect(page.getByRole('heading', { name: 'Record payment' })).toBeVisible();
  const total = rwf(await page.locator('tfoot .num').first().textContent());
  expect(total).toBeGreaterThan(0);

  // More than is owed: the system refuses and explains.
  await page.getByLabel('Payment amount (RWF)').fill(String(total + 50000));
  await expect(page.getByRole('alert')).toContainText('Payment exceeds current outstanding balance by 50,000 RWF.');
  await expect(page.getByRole('button', { name: 'Review payment' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Record excess as advance payment' })).toBeDisabled(); // a cashier may not
  await page.getByRole('button', { name: /Apply only outstanding amount/ }).click();
  await expect(page.getByLabel('Payment amount (RWF)')).toHaveValue(String(total));

  // A partial payment, with the allocation shown before saving.
  await page.getByLabel('Payment amount (RWF)').fill('25000');
  await page.getByLabel('Payment method *').selectOption({ label: 'Cash' });
  await expect(page.getByText('How this payment will be applied')).toBeVisible();
  await page.getByRole('button', { name: 'Review payment' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm payment' })).toBeVisible();
  await expect(page.getByText('25,000 RWF').first()).toBeVisible();

  // Double-click CONFIRM: exactly one payment must result.
  await page.getByRole('button', { name: 'Confirm payment' }).dblclick();
  await expect(page.getByText('PAYMENT SUCCESSFUL')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Receipt REC-\d{4}-\d{6}/ })).toBeVisible();
  const receipt = (await page.getByRole('heading', { level: 1 }).textContent())!.replace('Receipt ', '').trim();
  await expect(page.getByRole('link', { name: 'Download PDF' })).toBeVisible();

  await page.goto('/payments');
  await page.getByLabel('Search', { exact: true }).fill(receipt);
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr')).toContainText('25,000 RWF');
});

test('occupied rooms cannot be chosen when assigning a tenant', async ({ page }) => {
  await signIn(page, 'manager');
  await page.goto('/tenants/new');
  await page.getByLabel('Full name').fill('E2E Test Tenant');
  await page.getByLabel('Phone number').fill('+250788555001');
  await page.getByLabel('ID / passport number').fill(`1199080${String(Date.now()).slice(-9)}`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Building').selectOption({ label: 'UBUMWE HOUSE' });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Floor').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Continue' }).click();
  // Every room is listed; an occupied one has no Select button.
  const occupied = page.locator('tbody tr', { hasText: 'Occupied' }).first();
  await expect(occupied).toContainText('Not available');
  await expect(occupied.getByRole('button', { name: 'Select' })).toHaveCount(0);
  // Continuing without a room is blocked with a clear message.
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toContainText('Select an available room');
});

test('reports: consolidated totals reconcile on screen and export to PDF and Excel', async ({ page }) => {
  await signIn(page, 'manager');
  await page.goto('/reports?type=consolidated');
  await page.getByRole('button', { name: 'Last month' }).click();
  await page.getByRole('button', { name: 'Generate report' }).click();
  const table = page.locator('section[aria-label="Financial summary by building"] table');
  await expect(table).toBeVisible();
  const rows = table.locator('tbody tr');
  let sum = 0;
  for (let i = 0; i < (await rows.count()); i += 1) sum += rwf(await rows.nth(i).locator('td').nth(1).textContent());
  expect(sum).toBeGreaterThan(0);
  expect(rwf(await table.locator('tfoot td').nth(1).textContent())).toBe(sum);
  await expect(page.getByText('Reconciliation warning')).toHaveCount(0);

  for (const [name, ext] of [['Export PDF', 'pdf'], ['Export Excel', 'xlsx']] as const) {
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name }).click();
    expect((await download).suggestedFilename()).toMatch(new RegExp(`^consolidated-.*\\.${ext}$`));
  }
});

test('a viewer sees dashboards and reports but no way to change anything', async ({ page }) => {
  await signIn(page, 'viewer');
  await expect(page.getByRole('link', { name: 'Record Payment' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0);
  await page.goto('/payments/new');
  await expect(page.getByText('You do not have access to this page')).toBeVisible();
  await page.goto('/rooms');
  await expect(page.getByRole('button', { name: 'Register room' })).toHaveCount(0);
  // Even a hand-made request is refused by the server.
  const status = await page.evaluate(async () => (await fetch('/api/v1/tenants', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
  expect(status).toBe(403);
});

test('an expense is recorded, approved, and appears in the building expense report', async ({ page }) => {
  await signIn(page, 'manager');
  await page.goto('/expenses');
  await page.getByRole('button', { name: 'Add expense' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Building').selectOption({ label: 'KIGALI HEIGHTS PLAZA' });
  await dialog.getByLabel('Category').selectOption({ label: 'Cleaning' });
  await dialog.getByLabel('Amount (RWF)').fill('12345');
  const description = `E2E cleaning ${Date.now()}`;
  await dialog.getByLabel('Description').fill(description);
  await dialog.getByRole('button', { name: 'Record expense' }).click();
  const row = page.locator('tbody tr', { hasText: description });
  await expect(row).toContainText('Awaiting approval');
  await row.getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('button', { name: 'Approve expense' }).click();
  await expect(row).toContainText('Approved');

  await page.goto('/reports?type=expenses');
  await page.getByLabel('Building').selectOption({ label: 'KIGALI HEIGHTS PLAZA' });
  await page.getByRole('button', { name: 'Generate report' }).click();
  await expect(page.locator('section[aria-label="Expense entries"]')).toContainText(description);
});
