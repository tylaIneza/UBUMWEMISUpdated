import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { addDays, addMonths, endOfMonth, isoDate } from '../src/lib/dates.js';
import { decideApproval, submitApproval } from '../src/services/approvals.js';
import { generateDueCharges } from '../src/services/charges.js';
import { changeContractRent, createContract } from '../src/services/contracts.js';
import { contractCredit, previewPayment } from '../src/services/payments.js';
import { createRoom } from '../src/services/property.js';
import { charges, createWorld, d, failure, lease, makeBuilding, makeTenant, monthsAgo, num, pay, thisMonth, today, type BuildingFixture, type World } from './helpers.js';

let w: World;
let b: BuildingFixture;
let roomNo = 0;

/** A fresh vacant room with exactly the given rent. */
async function room(rent: number) {
  roomNo += 1;
  return createRoom(w.actors.SUPER_ADMIN, { buildingId: b.id, floorId: b.floors[0]!.id, number: `R${roomNo}`, monthlyRent: d(rent) });
}

beforeAll(async () => {
  w = await createWorld();
  b = await makeBuilding(w, 'RT', 1, 0);
});

describe('monthly rent charges', () => {
  it('generates one charge per month at the contract rent, with tenant, room and building recorded', async () => {
    const r = await room(150000);
    const { contract, tenant } = await lease(w, r.id, 2);
    const list = await charges(contract.id);
    expect(list.map((c) => isoDate(c.period))).toEqual([monthsAgo(2), monthsAgo(1), thisMonth()].map(isoDate));
    for (const c of list) {
      expect(num(c.amountDue)).toBe(150000);
      expect(num(c.amountPaid)).toBe(0);
      expect(num(c.balance)).toBe(150000);
      expect([c.tenantId, c.roomId, c.buildingId]).toEqual([tenant.id, r.id, b.id]);
    }
    // Months whose grace period has passed are overdue; the current month is not yet.
    expect(list.map((c) => c.status).slice(0, 2)).toEqual(['OVERDUE', 'OVERDUE']);
  });

  it('is idempotent: running billing again creates no duplicate charges', async () => {
    const before = await prisma.rentCharge.count();
    const run = await generateDueCharges(w.orgId, today());
    expect(run.created).toBe(0);
    expect(await prisma.rentCharge.count()).toBe(before);
  });

  it('prevents a second live charge for the same contract and month at database level', async () => {
    const existing = await prisma.rentCharge.findFirstOrThrow();
    const dup = prisma.rentCharge.create({ data: { ...existing, id: undefined, createdAt: undefined, updatedAt: undefined } });
    expect((await failure(dup)).code).toBe('CHARGE_EXISTS');
  });
});

describe('partial months', () => {
  it('bills a mid-month start and a mid-month end by days, and whole months in between', async () => {
    const r = await room(310000);
    const tenant = await makeTenant(w);
    const start = addDays(monthsAgo(2), 9); // the 10th
    const end = addDays(thisMonth(), 14); // the 15th of this month
    const contract = await createContract(w.actors.MANAGEMENT, { tenantId: tenant.id, roomId: r.id, startDate: start, endDate: end, activate: true });
    const list = await charges(contract.id);
    const dim = (dt: Date) => endOfMonth(dt).getUTCDate();
    expect(list.map((c) => num(c.amountDue))).toEqual([
      Math.round((310000 * (dim(start) - 9)) / dim(start)),
      310000,
      Math.round((310000 * 15) / dim(end)),
    ]);
    expect(list[0]!.note).toBe(`Prorated: ${dim(start) - 9} of ${dim(start)} days`);
    expect(list[1]!.note).toBeNull();
    // The first due date is never before the tenant moved in.
    expect(isoDate(list[0]!.dueDate)).toBe(isoDate(start));
  });

  it('bills full months when proration is switched off in settings', async () => {
    await prisma.organization.update({ where: { id: w.orgId }, data: { proratePartialMonths: false } });
    const r = await room(310000);
    const tenant = await makeTenant(w);
    const contract = await createContract(w.actors.MANAGEMENT, { tenantId: tenant.id, roomId: r.id, startDate: addDays(monthsAgo(1), 19), endDate: addDays(thisMonth(), 14), activate: true });
    expect((await charges(contract.id)).map((c) => num(c.amountDue))).toEqual([310000, 310000]);
    await prisma.organization.update({ where: { id: w.orgId }, data: { proratePartialMonths: true } });
  });
});

