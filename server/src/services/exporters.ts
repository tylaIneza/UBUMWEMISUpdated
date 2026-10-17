import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { isoDate, longDate, parseDate } from '../lib/dates.js';
import { Decimal, formatMoney, money } from '../lib/money.js';
import type { ColumnType, Report, ReportIssuer, ReportTable } from './reports.js';

// ───────────────────────── Shared formatting ─────────────────────────

const isDecimal = (v: unknown): v is InstanceType<typeof Decimal> => Decimal.isDecimal(v);

function label(status: string): string {
  return status.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-10-05 → 05 Oct 2026 */
const shortDate = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : iso);

export function formatCell(value: unknown, type: ColumnType, currency: string): string {
  if (value === null || value === undefined || value === '') return type === 'money' || type === 'number' || type === 'percent' ? '—' : '';
  switch (type) {
    case 'money': return isDecimal(value) || typeof value === 'string' || typeof value === 'number' ? formatMoney(value as never, currency).replace(` ${currency}`, '') : String(value);
    case 'number': return Number(value).toLocaleString('en-US');
    case 'percent': return `${(Number(value) * 100).toFixed(1)}%`;
    case 'date': return shortDate(value instanceof Date ? isoDate(value) : String(value).slice(0, 10));
    case 'datetime': return value instanceof Date ? value.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : String(value);
    case 'status': return label(String(value));
    default: return String(value);
  }
}

// ───────────────────────── PDF ─────────────────────────

const INK = '#1a2433';
const MUTED = '#5b6676';
const RULE = '#c9d0d9';
// Report palette: a deep navy letterhead, soft panels and status colours that also read in black and white.
const NAVY = '#14304f';
const SOFT = '#f4f7fb';
const LINE = '#dde4ec';
const TOTAL_FILL = '#e5edf6';
const TONES = { navy: NAVY, green: '#11845b', amber: '#b26b00', red: '#c0392b' } as const;
type Tone = keyof typeof TONES;

/** Colour of a summary figure, from what it measures. */
function toneOf(label: string): Tone {
  if (/partial|only part/i.test(label)) return 'amber';
  if (/outstanding|owed|owing|unpaid|arrears|overdue|did not pay|still to|vacant|reversed|failed/i.test(label)) return 'red';
  if (/expense|maintenance|waived/i.test(label)) return 'amber';
  if (/collected|received|paid|net income|collection rate|occupancy|occupied/i.test(label)) return 'green';
  return 'navy';
}

/** Colour of a status value in a table. */
function statusTone(value: string): Tone | null {
  if (/^(PAID|VERIFIED|ISSUED|ACTIVE|COMPLETED|OCCUPIED|APPROVED|POSTED)$/.test(value)) return 'green';
  if (/^(PARTIAL|PENDING|EXPIRING|RESERVED|IN_PROGRESS|SUBMITTED|GENERATED|MAINTENANCE)$/.test(value)) return 'amber';
  if (/^(UNPAID|OVERDUE|EXPIRED|TERMINATED|REVERSED|REVERSAL|FAILED|CANCELLED|VACANT|REJECTED)$/.test(value)) return 'red';
  return null;
}

/** The built-in PDF fonts only cover WinAnsi; map the few other characters we use to safe equivalents. */
// eslint-disable-next-line no-control-regex
const pdfText = (s: string) => s.replace(/\u2212/g, '-').replace(/[\u2192\u2190]/g, '->').replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\u00ff\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026]/g, '?');

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function columnWidths(table: ReportTable, currency: string, available: number): number[] {
  const weights = table.columns.map((c) => {
    const sample = [c.label, ...table.rows.slice(0, 60).map((r) => formatCell(r[c.key], c.type, currency)), table.totals ? formatCell(table.totals[c.key], c.type, currency) : ''];
    const longest = Math.max(...sample.map((s) => s.length));
    // Never narrower than the longest word of the heading, so headings do not break inside a word.
    const word = Math.max(...c.label.split(/\s+/).map((w) => w.length)) + 1;
    return Math.min(Math.max(longest, word, 5), c.type === 'text' ? 26 : 16);
  });
  const total = weights.reduce((a, w) => a + w, 0);
  return weights.map((w) => (w / total) * available);
}

