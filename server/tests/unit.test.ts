import { describe, expect, it } from 'vitest';
import { hashPassword, passwordProblem, verifyPassword } from '../src/auth/passwords.js';
import { zDate, zMoney } from '../src/http/validation.js';
import { addMonths, dayInMonth, daysBetween, endOfMonth, isoDate, monthsBetween, parseDate, periodLabel, startOfMonth } from '../src/lib/dates.js';
import { Decimal, formatMoney, sum } from '../src/lib/money.js';
import { billablePeriods, deriveStatus, dueDatesFor } from '../src/services/charges.js';
import { detectFileType } from '../src/services/documents.js';
import { formatCell } from '../src/services/exporters.js';

const D = (v: number | string) => new Decimal(v);
const date = parseDate;

describe('money', () => {
  it('adds decimals exactly (no floating point drift)', () => {
    expect(sum(['0.10', '0.20']).toFixed(2)).toBe('0.30');
    expect(sum([D('150000'), null, undefined, '50000.50']).toFixed(2)).toBe('200000.50');
  });
  it('formats RWF amounts with thousands separators', () => {
    expect(formatMoney(150000)).toBe('150,000 RWF');
    expect(formatMoney('1234567.5')).toBe('1,234,567.50 RWF');
    expect(formatMoney(D(-50000))).toBe('-50,000 RWF');
  });
  it('validates amounts strictly', () => {
    expect(zMoney.parse('150,000').toFixed(0)).toBe('150000');
    expect(zMoney.parse(200000).toFixed(0)).toBe('200000');
    for (const bad of ['-5', '1e5', '10.123', 'abc', '']) expect(zMoney.safeParse(bad).success, bad).toBe(false);
  });
});

