import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { prisma } from '../db.js';
import { AppError, notFound } from '../errors.js';
import type { Actor } from '../http/context.js';
import { money } from '../lib/money.js';
import { audit } from './audit.js';

/**
 * Each building has its own lease contract, a Word file in server/templates — UBUMWE HOUSE's is
 * "Contract Ubmwe House.doc", kept as contract-ubumwe.docx. Nothing in it is rebuilt: the document is copied as is
 * (logo, fonts, numbering, bold/highlighted clauses, footer) and only the blanks are filled —
 * the "(…)" placeholders, the start/end dates of Ingingo 8 (always one year), the signing date and
 * the tenant's signature name. The PDF is that same Word file printed by LibreOffice, so both look identical.
 */
const TEMPLATE_DIRS = ['templates', 'server/templates', resolve(import.meta.dirname, '../../templates')];
const TEMPLATE_FILE = /^[\w.-]+\.docx$/;

function templatesDir(): string | null {
  for (const d of TEMPLATE_DIRS) {
    const dir = resolve(process.cwd(), d);
    if (existsSync(dir)) return dir;
  }
  return null;
}

/**
 * The lease contracts available to buildings: the .docx files in server/templates.
 * Each building is linked to its own (Buildings → Edit → Lease contract), so a tenant only
 * ever receives the contract of the building they rent in.
 */
export async function listContractTemplates(): Promise<string[]> {
  const dir = templatesDir();
  return dir ? (await readdir(dir)).filter((f) => TEMPLATE_FILE.test(f)).sort() : [];
}

export async function isContractTemplate(file: string): Promise<boolean> {
  return TEMPLATE_FILE.test(file) && (await listContractTemplates()).includes(file);
}
const SOFFICE_PATHS = [process.env.SOFFICE_PATH, '/Applications/LibreOffice.app/Contents/MacOS/soffice', '/usr/bin/soffice', '/usr/local/bin/soffice', '/opt/homebrew/bin/soffice'];

const BLANK = '……………………………';
const DOTS = '[….]+';
const RW_DATE = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
const RWF = (n: number) => `${Math.round(n).toLocaleString('en-US')} Frw`;
/** +250788123456 → 0788123456 (how Rwandan numbers are written on paper); other numbers unchanged. */
const localPhone = (p: string) => (/^\+2507\d{8}$/.test(p) ? `0${p.slice(4)}` : p);

/** The text inside each "(…)" of the original, mapped to the value that replaces it. */
const PLACEHOLDERS: Record<string, string> = {
  'company name': 'companyName',
  'customer name': 'tenantName',
  'id number': 'idNumber',
  'district of tenant': 'district',
  'sector of tenant': 'sector',
  'cell of the tenant': 'cell',
  'village of the tenant': 'village',
  'phone number of the tenant': 'phone',
  'tin number of the tenant': 'tenantTin',
  'email of the tenant': 'email',
  'room number': 'roomNumber',
  'room rent per month': 'monthlyRent',
  'starting date or payment dates': 'paymentDay',
};