describe('partial, full and over-payment', () => {
  it('records a partial payment with the correct remaining balance', async () => {
    const { contract } = await lease(w, (await room(150000)).id);
    await pay(w, 'CASHIER', contract.id, 100000);
    const [c] = await charges(contract.id);
    expect([num(c!.amountPaid), num(c!.balance), c!.status]).toEqual([100000, 50000, 'PARTIAL']);
  });

  it('marks the charge paid with zero balance on full payment', async () => {
    const { contract } = await lease(w, (await room(150000)).id);
    await pay(w, 'CASHIER', contract.id, 150000);
    const [c] = await charges(contract.id);
    expect([num(c!.amountPaid), num(c!.balance), c!.status]).toEqual([150000, 0, 'PAID']);
  });

  it('accepts several payments against one charge and keeps each one visible', async () => {
    const { contract } = await lease(w, (await room(200000)).id);
    for (const amount of [50000, 75000, 75000]) await pay(w, 'CASHIER', contract.id, amount);
    const [c] = await charges(contract.id);
    expect([num(c!.amountPaid), num(c!.balance), c!.status]).toEqual([200000, 0, 'PAID']);
    const payments = await prisma.payment.findMany({ where: { contractId: contract.id }, orderBy: { createdAt: 'asc' }, include: { receipt: true } });
    expect(payments.map((p) => num(p.amount))).toEqual([50000, 75000, 75000]);
    expect(new Set(payments.map((p) => p.receipt!.receiptNumber)).size).toBe(3);
  });

  it('does not silently accept an overpayment', async () => {
    const { contract } = await lease(w, (await room(150000)).id);
    const err = await failure(pay(w, 'CASHIER', contract.id, 200000));
    expect(err.code).toBe('OVERPAYMENT');
    expect(err.message).toBe('Payment exceeds current outstanding balance by 50,000 RWF.');
    expect(num((err.details as { excess: unknown }).excess)).toBe(50000);
    expect(num((err.details as { outstanding: unknown }).outstanding)).toBe(150000);
    // Nothing at all was written.
    expect(await prisma.payment.count({ where: { contractId: contract.id } })).toBe(0);
    expect(num((await charges(contract.id))[0]!.amountPaid)).toBe(0);
  });

  it('shows the exact allocation before anything is saved', async () => {
    const { contract } = await lease(w, (await room(150000)).id, 2);
    await pay(w, 'CASHIER', contract.id, 250000); // month 1 paid, month 2 has 50,000 left
    const { plan } = await previewPayment(w.actors.CASHIER, { contractId: contract.id, amount: d(175000) });
    expect(num(plan.outstandingBefore)).toBe(200000);
    expect(plan.lines.map((l) => [num(l.balanceBefore), num(l.applied), num(l.balanceAfter)])).toEqual([[50000, 50000, 0], [150000, 125000, 25000]]);
    expect(num(plan.outstandingAfter)).toBe(25000);
    expect(await prisma.payment.count({ where: { contractId: contract.id } })).toBe(1);
  });
});