const initials = (name: string) => name.replace(/\b(LTD|LIMITED|LLC|SARL|CO)\b\.?/gi, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || 'R';

function logoBuffer(issuer: ReportIssuer): Buffer | null {
  const m = issuer.logo?.match(/^data:image\/(?:png|jpeg);base64,(.+)$/);
  return m ? Buffer.from(m[1]!, 'base64') : null;
}

/** Company logo, or a navy monogram of its initials when the building has no logo. */
function drawLogo(doc: PDFKit.PDFDocument, issuer: ReportIssuer, x: number, y: number, size: number): void {
  const logo = logoBuffer(issuer);
  if (logo) {
    doc.image(logo, x, y, { fit: [size, size], align: 'center', valign: 'center' });
    return;
  }
  doc.roundedRect(x, y, size, size, size * 0.22).fill(NAVY);
  doc.font('Helvetica-Bold').fontSize(size * 0.38).fillColor('#ffffff').text(initials(issuer.name), x, y + size * 0.3, { width: size, align: 'center', lineBreak: false });
}

function drawTable(doc: PDFKit.PDFDocument, table: ReportTable, currency: string): void {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 6;
  const size = table.columns.length > 13 ? 6 : table.columns.length > 9 ? 7 : 8;
  const pad = 4;
  const widths = columnWidths(table, currency, width);
  const numeric = (t: ColumnType) => t === 'money' || t === 'number' || t === 'percent';

  const rowHeight = (cells: string[], bold: boolean) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
    return Math.max(...cells.map((text, i) => doc.heightOfString(pdfText(text) || ' ', { width: widths[i]! - pad * 2 }))) + pad * 2;
  };
  const drawRow = (cells: string[], opts: { kind: 'head' | 'body' | 'total'; zebra?: boolean; raw?: unknown[] }) => {
    const bold = opts.kind !== 'body';
    const h = rowHeight(cells, bold);
    const y = doc.y;
    if (opts.kind === 'head') doc.rect(left, y, width, h).fill(NAVY);
    else if (opts.kind === 'total') doc.rect(left, y, width, h).fill(TOTAL_FILL);
    else if (opts.zebra) doc.rect(left, y, width, h).fill(SOFT);
    let x = left;
    cells.forEach((text, i) => {
      const col = table.columns[i]!;
      const tone = opts.kind === 'body' && col.type === 'status' ? statusTone(String(opts.raw?.[i] ?? '')) : null;
      doc.font(bold || tone ? 'Helvetica-Bold' : 'Helvetica').fontSize(size)
        .fillColor(opts.kind === 'head' ? '#ffffff' : tone ? TONES[tone] : opts.kind === 'total' ? NAVY : INK);
      doc.text(pdfText(text), x + pad, y + pad, { width: widths[i]! - pad * 2, align: numeric(col.type) ? 'right' : 'left', lineBreak: true });
      x += widths[i]!;
    });
    if (opts.kind === 'total') doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1).strokeColor(NAVY).stroke();
    else if (opts.kind === 'body') doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.3).strokeColor(LINE).stroke();
    doc.y = y + h;
    doc.x = left;
  };
  const header = () => drawRow(table.columns.map((c) => c.label), { kind: 'head' });

  if (doc.y + 70 > bottom()) doc.addPage();
  // Section title: a navy marker, the title and the number of rows.
  const ty = doc.y + 12;
  doc.rect(left, ty + 1, 3, 11).fill(NAVY);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY).text(pdfText(table.title), left + 9, ty, { continued: true })
    .font('Helvetica').fontSize(8).fillColor(MUTED).text(`   ${table.rows.length} row${table.rows.length === 1 ? '' : 's'}`);
  doc.y = ty + 18;
  header();
  if (!table.rows.length) {
    const y = doc.y;
    doc.rect(left, y, width, 20).fill(SOFT);
    doc.font('Helvetica-Oblique').fontSize(size + 0.5).fillColor(MUTED).text('No records for the selected filters.', left + pad, y + 6, { width: width - pad * 2 });
    doc.y = y + 20;
  }
  table.rows.forEach((row, n) => {
    const cells = table.columns.map((c) => formatCell(row[c.key], c.type, currency));
    if (doc.y + rowHeight(cells, false) > bottom()) {
      doc.addPage();
      header();
    }
    drawRow(cells, { kind: 'body', zebra: n % 2 === 1, raw: table.columns.map((c) => row[c.key]) });
  });
  if (table.totals) {
    const cells = table.columns.map((c) => {
      const v = table.totals![c.key];
      return v === undefined ? '' : formatCell(v, typeof v === 'string' && !/^-?\d/.test(v) ? 'text' : c.type, currency);
    });
    if (doc.y + rowHeight(cells, true) > bottom()) {
      doc.addPage();
      header();
    }
    drawRow(cells, { kind: 'total' });
  }
  if (table.note) doc.moveDown(0.3).font('Helvetica-Oblique').fontSize(7.5).fillColor(MUTED).text(pdfText(table.note), left, doc.y, { width });
}