async function contractValues(orgId: string, id: string) {
  const c = await prisma.contract.findFirst({ where: { id, orgId }, include: { tenant: true, room: true, building: true } });
  if (!c) throw notFound('Contract');
  const t = c.tenant;
  const b = c.building;
  const rent = Number(money(c.monthlyRent));
  const net = Math.round(rent / 1.18);
  const values: Record<string, string | null> = {
    companyName: t.businessName || t.fullName,
    tenantName: t.fullName,
    idNumber: t.idNumber,
    district: t.district, sector: t.sector, cell: t.cell, village: t.village,
    phone: localPhone(t.phone),
    tenantTin: t.tin,
    email: t.email,
    roomNumber: c.room.number,
    monthlyRent: RWF(rent),
    // Ingingo 3: the rent includes VAT (TVA) of 18%, split into the amount before tax and the tax itself.
    rentExclVat: RWF(net),
    vat: RWF(rent - net),
    paymentDay: String(c.paymentDueDay),
    // Ingingo 8: the written lease always covers one whole year from the start date (a renewal's own start, or a
    // corrected start), whatever the tenant has paid so far — the contract's end date in the system follows payments.
    startDate: RW_DATE(c.startDate),
    endDate: RW_DATE(new Date(Date.UTC(c.startDate.getUTCFullYear() + 1, c.startDate.getUTCMonth(), c.startDate.getUTCDate() - 1))),
    signedDate: RW_DATE(c.createdAt),
    // The landlord: the company that owns this building (Buildings → Edit → company details).
    lessorName: b.companyName, managerName: b.managerName, lessorTin: b.tin, lessorPhone: b.phone, lessorEmail: b.email,
    bankName: b.bankName, bankAccount: b.bankAccount, upi: b.upi,
    buildingDistrict: b.district, buildingSector: b.sector, buildingCell: b.cell, buildingVillage: b.village,
  };
  return { contract: c, values };
}

const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const BOLD_ON = '\u0001';
const BOLD_OFF = '\u0002';

/** The formatting (<w:rPr>) of the run that holds the text node at `at`. */
function runProperties(p: string, at: number): string {
  const start = Math.max(p.lastIndexOf('<w:r>', at), p.lastIndexOf('<w:r ', at));
  return start < 0 ? '' : (p.slice(start, at).match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] ?? '');
}

/** The same formatting, in bold. */
function bold(rPr: string): string {
  if (!rPr) return '<w:rPr><w:b/><w:bCs/></w:rPr>';
  if (/<w:b\/>/.test(rPr)) return rPr;
  return rPr.replace(/^(<w:rPr>(?:<w:rStyle[^>]*\/>)?(?:<w:rFonts[^>]*\/>)?)/, '$1<w:b/><w:bCs/>');
}

/**
 * Replaces text inside one <w:p>, even when Word split it over several runs. The replacement
 * takes the formatting of the run where the match starts; the other runs keep theirs.
 */
function replaceInParagraph(p: string, pattern: RegExp, replace: (m: RegExpExecArray) => string): string {
  const nodes = [...p.matchAll(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g)].map((m) => ({ at: m.index!, whole: m[0], text: unescapeXml(m[2]!) }));
  const full = nodes.map((n) => n.text).join('');
  const matches = [...full.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
  if (!matches.length) return p;
  const texts = nodes.map((n) => n.text);
  // Work backwards so earlier offsets stay valid.
  for (const m of matches.reverse()) {
    const start = m.index!;
    const end = start + m[0].length;
    const value = replace(m);
    let pos = 0;
    let placed = false;
    for (let i = 0; i < texts.length; i++) {
      const len = nodes[i]!.text.length;
      const from = Math.max(start, pos) - pos;
      const to = Math.min(end, pos + len) - pos;
      if (from < to) {
        const t = texts[i]!;
        // Offsets inside this node refer to the original text; earlier (later-in-text) edits never touch it.
        texts[i] = t.slice(0, from) + (placed ? '' : value) + t.slice(to);
        placed = true;
      }
      pos += len;
    }
  }
  let out = '';
  let last = 0;
  nodes.forEach((n, i) => {
    out += p.slice(last, n.at);
    // A "\t" in a replacement becomes a real Word tab; text between BOLD_ON and BOLD_OFF becomes a bold run.
    const rPr = runProperties(p, n.at);
    out += texts[i]
      ? `<w:t xml:space="preserve">${escapeXml(texts[i]!).replace(/\t/g, '</w:t><w:tab/><w:t xml:space="preserve">')
        .replaceAll(BOLD_ON, `</w:t></w:r><w:r>${bold(rPr)}<w:t xml:space="preserve">`).replaceAll(BOLD_OFF, `</w:t></w:r><w:r>${rPr}<w:t xml:space="preserve">`)}</w:t>`
      : '<w:t></w:t>';
    last = n.at + n.whole.length;
  });
  return out + p.slice(last);
}

/** Where "UWIMANA Annonciata" starts on the signature line of the original, in twentieths of a point. */
const SIGNATURE_TAB = 4860;
/** The tenant's dotted signature line followed, after a wide gap, by the manager's name. */
const SIGNATURE_LINE = /^[….]+ {10,}\S/;
const paragraphText = (p: string) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => unescapeXml(m[1]!)).join('');

