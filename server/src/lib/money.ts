import { Prisma } from '../generated/prisma/client.js';

/** All money is handled as exact decimals. Never use JS numbers for arithmetic on amounts. */
export type Money = Prisma.Decimal;
export const Decimal = Prisma.Decimal;

export type MoneyValue = string | number | Prisma.Decimal;

export const ZERO = new Prisma.Decimal(0);

export function money(value: MoneyValue | null | undefined): Money {
  if (value === null || value === undefined) return ZERO;
  return new Prisma.Decimal(value);
}

export function sum(values: Array<MoneyValue | null | undefined>): Money {
  return values.reduce<Money>((acc, v) => acc.plus(money(v)), ZERO);
}

export function minMoney(a: Money, b: Money): Money {
  return a.lessThan(b) ? a : b;
}

/** "150,000 RWF" — for server-generated text (messages, receipts, PDFs). */
export function formatMoney(value: MoneyValue | null | undefined, currency = 'RWF'): string {
  const d = money(value);
  const fixed = d.decimalPlaces() > 0 ? d.toFixed(2) : d.toFixed(0);
  const [int = '0', frac] = fixed.split('.');
  const sign = int.startsWith('-') ? '-' : '';
  const grouped = int.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${frac ? `.${frac}` : ''} ${currency}`;
}