/** Letterhead: logo, the issuing company's details, and the report's title and period. */
function drawLetterhead(doc: PDFKit.PDFDocument, report: Report): void {
  const { issuer } = report;
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const top = 30;
  const logo = 50;
  drawLogo(doc, issuer, left, top, logo);
  const tx = left + logo + 12;
  const textW = width * 0.56 - logo - 12;
  doc.font('Helvetica-Bold').fontSize(16).fillColor(NAVY).text(pdfText(issuer.name), tx, top + 2, { width: textW, lineBreak: false, ellipsis: true });
  const contact = [issuer.tin && `TIN ${issuer.tin}`, issuer.phone && `Tel ${issuer.phone}`, issuer.email].filter(Boolean).join('   ·   ');
  doc.font('Helvetica').fontSize(8).fillColor(MUTED);
  if (contact) doc.text(pdfText(contact), tx, top + 23, { width: textW });
  if (issuer.address) doc.text(pdfText(issuer.address), tx, doc.y + 1, { width: textW });
  // Right: the report itself.
  const rx = left + width * 0.56;
  const rw = width * 0.44;
  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK).text(pdfText(report.title), rx, top + 2, { width: rw, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY).text(pdfText(report.period), rx, doc.y + 2, { width: rw, align: 'right' });
  if (issuer.building) doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(pdfText(`Building: ${issuer.building}`), rx, doc.y + 1, { width: rw, align: 'right' });
  const y = Math.max(doc.y, top + logo) + 10;
  doc.rect(left, y, width, 2.5).fill(NAVY);
  doc.rect(left, y + 3.5, width, 0.8).fill('#8aa4c2');
  doc.y = y + 12;

  // Meta strip.
  const meta: Array<[string, string]> = [
    ['PROPERTY', report.scope || 'All buildings'], ['REPORTING PERIOD', report.period],
    ['GENERATED', `${longDate(parseDate(report.generatedAt.slice(0, 10)))} ${report.generatedAt.slice(11, 16)} UTC`], ['PREPARED BY', `${report.preparedBy} · ${report.currency}`],
  ];
  const my = doc.y;
  doc.roundedRect(left, my, width, 32, 4).fill(SOFT);
  const cw = width / meta.length;
  meta.forEach(([k, v], i) => {
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(MUTED).text(k, left + 10 + i * cw, my + 7, { width: cw - 16, lineBreak: false, characterSpacing: 0.4 });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(pdfText(v), left + 10 + i * cw, my + 17, { width: cw - 16, lineBreak: false, ellipsis: true });
  });
  doc.y = my + 32;
  if (report.isDemoData) doc.moveDown(0.5).fillColor('#9a3412').font('Helvetica-Bold').fontSize(9).text('DEMO DATA — this report was generated from sample records, not real business data.', left);
}