/**
 * The original names UBUMWE HOUSE LTD as the landlord throughout. Each building has its own
 * company, so every landlord detail is replaced by the building's — or left as a dotted line
 * when the building's details have not been entered yet.
 */
function replaceLessor(p: string, v: (k: string) => string): string {
  // Where the building's detail is the same as the original's, the original text is kept exactly (spacing, capitals).
  const swap = (pattern: RegExp, key: string, original: string, build: (value: string) => string = (x) => x) =>
    (p = replaceInParagraph(p, pattern, (m) => (norm(v(key)) === norm(original) ? m[0] : build(v(key)))));
  swap(/UBUMWE HOUSE(?: (?:LTD|Ltd|ltd))?/g, 'lessorName', 'UBUMWE HOUSE LTD');
  swap(/UWIMANA\s+Annonciata/g, 'managerName', 'UWIMANA Annonciata');
  swap(/TIN:\s*118631022/g, 'lessorTin', '118631022', (x) => `TIN:${x}`);
  swap(/0788483962/g, 'lessorPhone', '0788483962');
  swap(/ubumwehouseltd@gmail\.com/g, 'lessorEmail', 'ubumwehouseltd@gmail.com');
  swap(/No:\s*4491194467/g, 'bankAccount', '4491194467', (x) => `No:${x}`);
  swap(/BPR BANK/g, 'bankName', 'BPR BANK');
  swap(/UPI:\s*1\/01\/04\/03\/2785/g, 'upi', '1/01/04/03/2785', (x) => `UPI: ${x}`);
  const place = ['buildingVillage', 'buildingCell', 'buildingSector', 'buildingDistrict'].map(v).join('|');
  p = replaceInParagraph(p, /mudugudu wa Akabeza, Akagari ka Kimisagara, Umurenge wa Kimisagara, akarere ka Nyarugenge/g,
    (m) => (norm(place) === norm('Akabeza|Kimisagara|Kimisagara|Nyarugenge') ? m[0]
      : `mudugudu wa ${v('buildingVillage')}, Akagari ka ${v('buildingCell')}, Umurenge wa ${v('buildingSector')}, akarere ka ${v('buildingDistrict')}`));
  swap(/Bikorewe i Nyarugenge/g, 'buildingDistrict', 'Nyarugenge', (x) => `Bikorewe i ${x}`);
  return p;
}
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toUpperCase();

