import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { createMessage, reminderList, sendReminders } from '../src/services/messages.js';
import { testSmsOutbox } from '../src/services/sms.js';
import { createWorld, failure, lease, loginAs, makeBuilding, pay, rwandanId, tenantDetails, today, type BuildingFixture, type World } from './helpers.js';

let w: World;
let b: BuildingFixture;

beforeAll(async () => {
  w = await createWorld();
  b = await makeBuilding(w, 'SM', 1, 3, 100000);
});
afterAll(() => {
  delete process.env.SMS_CAPTURE;
});

describe('tenant phone numbers', () => {
  it('requires a phone number and stores Rwandan numbers as +250…', async () => {
    const staff = await loginAs(w.emails.PROPERTY_STAFF);
    const missing = await staff.post('/tenants', { fullName: 'No Phone', idNumber: rwandanId(), ...tenantDetails() });
    expect([missing.status, Object.keys(missing.body.error.details.fields)]).toEqual([400, ['phone']]);
    const bad = await staff.post('/tenants', { fullName: 'Bad Phone', idNumber: rwandanId(), phone: '2345345678', ...tenantDetails() });
    expect(bad.body.error.details.fields.phone).toMatch(/Rwandan number such as/);
    const ok = await staff.post('/tenants', { fullName: 'Good Phone', idNumber: rwandanId(), phone: '078 812 3456', ...tenantDetails() });
    expect([ok.status, ok.body.phone]).toEqual([201, '+250788123456']);
    const foreign = await staff.post('/tenants', { fullName: 'Kampala Trader', idType: 'PASSPORT', idNumber: 'B1234567', phone: '+256 772 123456', ...tenantDetails() });
    expect(foreign.body.phone).toBe('+256772123456');
    // Searching by the local form still finds the tenant.
    expect((await staff.get('/tenants?q=0788123')).body.items.map((t: any) => t.fullName)).toContain('Good Phone');
  });
});

describe('payment reminders', () => {
  it('lists everyone who owes rent, with the reminder written from their real balance', async () => {
    const owing = await lease(w, b.floors[0]!.rooms[0]!.id, 1);
    const partly = await lease(w, b.floors[0]!.rooms[1]!.id);
    const paidUp = await lease(w, b.floors[0]!.rooms[2]!.id);
    await pay(w, 'CASHIER', partly.contract.id, 40000);
    await pay(w, 'CASHIER', paidUp.contract.id, b.floors[0]!.rooms[2]!.rent);
    const list = await reminderList(w.actors.CASHIER, {});
    const names = list.items.map((i) => i.fullName);
    expect(names).toContain(owing.tenant.fullName);
    expect(names).not.toContain(paidUp.tenant.fullName);
    const row = list.items.find((i) => i.contractId === owing.contract.id)!;
    // Only months whose due date has come are reminded about (this month's too once its due day is reached).
    const dueMonths = await prisma.rentCharge.count({ where: { contractId: owing.contract.id, dueDate: { lte: today() } } });
    expect(row.balance).toBe(b.floors[0]!.rooms[0]!.rent * dueMonths);
    expect(row.message).toContain(`Dear ${owing.tenant.fullName}`);
    expect(row.message).toContain((b.floors[0]!.rooms[0]!.rent * dueMonths).toLocaleString('en-US'));
    expect(row.phone).toMatch(/^\+250/);
    expect(list.smsConfigured).toBe(false);
    // Listing sends nothing and logs nothing.
    expect(await prisma.messageLog.count()).toBe(0);
  });

  it('never claims an SMS was sent when no provider is configured', async () => {
    expect((await failure(sendReminders(w.actors.CASHIER, [(await prisma.contract.findFirstOrThrow()).id]))).code).toBe('CHANNEL_UNAVAILABLE');
    const t = await prisma.tenant.findFirstOrThrow();
    expect((await failure(createMessage(w.actors.CASHIER, { tenantId: t.id, template: 'PAYMENT_REMINDER', channel: 'SMS' }))).code).toBe('CHANNEL_UNAVAILABLE');
    expect(await prisma.messageLog.count({ where: { status: 'SENT' } })).toBe(0);
  });

  it('sends one SMS per selected tenant to their phone number when a provider is configured, and logs each', async () => {
    process.env.SMS_CAPTURE = 'true';
    const list = await reminderList(w.actors.CASHIER, {});
    const result = await sendReminders(w.actors.CASHIER, list.items.map((i) => i.contractId));
    expect(result).toMatchObject({ sent: list.items.length, failed: 0 });
    expect(testSmsOutbox.map((m) => m.to).sort()).toEqual(list.items.map((i) => i.phone).sort());
    expect(testSmsOutbox[0]!.text).toMatch(/^Dear /);
    expect(await prisma.messageLog.count({ where: { channel: 'SMS', status: 'SENT', template: 'PAYMENT_REMINDER' } })).toBe(list.items.length);
    const again = await reminderList(w.actors.CASHIER, {});
    expect(again.items.every((i) => i.lastRemindedAt !== null)).toBe(true);
    expect(again.smsConfigured).toBe(true);
  });

  it('is limited to roles that may message tenants', async () => {
    const viewer = await loginAs(w.emails.VIEWER);
    expect((await viewer.get('/messages/reminders')).status).toBe(403);
    expect((await viewer.post('/messages/reminders/send', { contractIds: [] })).status).toBe(403);
  });
});