describe('dates', () => {
  it('rejects impossible calendar dates', () => {
    expect(() => parseDate('2026-02-30')).toThrow();
    expect(zDate.safeParse('2026-13-01').success).toBe(false);
    expect(isoDate(zDate.parse('2028-02-29'))).toBe('2028-02-29');
  });
  it('does month arithmetic in UTC', () => {
    expect(isoDate(startOfMonth(date('2026-03-17')))).toBe('2026-03-01');
    expect(isoDate(endOfMonth(date('2026-02-10')))).toBe('2026-02-28');
    expect(isoDate(addMonths(date('2026-11-01'), 3))).toBe('2027-02-01');
    expect(monthsBetween(date('2026-01-15'), date('2026-04-02')).map(isoDate)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
    expect(daysBetween(date('2026-01-01'), date('2026-01-31'))).toBe(30);
    expect(periodLabel(date('2026-09-01'))).toBe('September 2026');
  });
  it('clamps the due day to the month length', () => {
    expect(isoDate(dayInMonth(date('2026-02-01'), 31))).toBe('2026-02-28');
    expect(isoDate(dayInMonth(date('2026-04-01'), 31))).toBe('2026-04-30');
  });
});

describe('rent charge rules', () => {
  const base = { amountDue: D(150000), amountWaived: D(0), overdueFrom: date('2026-03-10') };
  it('derives status from amounts and dates', () => {
    expect(deriveStatus({ ...base, amountPaid: D(0) }, date('2026-03-05'))).toBe('UNPAID');
    expect(deriveStatus({ ...base, amountPaid: D(0) }, date('2026-03-10'))).toBe('UNPAID');
    expect(deriveStatus({ ...base, amountPaid: D(0) }, date('2026-03-11'))).toBe('OVERDUE');
    expect(deriveStatus({ ...base, amountPaid: D(100000) }, date('2026-03-20'))).toBe('PARTIAL');
    expect(deriveStatus({ ...base, amountPaid: D(150000) }, date('2026-03-20'))).toBe('PAID');
    expect(deriveStatus({ ...base, amountPaid: D(0), amountWaived: D(150000) }, date('2026-03-20'))).toBe('WAIVED');
    expect(deriveStatus({ ...base, amountPaid: D(100000), amountWaived: D(50000) }, date('2026-03-20'))).toBe('PAID');
  });
  it('bills whole calendar months within the contract, stopping at move-out', () => {
    const c = { startDate: date('2026-01-15'), endDate: date('2026-12-31'), terminatedOn: null, billingStart: null };
    expect(billablePeriods(c, date('2026-03-02')).map(isoDate)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(billablePeriods({ ...c, terminatedOn: date('2026-02-10') }, date('2026-06-01')).map(isoDate)).toEqual(['2026-01-01', '2026-02-01']);
    expect(billablePeriods(c, date('2027-06-01'))).toHaveLength(12);
    expect(billablePeriods({ ...c, billingStart: date('2026-03-01') }, date('2026-04-20')).map(isoDate)).toEqual(['2026-03-01', '2026-04-01']);
    expect(billablePeriods({ ...c, startDate: date('2026-05-01') }, date('2026-03-01'))).toEqual([]);
  });
  it('never sets the first due date before the contract starts', () => {
    const c = { startDate: date('2026-01-15'), paymentDueDay: 5, graceDays: 5 };
    expect(isoDate(dueDatesFor(c, date('2026-01-01')).dueDate)).toBe('2026-01-15');
    expect(isoDate(dueDatesFor(c, date('2026-02-01')).dueDate)).toBe('2026-02-05');
    expect(isoDate(dueDatesFor(c, date('2026-02-01')).overdueFrom)).toBe('2026-02-10');
  });
});

describe('security helpers', () => {
  it('hashes passwords with a salt and verifies them', async () => {
    const a = await hashPassword('Correct-Horse-9');
    const b = await hashPassword('Correct-Horse-9');
    expect(a).not.toBe(b);
    expect(a).not.toContain('Correct-Horse-9');
    expect(await verifyPassword('Correct-Horse-9', a)).toBe(true);
    expect(await verifyPassword('correct-horse-9', a)).toBe(false);
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
  });
  it('enforces the password policy', () => {
    expect(passwordProblem('short1A')).toMatch(/at least 8/);
    expect(passwordProblem('alllowercase123')).toMatch(/uppercase/);
    expect(passwordProblem('GoodPassword123')).toBeNull();
  });
  it('checks uploaded file content, not just the extension', () => {
    expect(detectFileType('id.pdf', Buffer.from('%PDF-1.7 ...'))).toBe('application/pdf');
    expect(() => detectFileType('id.pdf', Buffer.from('<script>alert(1)</script>'))).toThrow(/does not match/);
    expect(() => detectFileType('malware.exe', Buffer.from('MZ'))).toThrow(/not allowed/);
    expect(() => detectFileType('page.html', Buffer.from('<html>'))).toThrow(/not allowed/);
  });
});

describe('report cell formatting', () => {
  it('formats each column type', () => {
    expect(formatCell(D(1250000), 'money', 'RWF')).toBe('1,250,000');
    expect(formatCell(0.8194, 'percent', 'RWF')).toBe('81.9%');
    expect(formatCell(null, 'percent', 'RWF')).toBe('—');
    expect(formatCell(date('2026-09-30'), 'date', 'RWF')).toBe('30 Sep 2026');
    expect(formatCell('IN_PROGRESS', 'status', 'RWF')).toBe('In progress');
  });
});

import { idNumberProblem, normalizeIdNumber } from '../src/lib/identity.js';

describe('identity numbers', () => {
  it('stores one canonical form so spacing cannot create a second registration', () => {
    expect(normalizeIdNumber(' 1 1990 8 0012345 6 78 ')).toBe('1199080012345678');
    expect(normalizeIdNumber('pc-123.456')).toBe('PC123456');
  });
  it('accepts well-formed Rwandan national IDs and explains what is wrong with others', () => {
    expect(idNumberProblem('NATIONAL_ID', '1199080012345678')).toBeNull();
    expect(idNumberProblem('NATIONAL_ID', '1 1990 8 0012345 6 78')).toBeNull();
    expect(idNumberProblem('NATIONAL_ID', '123567890')).toMatch(/16 digits; this one has 9/);
    expect(idNumberProblem('NATIONAL_ID', '119908001234567A')).toMatch(/digits only/);
    expect(idNumberProblem('NATIONAL_ID', '5199080012345678')).toMatch(/starts with 1, 2 or 3/);
    expect(idNumberProblem('NATIONAL_ID', '1309980012345678')).toMatch(/not a valid year/);
    expect(idNumberProblem('NATIONAL_ID', '1299980012345678', new Date('2026-10-03'))).toMatch(/not a valid year/);
  });
  it('checks passports separately', () => {
    expect(idNumberProblem('PASSPORT', 'PC123456')).toBeNull();
    expect(idNumberProblem('PASSPORT', 'P1')).toMatch(/6 to 20/);
  });
});

import { formatPhone, parsePhone, phoneSearchDigits } from '../src/lib/phone.js';

describe('phone numbers', () => {
  it('accepts Rwandan numbers typed the usual ways and stores them as +250…', () => {
    for (const v of ['0788123456', '078 812 3456', '0788-123-456', '250788123456', '+250 788 123 456', '00250788123456']) {
      expect(parsePhone(v).e164, v).toBe('+250788123456');
    }
    expect(parsePhone('0722123456').e164).toBe('+250722123456'); // Airtel
    expect(parsePhone('0252123456').problem).toMatch(/starts with 07/); // landline written locally
    expect(parsePhone('+250252123456').e164).toBe('+250252123456');
  });
  it('rejects malformed Rwandan numbers with a clear reason', () => {
    expect(parsePhone('078812345').problem).toMatch(/10 digits/);
    expect(parsePhone('+250758123456').problem).toMatch(/072, 073, 078 or 079/);
    expect(parsePhone('2345345678').problem).toMatch(/Rwandan number such as/);
    expect(parsePhone('3456789').problem).toMatch(/Rwandan number such as/);
    expect(parsePhone('').problem).toMatch(/Enter a phone/);
  });
  it('accepts numbers from any other country when written with + and the country code', () => {
    expect(parsePhone('+256 772 123456').e164).toBe('+256772123456');
    expect(parsePhone('+1 (415) 555-0100').e164).toBe('+14155550100');
    expect(parsePhone('+12').problem).toMatch(/8 to 15 digits/);
  });
  it('formats and searches', () => {
    expect(formatPhone('+250788123456')).toBe('+250 788 123 456');
    expect(phoneSearchDigits('0788 123')).toBe('788123');
    expect(phoneSearchDigits('+250788')).toBe('788');
    expect(phoneSearchDigits('Aline')).toBeNull();
  });
});