describe('advance payments', () => {
  it('lets an authorised user pay future months, identifying each month covered', async () => {
    const { contract } = await lease(w, (await room(150000)).id);
    const payment = await pay(w, 'ACCOUNTANT', contract.id, 450000, { overpayment: 'ADVANCE' });
    const list = await charges(contract.id);
    expect(list.map((c) => isoDate(c.period))).toEqual([thisMonth(), addMonths(thisMonth(), 1), addMonths(thisMonth(), 2)].map(isoDate));
    expect(list.every((c) => c.status === 'PAID' && num(c.balance) === 0)).toBe(true);
    expect(payment.allocations).toHaveLength(3);
    expect([num(payment.allocatedAmount), num(payment.unallocatedAmount)]).toEqual([450000, 0]);
    // Billing later does not charge those months again.
    expect((await generateDueCharges(w.orgId, today())).created).toBe(0);
  });

  it('refuses advance payments from a role that is not authorised', async () => {
    const { contract } = await lease(w, (await room(150000)).id);
    const err = await failure(pay(w, 'CASHIER', contract.id, 300000, { overpayment: 'ADVANCE' }));
    expect(err.status).toBe(403);
    expect(await prisma.payment.count({ where: { contractId: contract.id } })).toBe(0);
  });

  it('never loses an excess that cannot be matched to a month: it is held as visible credit', async () => {
    const tenant = await makeTenant(w);
    const r = await room(150000);
    const contract = await createContract(w.actors.MANAGEMENT, { tenantId: tenant.id, roomId: r.id, startDate: thisMonth(), endDate: endOfMonth(thisMonth()), activate: true });
    const payment = await pay(w, 'ACCOUNTANT', contract.id, 200000, { overpayment: 'ADVANCE' });
    expect([num(payment.amount), num(payment.allocatedAmount), num(payment.unallocatedAmount)]).toEqual([200000, 150000, 50000]);
    expect(num(await contractCredit(prisma, contract.id))).toBe(50000);
  });
});

describe('rent changes and history', () => {
  it('applies a rent increase to future months only and keeps old charges unchanged', async () => {
    const { contract } = await lease(w, (await room(250000)).id, 1);
    const next = addMonths(thisMonth(), 1);
    await changeContractRent(w.actors.MANAGEMENT, contract.id, { amount: d(275000), effectiveFrom: next, reason: 'Annual increase' });

    const rates = await prisma.contractRentRate.findMany({ where: { contractId: contract.id }, orderBy: { effectiveFrom: 'asc' } });
    expect(rates.map((r) => [num(r.amount), isoDate(r.effectiveFrom), r.effectiveTo ? isoDate(r.effectiveTo) : null])).toEqual([
      [250000, isoDate(monthsAgo(1)), isoDate(addDays(next, -1))],
      [275000, isoDate(next), null],
    ]);
    expect((await charges(contract.id)).map((c) => num(c.amountDue))).toEqual([250000, 250000]);

    // Paying ahead bills next month at the new rate; the earlier months keep the old one.
    await pay(w, 'ACCOUNTANT', contract.id, 250000 + 250000 + 275000, { overpayment: 'ADVANCE' });
    expect((await charges(contract.id)).map((c) => [num(c.amountDue), c.status])).toEqual([[250000, 'PAID'], [250000, 'PAID'], [275000, 'PAID']]);
  });

  it('rejects a rent change that would reach back into months already billed', async () => {
    const { contract } = await lease(w, (await room(100000)).id, 1);
    const err = await failure(changeContractRent(w.actors.MANAGEMENT, contract.id, { amount: d(120000), effectiveFrom: thisMonth(), reason: 'x' }));
    expect(err.code).toBe('RETROACTIVE_RENT');
    const frozen = await prisma.contractRentRate.findFirstOrThrow({ where: { contractId: contract.id } });
    expect((await failure(prisma.contractRentRate.update({ where: { id: frozen.id }, data: { amount: 1 } }))).message).toMatch(/cannot be changed/i);
  });

  it('allows a tenant-specific rent only with authority and a reason, and audits it', async () => {
    const r = await room(200000);
    const tenant = await makeTenant(w);
    const base = { tenantId: tenant.id, roomId: r.id, startDate: thisMonth(), endDate: endOfMonth(addMonths(thisMonth(), 11)), activate: true, monthlyRent: d(180000) };
    expect((await failure(createContract(w.actors.PROPERTY_STAFF, { ...base, rentOverrideReason: 'friend' }))).status).toBe(403);
    expect((await failure(createContract(w.actors.MANAGEMENT, base))).code).toBe('REASON_REQUIRED');
    const contract = await createContract(w.actors.MANAGEMENT, { ...base, rentOverrideReason: 'Anchor tenant agreement' });
    expect([num(contract.monthlyRent), num(contract.roomRentAtSigning)]).toEqual([180000, 200000]);
    expect(num((await charges(contract.id))[0]!.amountDue)).toBe(180000);
    // The room's own rent is untouched.
    expect(num((await prisma.room.findUniqueOrThrow({ where: { id: r.id } })).monthlyRent)).toBe(200000);
    expect(await prisma.auditLog.count({ where: { action: 'CONTRACT_RENT_OVERRIDE', entityId: contract.id } })).toBe(1);
  });
});

