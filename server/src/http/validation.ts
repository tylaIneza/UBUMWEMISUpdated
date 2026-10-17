import { z } from 'zod';
import { parseDate } from '../lib/dates.js';
import { Decimal } from '../lib/money.js';
import { parsePhone } from '../lib/phone.js';

export const zId = z.string().uuid('Invalid identifier.');

export const zDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD.')
  .transform((s, ctx) => {
    try {
      return parseDate(s);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'This is not a valid calendar date.' });
      return z.NEVER;
    }
  });

/** Accepts "150000", "150000.50" or a number; rejects negatives, exponents and more than 2 decimals. */
export const zMoney = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? String(v) : v.trim().replace(/,/g, '')))
  .refine((s) => /^\d{1,12}(\.\d{1,2})?$/.test(s), 'Enter a valid amount (no more than 2 decimals).')
  .transform((s) => new Decimal(s));

export const zPositiveMoney = zMoney.refine((d) => d.greaterThan(0), 'Amount must be greater than zero.');

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/** Optional text: trims, and treats "" as "not provided". */
export const zText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
/** Nullable text for PATCH bodies: "" clears the field. */
export const zTextNullable = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional());
export const zRequiredText = (max: number, label = 'This field') =>
  z.string({ error: `${label} is required.` }).trim().min(1, `${label} is required.`).max(max);
export const zOptionalId = z.preprocess(blankToUndefined, zId.optional());
export const zOptionalDate = z.preprocess(blankToUndefined, zDate.optional());
export const zOptionalMoney = z.preprocess(blankToUndefined, zMoney.optional());

/** Accepts Rwandan local numbers (078…) and international numbers (+…); always yields +E.164, e.g. +250788123456. */
export const zPhone = z.string({ error: 'Enter a phone number.' }).transform((v, ctx) => {
  const r = parsePhone(v);
  if (!r.e164) {
    ctx.addIssue({ code: 'custom', message: r.problem ?? 'Enter a valid phone number.' });
    return z.NEVER;
  }
  return r.e164;
});
export const zEmail = z.string().trim().toLowerCase().email('Enter a valid e-mail address.').max(160);

export const zPage = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.preprocess(blankToUndefined, z.string().trim().max(100).optional()),
  sort: z.preprocess(blankToUndefined, z.string().max(40).optional()),
  dir: z.enum(['asc', 'desc']).default('asc'),
});

export type PageQuery = z.infer<typeof zPage>;

export function paged<T>(items: T[], total: number, q: { page: number; pageSize: number }) {
  return { items, total, page: q.page, pageSize: q.pageSize, pages: Math.max(1, Math.ceil(total / q.pageSize)) };
}

export const skipTake = (q: { page: number; pageSize: number }) => ({ skip: (q.page - 1) * q.pageSize, take: q.pageSize });
