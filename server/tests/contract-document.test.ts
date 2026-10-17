import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { correctContractDates, createContract, renewContract } from '../src/services/contracts.js';
import { contractDocument } from '../src/services/contractDocument.js';
import { createTenant } from '../src/services/tenants.js';
import { updateBuilding } from '../src/services/property.js';
import { generateReport } from '../src/services/reports.js';
import { createWorld, loginAs, makeBuilding, rwandanId, thisMonth, type World } from './helpers.js';
import { addMonths, endOfMonth } from '../src/lib/dates.js';
import { inflateRawSync } from 'node:zlib';

/** Text of a .docx (word/document.xml), enough to check what was filled in. */
function docxText(buf: Buffer): string {
  // Find the local file header of word/document.xml and inflate it.
  const name = Buffer.from('word/document.xml');
  const at = buf.indexOf(name);
  const header = at - 30;
  const method = buf.readUInt16LE(header + 8);
  const size = buf.readUInt32LE(header + 18);
  const extra = buf.readUInt16LE(header + 28);
  const start = at + name.length + extra;
  const raw = buf.subarray(start, start + size);
  const xml = (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
  return xml.replace(/<[^>]+>/g, '');
}

const fmt = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
/** The day before the same date one year later: the end of a one-year lease starting on `d`. */
const yearEnd = (d: Date) => new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate() - 1));

/** The landlord details printed in the original contract. */
const UBUMWE = {
  companyName: 'UBUMWE HOUSE LTD', managerName: 'UWIMANA Annonciata', tin: '118631022', phone: '0788483962', email: 'ubumwehouseltd@gmail.com',
  bankName: 'BPR BANK', bankAccount: '4491194467', upi: '1/01/04/03/2785', village: 'Akabeza', cell: 'Kimisagara', sector: 'Kimisagara', district: 'Nyarugenge',
  contractTemplate: 'contract-ubumwe.docx',
};

let w: World;
let contractId: string;

beforeAll(async () => {
  w = await createWorld();
  const b = await makeBuilding(w, 'DOC', 1, 1, 500000);
  await updateBuilding(w.actors.SUPER_ADMIN, b.id, UBUMWE);
  const t = await createTenant(w.actors.PROPERTY_STAFF, {
    fullName: 'MUKAMANA Diane', businessName: 'Diane Boutique Ltd', idNumber: rwandanId(), phone: '+250788337758', email: 'diane@example.rw',
    tin: '123456789', district: 'Nyarugenge', sector: 'Kimisagara', cell: 'Kamuhoza', village: 'Akabeza',
  });
  const c = await createContract(w.actors.MANAGEMENT, { tenantId: t.id, roomId: b.floors[0]!.rooms[0]!.id, startDate: thisMonth(), endDate: endOfMonth(addMonths(thisMonth(), 5)), activate: true, paymentDueDay: 5 });
  contractId = c.id;
});

