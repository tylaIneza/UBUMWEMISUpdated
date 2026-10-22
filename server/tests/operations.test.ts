import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { addDays, isoDate } from '../src/lib/dates.js';
import { decideApproval, submitApproval } from '../src/services/approvals.js';
import { depositHeld, recordDepositPayment } from '../src/services/deposits.js';
import { commitImport, importTemplate, previewImport, IMPORT_SHEETS, type SheetName } from '../src/services/importer.js';
import { createMessage } from '../src/services/messages.js';
import { listNotifications } from '../src/services/notifications.js';
import { runDailyJobs } from '../src/services/scheduler.js';
import { globalSearch } from '../src/services/search.js';
import { timeline } from '../src/services/timeline.js';
import { charges, createWorld, d, failure, lease, makeBuilding, monthsAgo, num, pay, thisMonth, today, type BuildingFixture, type World } from './helpers.js';

let w: World;
let b: BuildingFixture;

beforeAll(async () => {
  w = await createWorld();
  b = await makeBuilding(w, 'OP', 1, 4, 100000);
});

async function workbook(sheets: Partial<Record<SheetName, Array<Record<string, string | number>>>>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets) as Array<[SheetName, Array<Record<string, string | number>>]>) {
    const ws = wb.addWorksheet(name);
    ws.addRow([...IMPORT_SHEETS[name]]);
    for (const row of rows) ws.addRow(IMPORT_SHEETS[name].map((h) => row[h] ?? ''));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('importing existing records', () => {
  const end = isoDate(addDays(today(), 300));
  type Rows = Array<Record<string, string | number>>;
  const good = (): Record<SheetName, Rows> => ({
    Buildings: [{ code: 'IMP', name: 'Imported House', address: 'KN 5' }],
    Floors: [{ buildingCode: 'IMP', name: 'Ground', level: 0 }, { buildingCode: 'IMP', name: 'First', level: 1 }],
    Rooms: [{ buildingCode: 'IMP', floorName: 'Ground', roomNumber: 'A1', monthlyRent: 120000, depositRequired: 120000 }, { buildingCode: 'IMP', floorName: 'First', roomNumber: 'A2', monthlyRent: '95,000' }],
    Tenants: [{ fullName: 'Imported Tenant', idType: 'PASSPORT', idNumber: 'IMP-0001', phone: '+250788700001' }],
    Contracts: [{ tenantIdNumber: 'IMP-0001', buildingCode: 'IMP', roomNumber: 'A1', startDate: isoDate(monthsAgo(8)), endDate: end, openingBalance: 60000 }],
  });

  it('provides a template with one sheet per record type', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await importTemplate()) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Instructions', 'Buildings', 'Floors', 'Rooms', 'Tenants', 'Contracts']);
  });

  it('previews without saving and lists every problem row', async () => {
    const bad = good();
    bad.Rooms.push({ buildingCode: 'IMP', floorName: 'Nowhere', roomNumber: 'A3', monthlyRent: 'lots' });
    bad.Rooms.push({ buildingCode: 'IMP', floorName: 'Ground', roomNumber: 'A1', monthlyRent: 5 });
    bad.Contracts.push({ tenantIdNumber: 'GHOST', buildingCode: 'IMP', roomNumber: 'A1', startDate: '2026-02-30', endDate: end, openingBalance: 0 });
    const file = { fileName: 'import.xlsx', buffer: await workbook(bad) };
    const preview = await previewImport(w.actors.MANAGEMENT, file);
    expect(preview.canCommit).toBe(false);
    const errors = preview.sheets.flatMap((s) => s.rows.flatMap((r) => r.errors)).join(' | ');
    expect(errors).toMatch(/Floor "Nowhere" does not exist/);
    expect(errors).toMatch(/not a valid amount/);
    expect(errors).toMatch(/appears more than once/);
    expect(errors).toMatch(/GHOST does not exist/);
    expect(errors).toMatch(/not a valid date/);
    expect(errors).toMatch(/Another contract in this file already takes this room/);
    expect(await prisma.building.count({ where: { code: 'IMP' } })).toBe(0);
    // A bad file is refused as a whole — nothing is imported, not even the valid rows.
    expect((await failure(commitImport(w.actors.MANAGEMENT, file))).code).toBe('IMPORT_HAS_ERRORS');
    expect(await prisma.building.count({ where: { code: 'IMP' } })).toBe(0);
    expect(await prisma.tenant.count({ where: { idNumber: 'IMP0001' } })).toBe(0);
  });

  it('imports a valid file in one step, bills from the current month and carries the opening balance', async () => {
    const file = { fileName: 'import.xlsx', buffer: await workbook(good()) };
    expect((await previewImport(w.actors.MANAGEMENT, file)).canCommit).toBe(true);
    expect(await commitImport(w.actors.MANAGEMENT, file)).toEqual({ buildings: 1, floors: 2, rooms: 2, tenants: 1, contracts: 1 });

    const contract = await prisma.contract.findFirstOrThrow({ where: { tenant: { idNumber: 'IMP0001' } }, include: { room: true } });
    expect([contract.status, contract.room.status, num(contract.monthlyRent), num(contract.depositAmount)]).toEqual(['ACTIVE', 'OCCUPIED', 120000, 120000]);
    // Eight months of history were settled in the old records: only the carried balance and the current month are owed.
    const list = await charges(contract.id);
    expect(list.map((c) => [isoDate(c.period), num(c.amountDue), c.note])).toEqual([[isoDate(monthsAgo(1)), 60000, 'Opening balance carried over at import'], [isoDate(thisMonth()), 120000, null]]);
    await pay(w, 'CASHIER', contract.id, 60000);
    expect((await charges(contract.id))[0]!.status).toBe('PAID');
    expect(await prisma.auditLog.count({ where: { action: 'DATA_IMPORTED' } })).toBe(1);
  });

  it('skips rows that already exist instead of overwriting them, and blocks rooms that are taken', async () => {
    const again = { fileName: 'import.xlsx', buffer: await workbook(good()) };
    const preview = await previewImport(w.actors.MANAGEMENT, again);
    expect(preview.sheets.filter((s) => s.name !== 'Contracts').every((s) => s.toCreate === 0 && s.errors === 0 && s.toSkip === s.rows.length)).toBe(true);
    expect(preview.sheets.find((s) => s.name === 'Contracts')!.rows[0]!.errors.join()).toMatch(/already occupied/);
    expect(num((await prisma.room.findFirstOrThrow({ where: { number: 'A1' } })).monthlyRent)).toBe(120000);
  });

  it('accepts CSV for one record type and rejects unknown formats', async () => {
    const csv = Buffer.from('﻿fullName,idNumber,phone,email,businessName,address\n"Csv, Tenant",1 1985 8 0012345 6 01,+250788700002,,,"Kigali, Rwanda"\n');
    expect((await failure(previewImport(w.actors.MANAGEMENT, { fileName: 't.csv', buffer: csv }))).code).toBe('IMPORT_FORMAT');
    const preview = await previewImport(w.actors.MANAGEMENT, { fileName: 't.csv', buffer: csv, csvSheet: 'Tenants' });
    expect(preview.sheets[0]!.rows[0]!.data).toMatchObject({ fullName: 'Csv, Tenant', address: 'Kigali, Rwanda' });
    expect(preview.canCommit).toBe(true);
    expect((await failure(previewImport(w.actors.MANAGEMENT, { fileName: 'x.pdf', buffer: Buffer.from('%PDF-') }))).code).toBe('IMPORT_FORMAT');
  });
});

