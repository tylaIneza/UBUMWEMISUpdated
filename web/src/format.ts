const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** "150,000 RWF". Amounts arrive from the API as exact decimal strings; this is display only. */
export function money(v: unknown, currency = 'RWF'): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? `${nf.format(n)} ${currency}` : '—';
}
export const amount = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : nf.format(Number(v)));
export const isPositive = (v: unknown) => Number(v) > 0;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Date-only values are ISO strings at UTC midnight; format without any time-zone shift. */
export function date(v: unknown): string {
  if (!v) return '—';
  const s = String(v).slice(0, 10);
  const [y, m, d] = s.split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}
export function month(v: unknown): string {
  if (!v) return '—';
  const [y, m] = String(v).slice(0, 7).split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}
export function dateTime(v: unknown): string {
  if (!v) return '—';
  return new Date(String(v)).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kigali' });
}
export const percent = (v: unknown) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`);
export const label = (s: unknown) => String(s ?? '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
export const isoDay = (v: unknown) => String(v ?? '').slice(0, 10);

export function monthRange(today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}
export function addDaysIso(day: string, n: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}
export function fileSize(bytes: number): string {
  return bytes > 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Same rules as the server (server/src/lib/phone.ts), used to warn while typing.
 * The server re-checks and is the authority.
 */
export function parsePhone(raw: string): { e164: string | null; problem: string | null } {
  let v = raw.trim().replace(/[\s\-().]/g, '');
  if (!v) return { e164: null, problem: 'Enter a phone number.' };
  if (v.startsWith('00')) v = `+${v.slice(2)}`;
  if (/^07\d{8}$/.test(v)) v = `+250${v.slice(1)}`;
  else if (/^2507\d{8}$/.test(v)) v = `+${v}`;
  const hint = 'Enter a Rwandan number such as 078 812 3456, or a foreign number starting with + and the country code.';
  if (!v.startsWith('+')) return { e164: null, problem: /^0\d*$/.test(v) ? `A Rwandan mobile number has 10 digits and starts with 07 (072, 073, 078 or 079).` : hint };
  if (!/^\+\d+$/.test(v)) return { e164: null, problem: 'A phone number contains digits only (after the +).' };
  if (v.startsWith('+250')) {
    const rest = v.slice(4);
    if (/^7[2389]\d{7}$/.test(rest) || /^25\d{7}$/.test(rest)) return { e164: v, problem: null };
    return { e164: null, problem: /^7\d{8}$/.test(rest) ? 'Rwandan mobile numbers start with 072, 073, 078 or 079.' : `A Rwandan number has 9 digits after +250; this one has ${rest.length}.` };
  }
  return /^\+[1-9]\d{7,14}$/.test(v) ? { e164: v, problem: null } : { e164: null, problem: 'An international number is + followed by the country code and 8 to 15 digits in total.' };
}

/** "+250788123456" → "+250 788 123 456"; anything else is shown as stored. */
export function phone(v: unknown): string {
  const s = String(v ?? '');
  const m = /^\+250(\d{3})(\d{3})(\d{3})$/.exec(s);
  return m ? `+250 ${m[1]} ${m[2]} ${m[3]}` : s || '—';
}

/** Opens the device's own SMS app with the number and text filled in (works on phones; on a computer only if linked to a phone). */
export function smsLink(to: string, body: string): string {
  return `sms:${to}?&body=${encodeURIComponent(body)}`;
}