function fillDocumentXml(xml: string, values: Record<string, string | null>): string {
  const v = (k: string) => (values[k]?.trim() ? values[k]!.trim() : BLANK);
  // The tenant's details and the lease terms filled in from the records are printed in bold, so they stand out.
  const b = (k: string) => (values[k]?.trim() ? `${BOLD_ON}${values[k]!.trim()}${BOLD_OFF}` : BLANK);
  return xml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (p) => {
    // Landlord first, so a tenant detail that happens to look like the landlord's (same TIN, a name containing
    // "UBUMWE HOUSE") is never touched.
    p = replaceLessor(p, v);
    // "…………(customer name)……………" → "MUKAMANA Diane"; brackets that are not placeholders, like "(Lessee)", stay.
    p = replaceInParagraph(p, new RegExp(`${DOTS}\\s*\\(\\s*([^()]*?)\\s*\\)\\s*${DOTS}(?=(\\S?))`, 'g'), (m) => {
      const key = PLACEHOLDERS[m[1]!.toLowerCase()];
      if (!key) return m[0];
      // Keep a space before the next word ("No B1 03 uri mu nyubako"), not before punctuation.
      return b(key) + (/^[\p{L}\p{N}]$/u.test(m[2] ?? '') ? ' ' : '');
    });
    p = replaceInParagraph(p, new RegExp(`(Ayo mafaranga akubiyemo )${DOTS}\\s*(hiyongereyeho )${DOTS}\\s*`), (m) => `${m[1]}${b('rentExclVat')} ${m[2]}${b('vat')} `);
    p = replaceInParagraph(p, /igihe cy’amezi atandatu/, () => `igihe cy’${BOLD_ON}umwaka umwe (1)${BOLD_OFF}`);
    p = replaceInParagraph(p, new RegExp(`(uhereye ku itariki ya )${DOTS}`), (m) => m[1] + b('startDate'));
    p = replaceInParagraph(p, new RegExp(`(kugeza kuwa)${DOTS}`), (m) => `${m[1]} ${b('endDate')}`);
    p = replaceInParagraph(p, new RegExp(`(Bikorewe i Nyarugenge kuwa )${DOTS}`), (m) => m[1] + b('signedDate'));
    // Signature line (dots, then the manager's name): the tenant's name goes where the dots are; a tab keeps "UWIMANA Annonciata"
    // exactly where it is in the original, whatever the length of the name.
    if (SIGNATURE_LINE.test(paragraphText(p))) {
      p = replaceInParagraph(p, new RegExp(`^${DOTS}\\s*`), () => `${v('tenantName')}\t`);
      p = p.replace('<w:spacing', `<w:tabs><w:tab w:val="left" w:pos="${SIGNATURE_TAB}"/></w:tabs><w:spacing`);
    }
    // Filled values are shorter than the dotted lines; keep this heading at the top of page 2 as in the original.
    if (paragraphText(p).trim() === 'Impande zombi zumvikanye ibi bikurikira:') p = p.replace(/(<w:pStyle [^>]*\/>)/, '$1<w:pageBreakBefore/>');
    return p;
  });
}

const logos = new Map<string, { data: Buffer; mime: string } | null>();

/**
 * The logo printed at the top of a contract file (its first picture), used as the company's logo on
 * that building's reports. Read once per file.
 */
export async function templateLogo(file: string | null | undefined): Promise<{ data: Buffer; mime: string } | null> {
  if (!file) return null;
  if (!logos.has(file)) {
    let logo: { data: Buffer; mime: string } | null = null;
    try {
      const zip = await JSZip.loadAsync(await templateBuffer(file));
      const name = Object.keys(zip.files).filter((n) => /^word\/media\/.+\.(png|jpe?g)$/i.test(n)).sort()[0];
      if (name) logo = { data: await zip.file(name)!.async('nodebuffer'), mime: /\.png$/i.test(name) ? 'image/png' : 'image/jpeg' };
    } catch {
      logo = null;
    }
    logos.set(file, logo);
  }
  return logos.get(file) ?? null;
}

async function templateBuffer(file: string): Promise<Buffer> {
  const dir = templatesDir();
  if (!dir || !(await isContractTemplate(file))) throw new AppError(500, 'TEMPLATE_MISSING', `The contract file ${file} is missing on the server (server/templates).`);
  return readFile(join(dir, file));
}