function drawSummary(doc: PDFKit.PDFDocument, report: Report, cols: number): void {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const gap = 8;
  const cw = (width - gap * (cols - 1)) / cols;
  const ch = 40;
  let y = doc.y + 12;
  report.summary.forEach((item, i) => {
    const col = i % cols;
    if (col === 0 && i > 0) y += ch + gap;
    if (col === 0 && y + ch > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    const x = left + col * (cw + gap);
    const tone = TONES[toneOf(item.label)];
    doc.roundedRect(x, y, cw, ch, 4).lineWidth(0.6).fillAndStroke('#ffffff', LINE);
    doc.rect(x, y + 6, 3, ch - 12).fill(tone);
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(MUTED).text(pdfText(item.label.toUpperCase()), x + 10, y + 7, { width: cw - 16, lineBreak: false, ellipsis: true, characterSpacing: 0.3 });
    const value = formatCell(item.value, item.type, report.currency);
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor(INK).text(pdfText(value), x + 10, y + 18, { width: cw - 16, lineBreak: false, ellipsis: true, continued: item.type === 'money' && item.value != null });
    if (item.type === 'money' && item.value != null) doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(` ${report.currency}`, { lineBreak: false });
  });
  doc.y = y + ch;
  doc.x = left;
}

export async function reportToPdf(report: Report): Promise<Buffer> {
  const wide = report.tables.some((t) => t.columns.length > 7);
  const doc = new PDFDocument({ size: 'A4', layout: wide ? 'landscape' : 'portrait', margins: { top: 46, bottom: 40, left: 36, right: 36 }, bufferPages: true, info: { Title: `${report.title} — ${report.period}`, Author: report.organization } });
  const done = collect(doc);
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;

  drawLetterhead(doc, report);

  for (const w of report.warnings) {
    doc.font('Helvetica-Bold').fontSize(8.5);
    const h = doc.heightOfString(pdfText(`! ${w}`), { width: width - 20 }) + 12;
    const y = doc.y + 8;
    doc.roundedRect(left, y, width, h, 4).fill('#fdecea');
    doc.fillColor(TONES.red).text(pdfText(`! ${w}`), left + 10, y + 6, { width: width - 20 });
    doc.y = y + h;
  }

  if (report.summary.length) drawSummary(doc, report, wide ? 4 : 3);

  for (const table of report.tables) drawTable(doc, table, report.currency);

  if (report.notes.length) {
    doc.font('Helvetica').fontSize(7.5);
    const text = report.notes.map((n) => `•  ${n}`).join('\n');
    const h = doc.heightOfString(pdfText(text), { width: width - 20 }) + 24;
    if (doc.y + h + 14 > doc.page.height - doc.page.margins.bottom) doc.addPage();
    const y = doc.y + 14;
    doc.roundedRect(left, y, width, h, 4).fill(SOFT);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(NAVY).text('NOTES', left + 10, y + 7, { characterSpacing: 0.4 });
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(pdfText(text), left + 10, y + 18, { width: width - 20 });
    doc.y = y + h;
  }

  if (report.signatures) {
    if (doc.y + 80 > doc.page.height - doc.page.margins.bottom) doc.addPage();
    const y = doc.y + 44;
    const w = (width - 48) / 3;
    ['Prepared by', 'Checked by', 'Approved by'].forEach((who, i) => {
      const x = left + i * (w + 24);
      doc.moveTo(x, y).lineTo(x + w, y).lineWidth(0.7).strokeColor(NAVY).stroke();
      doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${who}${i === 0 ? `: ${pdfText(report.preparedBy)}` : ''}`, x, y + 5, { width: w });
      doc.font('Helvetica').fontSize(7).fillColor(MUTED).text('Name, signature and date', x, y + 16, { width: w });
    });
    doc.y = y + 28;
  }

  // Running header (pages 2+) and footer (all pages). Writing in the margins must not add pages.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const saved = { ...doc.page.margins };
    doc.page.margins.top = 0;
    doc.page.margins.bottom = 0;
    const w = doc.page.width - saved.left - saved.right;
    if (i > range.start) {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY).text(pdfText(report.issuer.name), saved.left, 20, { width: w / 2, lineBreak: false });
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(pdfText(`${report.title} · ${report.period}`), saved.left + w / 2, 20, { width: w / 2, align: 'right', lineBreak: false });
      doc.moveTo(saved.left, 32).lineTo(saved.left + w, 32).lineWidth(0.5).strokeColor(LINE).stroke();
    }
    const y = doc.page.height - saved.bottom + 12;
    doc.moveTo(saved.left, y - 5).lineTo(saved.left + w, y - 5).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(pdfText(`${report.issuer.name} — ${report.title} — ${report.period}`), saved.left, y, { width: w * 0.75, lineBreak: false, ellipsis: true });
    doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY).text(`Page ${i + 1} of ${range.count}`, saved.left, y, { width: w, align: 'right', lineBreak: false });
    doc.page.margins.top = saved.top;
    doc.page.margins.bottom = saved.bottom;
  }
  doc.end();
  return done;
}

export interface ReceiptData {
  organization: { name: string; tin?: string | null; address?: string | null; phone?: string | null };
  receiptNumber: string;
  tenant: { name: string; phone?: string | null; businessName?: string | null };
  building: string;
  floor: string;
  room: string;
  contractNumber: string;
  amount: string;
  currency: string;
  method: string;
  reference?: string | null;
  businessDate: string;
  lines: Array<{ period: string; applied: string; balanceAfter: string; advance: boolean }>;
  advanceCredit: string;
  outstandingAfter: string;
  recordedBy: string;
}

export async function receiptToPdf(r: ReceiptData, state: { voided: boolean; voidReason?: string | null; ebmReference?: string | null; isDemoData: boolean }): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A5', margin: 32, info: { Title: `Receipt ${r.receiptNumber}`, Author: r.organization.name } });
  const done = collect(doc);
  const left = doc.page.margins.left;
  const width = doc.page.width - left * 2;
  const cur = r.currency;

  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK).text(r.organization.name, left);
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text([r.organization.address, r.organization.phone, r.organization.tin ? `TIN ${r.organization.tin}` : ''].filter(Boolean).join('  ·  '));
  doc.moveDown(0.6).moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(1).strokeColor(INK).stroke();
  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(12).fillColor(INK).text('RENT PAYMENT RECEIPT');
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`Receipt number: ${r.receiptNumber}        Date: ${longDate(parseDate(r.businessDate))}`);
  if (state.isDemoData) doc.fillColor('#9a3412').font('Helvetica-Bold').text('DEMO DATA — not a real receipt');
  if (state.voided) {
    doc.moveDown(0.4).font('Helvetica-Bold').fontSize(11).fillColor('#b91c1c').text(`VOID — this payment was reversed${state.voidReason ? `: ${state.voidReason}` : ''}`);
  }

  const pair = (k: string, v: string) => {
    const y = doc.y;
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(k, left, y, { width: width * 0.35 });
    doc.font('Helvetica-Bold').fillColor(INK).text(v || '—', left + width * 0.35, y, { width: width * 0.65 });
    doc.moveDown(0.25);
  };
  doc.moveDown(0.8);
  pair('Received from', r.tenant.businessName ? `${r.tenant.name} (${r.tenant.businessName})` : r.tenant.name);
  pair('Room', `${r.room} — ${r.floor}, ${r.building}`);
  pair('Contract', r.contractNumber);
  pair('Payment method', r.method + (r.reference ? ` — ref. ${r.reference}` : ''));
  pair('Amount received', formatMoney(r.amount, cur));
  if (state.ebmReference) pair('EBM reference', state.ebmReference);

  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text('Applied to', left);
  doc.moveDown(0.2);
  const row = (a: string, b: string, c: string, bold = false) => {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(INK);
    doc.text(a, left, y, { width: width * 0.44 });
    doc.text(b, left + width * 0.44, y, { width: width * 0.28, align: 'right' });
    doc.text(c, left + width * 0.72, y, { width: width * 0.28, align: 'right' });
    doc.moveDown(0.3);
    doc.moveTo(left, doc.y - 1).lineTo(left + width, doc.y - 1).lineWidth(0.4).strokeColor(RULE).stroke();
  };
  row('Billing month', 'Amount applied', 'Balance after', true);
  for (const l of r.lines) row(l.period + (l.advance ? ' (advance)' : ''), formatMoney(l.applied, cur), formatMoney(l.balanceAfter, cur));
  if (money(r.advanceCredit).greaterThan(0)) row('Advance credit (not yet applied to a month)', formatMoney(r.advanceCredit, cur), '');
  doc.moveDown(0.5);
  pair('Balance still outstanding', formatMoney(r.outstandingAfter, cur));

  doc.moveDown(1.5);
  const y = doc.y + 18;
  doc.moveTo(left, y).lineTo(left + width * 0.45, y).lineWidth(0.6).strokeColor(INK).stroke();
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`Received by: ${r.recordedBy}`, left, y + 4);
  doc.text('This receipt is valid only for the amount and months shown.', left, y + 22, { width });
  doc.end();
  return done;
}

// ───────────────────────── Excel ─────────────────────────

const MONEY_FMT = '#,##0.##;[Red]-#,##0.##';
const argb = (hex: string) => `FF${hex.replace('#', '').toUpperCase()}`;
const fill = (hex: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: argb(hex) } });
const thin = (hex: string): Partial<ExcelJS.Border> => ({ style: 'thin', color: { argb: argb(hex) } });
/** Row of the column headings on every table sheet (above it: company, table title and period). */
export const EXCEL_HEADER_ROW = 4;

function excelValue(value: unknown, type: ColumnType): ExcelJS.CellValue {
  if (value === null || value === undefined || value === '') return null;
  if (type === 'money' || type === 'number' || type === 'percent') {
    const n = isDecimal(value) ? value.toNumber() : Number(value);
    return Number.isFinite(n) ? n : String(value);
  }
  if (type === 'date' || type === 'datetime') return value instanceof Date ? value : new Date(String(value));
  if (type === 'status') return label(String(value));
  return String(value);
}

const numFmt = (type: ColumnType) => (type === 'money' ? MONEY_FMT : type === 'percent' ? '0.0%' : type === 'date' ? 'dd mmm yyyy' : type === 'datetime' ? 'dd mmm yyyy hh:mm' : type === 'number' ? '#,##0' : undefined);

function sheetName(title: string, used: Set<string>): string {
  // Excel limits sheet names to 31 characters.
  const base = title.replace(/[\\/*?:[\]]/g, ' ').replace(/\s+/g, ' ').slice(0, 31).trim() || 'Sheet';
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i += 1) name = `${base.slice(0, 28)} ${i}`;
  used.add(name.toLowerCase());
  return name;
}

function addLogo(wb: ExcelJS.Workbook, ws: ExcelJS.Worksheet, issuer: ReportIssuer): void {
  const m = issuer.logo?.match(/^data:image\/(png|jpeg);base64,(.+)$/);
  if (!m) return;
  const id = wb.addImage({ base64: m[2]!, extension: m[1] as 'png' | 'jpeg' });
  ws.addImage(id, { tl: { col: 0.15, row: 0.15 }, ext: { width: 70, height: 56 } });
}

export async function reportToExcel(report: Report): Promise<Buffer> {
  const { issuer } = report;
  const wb = new ExcelJS.Workbook();
  wb.creator = report.preparedBy;
  wb.company = issuer.name;
  wb.title = `${report.title} — ${report.period}`;
  wb.created = new Date(report.generatedAt);
  const used = new Set<string>();

  // ── Cover sheet: letterhead, report details and the summary figures.
  const info = wb.addWorksheet(sheetName('Summary', used), { views: [{ showGridLines: false }], pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  info.columns = [{ width: 12 }, { width: 40 }, { width: 26 }, { width: 18 }, { width: 18 }];
  addLogo(wb, info, issuer);
  const name = info.getCell('B1');
  name.value = issuer.name;
  name.font = { bold: true, size: 18, color: { argb: argb(NAVY) } };
  info.getCell('B2').value = [issuer.tin && `TIN ${issuer.tin}`, issuer.phone && `Tel ${issuer.phone}`, issuer.email].filter(Boolean).join('   ·   ') || null;
  info.getCell('B3').value = issuer.address;
  for (const c of ['B2', 'B3']) info.getCell(c).font = { size: 9, color: { argb: argb(MUTED) } };
  info.getRow(1).height = 26;
  info.mergeCells('B1:E1');
  info.mergeCells('B2:E2');
  info.mergeCells('B3:E3');
  const titleRow = info.getRow(5);
  titleRow.height = 26;
  info.mergeCells('A5:E5');
  const title = info.getCell('A5');
  title.value = `  ${report.title}`;
  title.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  title.fill = fill(NAVY);
  title.alignment = { vertical: 'middle' };
  let r = 7;
  const meta: Array<[string, ExcelJS.CellValue]> = [
    ['Property', report.scope || 'All buildings'], ['Reporting period', report.period], ['Generated', new Date(report.generatedAt)],
    ['Prepared by', report.preparedBy], ['Currency', report.currency],
  ];
  for (const [k, v] of meta) {
    const row = info.getRow(r++);
    row.getCell(2).value = k;
    row.getCell(2).font = { color: { argb: argb(MUTED) } };
    row.getCell(3).value = v;
    row.getCell(3).font = { bold: true };
    if (v instanceof Date) row.getCell(3).numFmt = 'dd mmm yyyy hh:mm';
    row.getCell(3).alignment = { horizontal: 'left' };
  }
  if (report.isDemoData) info.getRow(r++).getCell(2).value = 'DEMO DATA — generated from sample records, not real business data.';
  for (const w of report.warnings) {
    const c = info.getRow(r++).getCell(2);
    c.value = `⚠ ${w}`;
    c.font = { bold: true, color: { argb: argb(TONES.red) } };
  }
  if (report.summary.length) {
    r += 1;
    const head = info.getRow(r++);
    head.getCell(2).value = 'Summary';
    head.getCell(3).value = 'Value';
    for (const i of [2, 3]) {
      head.getCell(i).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      head.getCell(i).fill = fill(NAVY);
    }
    head.getCell(3).alignment = { horizontal: 'right' };
    report.summary.forEach((item, n) => {
      const row = info.getRow(r++);
      row.getCell(2).value = item.label;
      const cell = row.getCell(3);
      cell.value = excelValue(item.value, item.type);
      const f = numFmt(item.type);
      if (f) cell.numFmt = item.type === 'money' ? `${MONEY_FMT} "${report.currency}"` : f;
      cell.font = { bold: true, color: { argb: argb(TONES[toneOf(item.label)]) } };
      cell.alignment = { horizontal: 'right' };
      for (const i of [2, 3]) {
        if (n % 2 === 1) row.getCell(i).fill = fill(SOFT);
        row.getCell(i).border = { bottom: thin(LINE) };
      }
    });
  }
  if (report.notes.length) {
    r += 1;
    info.getRow(r++).getCell(2).value = 'Notes';
    info.getRow(r - 1).getCell(2).font = { bold: true, color: { argb: argb(NAVY) } };
    for (const note of report.notes) {
      const c = info.getRow(r).getCell(2);
      info.mergeCells(r, 2, r, 5);
      c.value = `• ${note}`;
      c.font = { italic: true, size: 9, color: { argb: argb(MUTED) } };
      c.alignment = { wrapText: true, vertical: 'top' };
      info.getRow(r).height = Math.max(15, Math.ceil(note.length / 95) * 13);
      r += 1;
    }
  }

  // ── One sheet per table.
  for (const table of report.tables) {
    const ws = wb.addWorksheet(sheetName(table.title, used), {
      views: [{ state: 'frozen', ySplit: EXCEL_HEADER_ROW, showGridLines: false }],
      pageSetup: { orientation: table.columns.length > 7 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${EXCEL_HEADER_ROW}:${EXCEL_HEADER_ROW}` },
      headerFooter: { oddFooter: `&L${issuer.name.replace(/&/g, '&&')} — ${table.title.replace(/&/g, '&&')}&RPage &P of &N` },
    });
    const n = table.columns.length;
    ws.columns = table.columns.map((c) => {
      const longest = Math.max(c.label.length + (c.type === 'money' ? report.currency.length + 3 : 0), ...table.rows.slice(0, 200).map((row) => formatCell(row[c.key], c.type, report.currency).length));
      return { key: c.key, width: Math.min(Math.max(longest + 3, 10), 48), style: numFmt(c.type) ? { numFmt: numFmt(c.type) } : {} };
    });
    const company = ws.getCell(1, 1);
    company.value = issuer.name;
    company.font = { bold: true, size: 13, color: { argb: argb(NAVY) } };
    const sub = ws.getCell(2, 1);
    sub.value = `${table.title}  ·  ${report.period}${issuer.building ? `  ·  ${issuer.building}` : ''}`;
    sub.font = { bold: true, size: 10, color: { argb: argb(MUTED) } };
    if (n > 1) {
      ws.mergeCells(1, 1, 1, n);
      ws.mergeCells(2, 1, 2, n);
    }
    const head = ws.getRow(EXCEL_HEADER_ROW);
    head.values = table.columns.map((c) => (c.type === 'money' ? `${c.label} (${report.currency})` : c.label));
    head.height = 20;
    head.eachCell((cell, i) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = fill(NAVY);
      cell.alignment = { vertical: 'middle', horizontal: numFmt(table.columns[i - 1]!.type) && table.columns[i - 1]!.type !== 'date' ? 'right' : 'left', wrapText: true };
    });
    table.rows.forEach((row, k) => {
      const added = ws.addRow(table.columns.map((c) => excelValue(row[c.key], c.type)));
      table.columns.forEach((c, i) => {
        const cell = added.getCell(i + 1);
        if (k % 2 === 1) cell.fill = fill(SOFT);
        cell.border = { bottom: thin(LINE) };
        if (c.type === 'status') {
          const tone = statusTone(String(row[c.key] ?? ''));
          if (tone) cell.font = { bold: true, color: { argb: argb(TONES[tone]) } };
        }
      });
    });
    if (!table.rows.length) {
      const empty = ws.addRow(['No records for the selected filters.']);
      empty.getCell(1).font = { italic: true, color: { argb: argb(MUTED) } };
    }
    if (table.totals) {
      const row = ws.addRow(table.columns.map((c) => {
        const v = table.totals![c.key];
        return typeof v === 'string' && !/^-?\d/.test(v) ? v : excelValue(v, c.type);
      }));
      row.eachCell({ includeEmpty: true }, (cell, i) => {
        if (i > n) return;
        cell.font = { bold: true, color: { argb: argb(NAVY) } };
        cell.fill = fill(TOTAL_FILL);
        cell.border = { top: { style: 'medium', color: { argb: argb(NAVY) } } };
      });
    }
    if (table.rows.length) ws.autoFilter = { from: { row: EXCEL_HEADER_ROW, column: 1 }, to: { row: EXCEL_HEADER_ROW, column: n } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
