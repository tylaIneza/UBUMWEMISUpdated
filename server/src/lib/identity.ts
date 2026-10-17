/**
 * Identity document numbers. One number belongs to one person, so it is stored in a single
 * canonical form (no spaces or dashes, upper case) — "1 1990 8 0012345 6 78" and
 * "1199080012345678" are the same document and can never be registered twice.
 */
export type IdType = 'NATIONAL_ID' | 'PASSPORT' | 'OTHER';

export function normalizeIdNumber(value: string): string {
  return value.replace(/[\s\-./]/g, '').toUpperCase();
}

/**
 * Rwandan national ID (indangamuntu): 16 digits.
 *   digit 1      category: 1 = Rwandan citizen, 2 = refugee, 3 = foreign resident
 *   digits 2–5   year of birth
 *   digits 6–16  sequence and check digits
 * Returns a message describing the problem, or null if the number is acceptable.
 */
export function idNumberProblem(type: IdType, raw: string, now = new Date()): string | null {
  const id = normalizeIdNumber(raw);
  if (!id) return 'Enter the ID or passport number.';
  if (type === 'NATIONAL_ID') {
    if (!/^\d+$/.test(id)) return 'A Rwandan national ID number contains digits only.';
    if (id.length !== 16) return `A Rwandan national ID number has 16 digits; this one has ${id.length}.`;
    if (!['1', '2', '3'].includes(id[0]!)) return 'A Rwandan national ID number starts with 1, 2 or 3.';
    const year = Number(id.slice(1, 5));
    if (year < 1900 || year > now.getUTCFullYear()) return `Digits 2–5 of a Rwandan national ID are the year of birth; ${id.slice(1, 5)} is not a valid year.`;
    return null;
  }
  if (type === 'PASSPORT') {
    if (!/^[A-Z0-9]{6,20}$/.test(id)) return 'A passport number has 6 to 20 letters and digits.';
    return null;
  }
  if (!/^[A-Z0-9]{4,40}$/.test(id)) return 'Enter a document number of 4 to 40 letters and digits.';
  return null;
}

/** TIN (the 9-digit number on the RDB certificate / RRA registration), stored without spaces or dashes. */
export function normalizeTin(value: string): string {
  return value.replace(/[\s\-./]/g, '');
}

export function tinProblem(raw: string): string | null {
  const tin = normalizeTin(raw);
  if (!tin) return 'Enter the TIN number (from the RDB certificate).';
  if (!/^\d+$/.test(tin)) return 'A TIN number contains digits only.';
  if (tin.length !== 9) return `A TIN number has 9 digits; this one has ${tin.length}.`;
  return null;
}