describe('deposits, messages, scheduler, search', () => {
  it('refunds a deposit only after approval and never beyond what is held', async () => {
    const { contract } = await lease(w, b.floors[0]!.rooms[0]!.id, 0, { depositAmount: d(100000) });
    await recordDepositPayment(w.actors.ACCOUNTANT, { contractId: contract.id, amount: d(100000), methodId: w.methods.CASH! });
    const refund = (amount: string) => ({ type: 'DEPOSIT_REFUND' as const, entityType: 'Contract', entityId: contract.id, summary: 'Refund', reason: 'Tenant left', payload: { amount, methodId: null, reference: null } });
    expect((await failure(submitApproval(w.actors.ACCOUNTANT, refund('150000.00')))).code).toBe('DEPOSIT_EXCEEDED');
    const request = await submitApproval(w.actors.ACCOUNTANT, refund('80000.00'));
    expect(num(await depositHeld(prisma, contract.id))).toBe(100000);
    await decideApproval(w.actors.MANAGEMENT, request.approval.id, true);
    expect(num(await depositHeld(prisma, contract.id))).toBe(20000);
  });

  it('writes reminders from the live balance and never pretends to send through an unconfigured channel', async () => {
    const room = b.floors[0]!.rooms[1]!;
    const { contract, tenant } = await lease(w, room.id);
    const reminder = await createMessage(w.actors.CASHIER, { tenantId: tenant.id, template: 'PAYMENT_REMINDER', channel: 'COPY' });
    expect(reminder.status).toBe('GENERATED');
    expect(reminder.body).toContain(`Dear ${tenant.fullName}`);
    expect(reminder.body).toContain(`Room ${room.number}`);
    expect(reminder.body).toContain(`${room.rent.toLocaleString('en-US')} RWF`);
    for (const channel of ['SMS', 'WHATSAPP', 'EMAIL'] as const) {
      expect((await failure(createMessage(w.actors.CASHIER, { tenantId: tenant.id, template: 'PAYMENT_REMINDER', channel }))).code).toBe('CHANNEL_UNAVAILABLE');
    }
    expect(await prisma.messageLog.count({ where: { tenantId: tenant.id, status: 'SENT' } })).toBe(0);
    await pay(w, 'CASHIER', contract.id, room.rent);
    expect((await failure(createMessage(w.actors.CASHIER, { tenantId: tenant.id, template: 'PAYMENT_REMINDER', channel: 'COPY' }))).code).toBe('NOTHING_DUE');
  });

  it('daily job bills, flags overdue and expiring items, and notifies the right people once', async () => {
    const { contract } = await lease(w, b.floors[0]!.rooms[2]!.id, 2);
    await prisma.contract.update({ where: { id: contract.id }, data: { endDate: addDays(today(), 10) } });
    const first = await runDailyJobs(w.orgId);
    expect(first.expiring).toBe(1);
    const cashier = await listNotifications(w.actors.CASHIER.userId, {}, { page: 1, pageSize: 100 });
    const manager = await listNotifications(w.actors.MANAGEMENT.userId, {}, { page: 1, pageSize: 100 });
    expect(manager.items.some((n) => n.category === 'CONTRACT' && n.entityId === contract.id)).toBe(true);
    expect(cashier.items.some((n) => n.category === 'CONTRACT')).toBe(false); // cashiers do not manage contracts
    expect(manager.items.some((n) => n.title === 'Missing EBM references')).toBe(true);
    const viewer = await listNotifications(w.actors.VIEWER.userId, {}, { page: 1, pageSize: 100 });
    expect(viewer.total).toBe(0);
    // Running again creates nothing new.
    const before = await prisma.notification.count();
    const second = await runDailyJobs(w.orgId);
    expect([second.chargesCreated, second.newlyOverdue, await prisma.notification.count()]).toEqual([0, 0, before]);
  });

  it('search finds records by name, phone, room, contract and receipt — limited to what the role may see', async () => {
    const { contract, tenant } = await lease(w, b.floors[0]!.rooms[3]!.id);
    const payment = await pay(w, 'CASHIER', contract.id, 5000, { methodId: w.methods.BANK, reference: 'BKREF-99887' });
    const types = async (q: string, role: keyof World['actors'] = 'MANAGEMENT') => (await globalSearch(w.actors[role], q)).map((h) => `${h.type}:${h.id}`);
    expect(await types(tenant.fullName)).toContain(`tenant:${tenant.id}`);
    expect(await types(tenant.phone!.slice(-6))).toContain(`tenant:${tenant.id}`);
    expect(await types(contract.contractNumber)).toContain(`contract:${contract.id}`);
    expect(await types(payment.receipt!.receiptNumber)).toContain(`payment:${payment.id}`);
    expect(await types('BKREF-998')).toContain(`payment:${payment.id}`);
    expect(await types(b.floors[0]!.rooms[3]!.number)).toContain(`room:${b.floors[0]!.rooms[3]!.id}`);
    expect(await types('BKREF-998', 'PROPERTY_STAFF')).toEqual([]);
    const hit = (await globalSearch(w.actors.MANAGEMENT, payment.receipt!.receiptNumber))[0]!;
    expect(hit.context).toContain(tenant.fullName);
    const history = await timeline(w.orgId, 'Tenant', tenant.id);
    expect(history.map((h) => h.action)).toEqual(expect.arrayContaining(['TENANT_CREATED', 'CONTRACT_CREATED', 'PAYMENT_RECORDED']));
  });
});