describe('approved adjustments', () => {
  it('applies a discount only after approval, without altering the original rent', async () => {
    const { contract } = await lease(w, (await room(200000)).id);
    const request = await submitApproval(w.actors.ACCOUNTANT, {
      type: 'RENT_ADJUSTMENT', entityType: 'Contract', entityId: contract.id, summary: 'Discount 20,000', reason: 'Agreed discount',
      payload: { type: 'DISCOUNT', amount: '20000.00', effectiveFrom: isoDate(thisMonth()), effectiveTo: null },
    });
    expect(request.executed).toBe(false);
    expect(num((await charges(contract.id))[0]!.amountDue)).toBe(200000);

    await decideApproval(w.actors.MANAGEMENT, request.approval.id, true);
    const [c] = await charges(contract.id);
    expect([num(c!.baseAmount), num(c!.adjustmentAmount), num(c!.amountDue), num(c!.balance)]).toEqual([200000, -20000, 180000, 180000]);
    expect(num((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).monthlyRent)).toBe(200000);
    const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.approval.id } });
    expect([approval.status, approval.decidedById, approval.requestedById]).toEqual(['APPROVED', w.actors.MANAGEMENT.userId, w.actors.ACCOUNTANT.userId]);
    expect((await failure(decideApproval(w.actors.MANAGEMENT, request.approval.id, true))).code).toBe('ALREADY_DECIDED');
  });

  it('waives a debt through approval and records who approved it', async () => {
    const { contract } = await lease(w, (await room(100000)).id);
    await pay(w, 'CASHIER', contract.id, 70000);
    const [charge] = await charges(contract.id);
    const request = await submitApproval(w.actors.ACCOUNTANT, { type: 'DEBT_WAIVER', entityType: 'RentCharge', entityId: charge!.id, summary: 'Waive 30,000', reason: 'Flood damage', payload: { chargeId: charge!.id, amount: '30000.00' } });
    const tooMuch = await failure(submitApproval(w.actors.MANAGEMENT, { type: 'DEBT_WAIVER', entityType: 'RentCharge', entityId: charge!.id, summary: 'x', reason: 'x', payload: { chargeId: charge!.id, amount: '99999.00' } }));
    expect(tooMuch.status).toBeGreaterThanOrEqual(400);
    await decideApproval(w.actors.MANAGEMENT, request.approval.id, true);
    const [after] = await charges(contract.id);
    expect([num(after!.amountPaid), num(after!.amountWaived), num(after!.balance), after!.status]).toEqual([70000, 30000, 0, 'PAID']);
  });

  it('leaves everything untouched when a request is rejected', async () => {
    const { contract } = await lease(w, (await room(100000)).id);
    const [charge] = await charges(contract.id);
    const request = await submitApproval(w.actors.ACCOUNTANT, { type: 'DEBT_WAIVER', entityType: 'RentCharge', entityId: charge!.id, summary: 'Waive', reason: 'Asked nicely', payload: { chargeId: charge!.id, amount: '100000.00' } });
    expect((await failure(decideApproval(w.actors.MANAGEMENT, request.approval.id, false))).code).toBe('REASON_REQUIRED');
    await decideApproval(w.actors.MANAGEMENT, request.approval.id, false, 'Not justified');
    expect(num((await charges(contract.id))[0]!.balance)).toBe(100000);
  });
});
