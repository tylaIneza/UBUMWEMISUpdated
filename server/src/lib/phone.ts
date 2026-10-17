/**
 * Phone numbers are stored in international (E.164) form, e.g. +250788123456, so the
 * same number is always written the same way and can be used directly for SMS.
 * Rwandan numbers can be typed the usual local way (078 812 3456); numbers from any
 * other country must start with + and the country code.
 */
export interface PhoneResult {
  e164: string | null;
  problem: string | null;
}

const RWANDA_HINT = 'Enter a Rwandan number such as 078 812 3456, or a foreign number starting with + and the country code (e.g. +256 772 123456).';

export function parsePhone(raw: string): PhoneResult {
  let v = raw.trim().replace(/[\s\-().]/g, '');
  if (!v) return { e164: null, problem: 'Enter a phone number.' };
  if (v.startsWith('00')) v = `+${v.slice(2)}`;
  if (/^07\d{8}$/.test(v)) v = `+250${v.slice(1)}`; // local Rwandan mobile: 07X XXX XXXX
  else if (/^2507\d{8}$/.test(v)) v = `+${v}`; // 250 7XX XXX XXX without the +
  if (!v.startsWith('+')) {
    if (/^\d+$/.test(v) && v.startsWith('0')) return { e164: null, problem: `A Rwandan mobile number has 10 digits and starts with 07 (072, 073, 078 or 079). ${RWANDA_HINT}` };
    return { e164: null, problem: RWANDA_HINT };
  }
  if (!/^\+\d+$/.test(v)) return { e164: null, problem: 'A phone number contains digits only (after the +).' };
  if (v.startsWith('+250')) {
    const rest = v.slice(4);
    // Mobile: MTN 078/079, Airtel 072/073. Landline: 0252… (9 digits after +250).
    if (/^7[2389]\d{7}$/.test(rest) || /^25\d{7}$/.test(rest)) return { e164: v, problem: null };
    if (/^7\d{8}$/.test(rest)) return { e164: null, problem: 'Rwandan mobile numbers start with 072, 073, 078 or 079.' };
    return { e164: null, problem: `A Rwandan number has 9 digits after +250; this one has ${rest.length}.` };
  }
  if (!/^\+[1-9]\d{7,14}$/.test(v)) return { e164: null, problem: 'An international number is + followed by the country code and 8 to 15 digits in total.' };
  return { e164: v, problem: null };
}

/** "+250788123456" → "+250 788 123 456" (display only). */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const m = /^\+250(\d{3})(\d{3})(\d{3})$/.exec(e164);
  return m ? `+250 ${m[1]} ${m[2]} ${m[3]}` : e164;
}

/** Digits to search a stored phone with, whichever way the user typed it ("0788 12", "+25078812"…). */
export function phoneSearchDigits(q: string): string | null {
  const digits = q.replace(/[\s\-().+]/g, '');
  if (!/^\d{4,}$/.test(digits)) return null;
  return digits.replace(/^250/, '').replace(/^0/, '');
}