async function toDocx(template: string, values: Record<string, string | null>): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await templateBuffer(template));
  const xml = await zip.file('word/document.xml')!.async('string');
  zip.file('word/document.xml', fillDocumentXml(xml, values));
  // The company e-mail in the original is a link; point it at the building's company e-mail.
  const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
  zip.file('word/_rels/document.xml.rels', rels.replace(/mailto:ubumwehouseltd@gmail\.com[^"]*/g, values.lessorEmail ? `mailto:${encodeURI(values.lessorEmail)}` : 'mailto:'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const run = promisify(execFile);
let queue: Promise<unknown> = Promise.resolve();
/**
 * One LibreOffice profile shared by every conversion: creating a fresh profile costs ~5 s per contract.
 * Sharing is safe because conversions run one at a time (the queue); a profile left broken by a failed run is discarded.
 */
const SOFFICE_PROFILE = join(tmpdir(), 'rpms-soffice-profile');

/** Prints the filled Word file to PDF with LibreOffice — one at a time, all with the same profile. */
async function toPdf(docx: Buffer): Promise<Buffer> {
  const soffice = SOFFICE_PATHS.find((p) => p && existsSync(p)) ?? 'soffice';
  const job = queue.then(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rpms-contract-'));
    try {
      await writeFile(join(dir, 'contract.docx'), docx);
      await run(soffice, [`-env:UserInstallation=file://${SOFFICE_PROFILE}`, '--headless', '--convert-to', 'pdf', '--outdir', dir, join(dir, 'contract.docx')], { timeout: 120_000 });
      return await readFile(join(dir, 'contract.pdf'));
    } catch (e) {
      await rm(SOFFICE_PROFILE, { recursive: true, force: true });
      throw new AppError(500, 'PDF_CONVERTER_UNAVAILABLE', `Could not print the contract to PDF (LibreOffice is needed on the server): ${(e as Error).message}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  queue = job.catch(() => undefined);
  return job;
}

/** Recently printed PDFs, keyed by template file + filled values, so downloading the same contract again is instant. */
const pdfCache = new Map<string, Buffer>();
const PDF_CACHE_SIZE = 30;

async function cachedPdf(template: string, values: Record<string, string | null>, docx: Buffer): Promise<Buffer> {
  const dir = templatesDir();
  const version = dir ? (await stat(join(dir, template))).mtimeMs : 0;
  const key = createHash('sha256').update(JSON.stringify([template, version, values])).digest('hex');
  const hit = pdfCache.get(key);
  if (hit) return hit;
  const pdf = await toPdf(docx);
  pdfCache.set(key, pdf);
  if (pdfCache.size > PDF_CACHE_SIZE) pdfCache.delete(pdfCache.keys().next().value!);
  return pdf;
}

const BUILDING_KEYS = new Set(['lessorName', 'managerName', 'lessorTin', 'lessorPhone', 'lessorEmail', 'bankName', 'bankAccount', 'upi', 'buildingDistrict', 'buildingSector', 'buildingCell', 'buildingVillage']);

/** The filled contract for one lease, as Word (to edit before printing) or PDF (to print as is). */
export async function contractDocument(actor: Actor, id: string, format: 'docx' | 'pdf') {
  const { contract, values } = await contractValues(actor.orgId, id);
  const template = contract.building.contractTemplate;
  if (!template) {
    throw new AppError(409, 'NO_CONTRACT_TEMPLATE', `No lease contract has been set up for ${contract.building.name} yet, so no contract can be printed for this tenant. Each building uses its own contract — another building's contract is never used.`);
  }
  const docx = await toDocx(template, values);
  const buffer = format === 'docx' ? docx : await cachedPdf(template, values, docx);
  const missing = Object.entries(values).filter(([, v]) => !v || !v.trim()).map(([k]) => k);
  const tenantMissing = missing.filter((k) => !BUILDING_KEYS.has(k));
  const buildingMissing = missing.filter((k) => BUILDING_KEYS.has(k));
  await audit(prisma, actor, {
    action: 'CONTRACT_DOCUMENT_GENERATED', entityType: 'Contract', entityId: contract.id,
    summary: `Lease contract ${contract.contractNumber} generated as ${format.toUpperCase()}${missing.length ? ` (left blank: ${missing.join(', ')})` : ''}`,
  });
  const safeName = contract.tenant.fullName.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'tenant';
  return { buffer, fileName: `Amasezerano-${contract.contractNumber}-${safeName}.${format}`, missing: tenantMissing, buildingMissing };
}