describe('lease contract document', () => {
  it('fills every bracket of the UBUMWE HOUSE contract from the records', async () => {
    const doc = await contractDocument(w.actors.MANAGEMENT, contractId, 'docx');
    expect(doc.buffer.subarray(0, 2).toString()).toBe('PK');
    const text = docxText(doc.buffer);
    for (const expected of ['Diane Boutique Ltd', 'MUKAMANA Diane', 'Nyarugenge', 'Kimisagara', 'Kamuhoza', 'Akabeza', '0788337758', '123456789', 'diane@example.rw', 'itariki ya 5  ya buri kwezi', 'igihe cy’umwaka umwe (1)', 'yitwa "Ukodesha" (Lessee)']) {
      expect(text, expected).toContain(expected);
    }
    const room = await prisma.room.findFirstOrThrow({ where: { contracts: { some: { id: contractId } } } });
    expect(text).toContain(`umuryango ufite No ${room.number}`);
    // Ingingo 3: rent including 18% VAT = amount before VAT + VAT, to the franc.
    const rent = Number((await prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).monthlyRent);
    const net = Math.round(rent / 1.18);
    const f = (n: number) => `${n.toLocaleString('en-US')} Frw`;
    expect(text).toContain(`amafaranga y’u Rwanda ${f(rent)} Ayo mafaranga akubiyemo ${f(net)} hiyongereyeho ${f(rent - net)} By’umusoro ku nyongeragaciro (TVA) wa 18%`);
    // The written lease always runs one whole year from the start date, whatever the end date in the system.
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(text).toContain(`uhereye ku itariki ya ${fmt(c.startDate)} kugeza kuwa ${fmt(yearEnd(c.startDate))}`);
    expect(text).not.toContain('amezi atandatu');
    expect(text).not.toMatch(/\((Company Name|customer name|Id Number|Room Number)\)/);
    // UBUMWE HOUSE's own details are those of the original, so its wording is kept exactly.
    for (const original of ['UBUMWE HOUSE LTD', 'UWIMANA Annonciata', 'TIN:118631022', 'No:4491194467', 'BPR BANK', 'UPI:  1/01/04/03/2785', 'mu nyubako y’UBUMWE HOUSE ltd', 'Bikorewe i Nyarugenge']) expect(text).toContain(original);
    expect(doc.missing).toEqual([]);
    expect(doc.fileName).toMatch(/^Amasezerano-CTR-\d{4}-\d{6}-MUKAMANA-Diane\.docx$/);
  });

  it('leaves dotted lines where details are missing, and produces a PDF too', async () => {
    const b = await makeBuilding(w, 'DOC2', 1, 1, 300000);
    await updateBuilding(w.actors.SUPER_ADMIN, b.id, { contractTemplate: 'contract-ubumwe.docx' });
    const t = await createTenant(w.actors.PROPERTY_STAFF, { fullName: 'Bare Tenant', idNumber: rwandanId(), phone: '+250788000111' });
    const c = await createContract(w.actors.MANAGEMENT, { tenantId: t.id, roomId: b.floors[0]!.rooms[0]!.id, startDate: thisMonth(), endDate: endOfMonth(thisMonth()), activate: true });
    const doc = await contractDocument(w.actors.MANAGEMENT, c.id, 'docx');
    expect(docxText(doc.buffer)).toContain('Karere ka ……………………………,');
    expect(doc.missing.sort()).toEqual(['cell', 'district', 'email', 'sector', 'tenantTin', 'village']);
    const pdf = await contractDocument(w.actors.MANAGEMENT, c.id, 'pdf');
    expect(pdf.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await prisma.auditLog.count({ where: { action: 'CONTRACT_DOCUMENT_GENERATED', entityId: c.id } })).toBe(2);
  });

  it('prints one year from the renewal’s start in Ingingo 8, and from a corrected start date', async () => {
    const b = await makeBuilding(w, 'REN', 1, 1, 200000);
    await updateBuilding(w.actors.SUPER_ADMIN, b.id, { ...UBUMWE, contractTemplate: 'contract-ubumwe.docx' });
    const t = await createTenant(w.actors.PROPERTY_STAFF, { fullName: 'Renewing Tenant', idNumber: rwandanId(), phone: '+250788000333' });
    const first = await createContract(w.actors.MANAGEMENT, { tenantId: t.id, roomId: b.floors[0]!.rooms[0]!.id, startDate: thisMonth(), endDate: endOfMonth(thisMonth()), activate: true });
    const renewed = await renewContract(w.actors.MANAGEMENT, first.id, { endDate: endOfMonth(addMonths(thisMonth(), 6)) });
    const text = docxText((await contractDocument(w.actors.MANAGEMENT, renewed.id, 'docx')).buffer);
    // Renewed for six months, but the written lease still covers a whole year from the renewal's start.
    expect(text).toContain(`uhereye ku itariki ya ${fmt(addMonths(thisMonth(), 1))} kugeza kuwa ${fmt(yearEnd(addMonths(thisMonth(), 1)))}`);
    await correctContractDates(w.actors.MANAGEMENT, renewed.id, { startDate: addMonths(thisMonth(), 2), endDate: endOfMonth(addMonths(thisMonth(), 7)), reason: 'Tenant starts working later' });
    const corrected = docxText((await contractDocument(w.actors.MANAGEMENT, renewed.id, 'docx')).buffer);
    expect(corrected).toContain(`uhereye ku itariki ya ${fmt(addMonths(thisMonth(), 2))} kugeza kuwa ${fmt(yearEnd(addMonths(thisMonth(), 2)))}`);
  });

  it('is available to anyone who can view contracts, over HTTP', async () => {
    const viewer = await loginAs(w.emails.VIEWER);
    const res = await viewer.get(`/contracts/${contractId}/document?format=pdf`);
    expect([res.status, res.headers['content-type']]).toEqual([200, 'application/pdf']);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="Amasezerano-/);
  });

  it('prints the same contract to PDF only once, and serves repeat downloads from memory', async () => {
    const first = await contractDocument(w.actors.MANAGEMENT, contractId, 'pdf');
    const started = Date.now();
    const again = await contractDocument(w.actors.MANAGEMENT, contractId, 'pdf');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(again.buffer.equals(first.buffer)).toBe(true);
  });

  it('uses the building’s own company as landlord, on the contract and on its reports', async () => {
    const b = await makeBuilding(w, 'IHU', 1, 1, 400000);
    await updateBuilding(w.actors.SUPER_ADMIN, b.id, {
      companyName: 'IHURIRO LTD', managerName: 'KAMANZI Jean', tin: '987654321', phone: '0788000999', email: 'info@ihuriro.rw',
      bankName: 'BK', bankAccount: '100200300', upi: '1/02/03/04/5678', village: 'Rugando', cell: 'Kimihurura', sector: 'Kimihurura', district: 'Gasabo',
      contractTemplate: 'contract-ubumwe.docx',
    });
    const t = await createTenant(w.actors.PROPERTY_STAFF, { fullName: 'Other Tenant', idNumber: rwandanId(), phone: '+250788000222', tin: '118631022' });
    const c = await createContract(w.actors.MANAGEMENT, { tenantId: t.id, roomId: b.floors[0]!.rooms[0]!.id, startDate: thisMonth(), endDate: endOfMonth(thisMonth()), activate: true });
    const text = docxText((await contractDocument(w.actors.MANAGEMENT, c.id, 'docx')).buffer);
    for (const own of ['IHURIRO LTD', 'KAMANZI Jean', 'TIN:987654321', '0788000999', 'info@ihuriro.rw', 'No:100200300', 'iri muri BK,', 'UPI: 1/02/03/04/5678', 'mudugudu wa Rugando, Akagari ka Kimihurura, Umurenge wa Kimihurura, akarere ka Gasabo', 'Bikorewe i Gasabo']) expect(text, own).toContain(own);
    // The tenant's own TIN is kept even though it is the number printed for UBUMWE HOUSE in the original.
    expect(text).toContain('TIN: 118631022 Email');
    expect(text).not.toContain('TIN:118631022');
    for (const other of ['UBUMWE', 'UWIMANA', '4491194467', 'BPR', 'Akabeza', 'ubumwehouseltd']) expect(text, other).not.toContain(other);
    const report = await generateReport(w.actors.MANAGEMENT, 'building-monthly', { from: thisMonth(), to: endOfMonth(thisMonth()), buildingId: b.id });
    expect(report.organization).toBe('IHURIRO LTD');
  });

  it('never gives a tenant another building’s contract: no contract file, no contract', async () => {
    const b = await makeBuilding(w, 'NOD', 1, 1, 300000);
    const t = await createTenant(w.actors.PROPERTY_STAFF, { fullName: 'Third Tenant', idNumber: rwandanId(), phone: '+250788000333' });
    const c = await createContract(w.actors.MANAGEMENT, { tenantId: t.id, roomId: b.floors[0]!.rooms[0]!.id, startDate: thisMonth(), endDate: endOfMonth(thisMonth()), activate: true });
    const err = await contractDocument(w.actors.MANAGEMENT, c.id, 'pdf').catch((e) => e);
    expect([err.status, err.code]).toEqual([409, 'NO_CONTRACT_TEMPLATE']);
    expect(err.message).toContain('No lease contract has been set up for Building NOD yet');
    const admin = await loginAs(w.emails.SUPER_ADMIN);
    expect((await admin.get('/contract-templates')).body.items).toContain('contract-ubumwe.docx');
    const bad = await admin.patch(`/buildings/${b.id}`, { contractTemplate: '../../.env' });
    expect([bad.status, bad.body.error.details.fields.contractTemplate]).toEqual([400, 'Choose one of the contract files available on the server.']);
    // Once its own contract is chosen, the building's company details are used, with dotted lines where missing.
    expect((await admin.patch(`/buildings/${b.id}`, { contractTemplate: 'contract-ubumwe.docx' })).status).toBe(200);
    const doc = await contractDocument(w.actors.MANAGEMENT, c.id, 'docx');
    expect(docxText(doc.buffer)).not.toContain('UBUMWE');
    expect(doc.buildingMissing).toContain('lessorName');
    // A report on that building is headed with the building's name, never another company's.
    expect((await generateReport(w.actors.MANAGEMENT, 'monthly-rent', { from: thisMonth(), to: endOfMonth(thisMonth()), buildingId: b.id })).organization).toBe('Building NOD');
  });
});
