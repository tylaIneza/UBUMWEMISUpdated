import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { addDays, isoDate } from '../src/lib/dates.js';
import { decideApproval, submitApproval } from '../src/services/approvals.js';
import { depositHeld, recordDepositPayment } from '../src/services/deposits.js';
import { recordPayment, verifyPayment } from '../src/services/payments.js';
import { closePeriod, reopenPeriod } from '../src/services/periods.js';
import { createRoom } from '../src/services/property.js';
import { reconcile } from '../src/services/reports.js';
import { charges, createWorld, d, endOfThisMonth, failure, lease, makeBuilding, monthsAgo, num, pay, thisMonth, today, uid, unpaidThisMonth, type BuildingFixture, type World } from './helpers.js';

let w: World;
let b: BuildingFixture;
let roomNo = 0;

async function room(rent: number) {
  roomNo += 1;
  return createRoom(w.actors.SUPER_ADMIN, { buildingId: b.id, floorId: b.floors[0]!.id, number: `P${roomNo}`, monthlyRent: d(rent) });
}

async function reverse(paymentId: string, reason = 'Entered against the wrong tenant') {
  const request = await submitApproval(w.actors.CASHIER, { type: 'PAYMENT_REVERSAL', entityType: 'Payment', entityId: paymentId, summary: 'Reverse payment', reason, payload: {} });
  return { request, decide: () => decideApproval(w.actors.MANAGEMENT, request.approval.id, true) };
}

beforeAll(async () => {
  w = await createWorld();
  b = await makeBuilding(w, 'PY', 1, 0);
});

describe('allocation', () => {
  it('applies a payment to the oldest outstanding month first', async () => {
    const { contract } = await lease(w, (await room(100000)).id, 2);
    const payment = await pay(w, 'CASHIER', contract.id, 150000);
    expect((await charges(contract.id)).map((c) => [num(c.amountPaid), num(c.balance), c.status])).toEqual([[100000, 0, 'PAID'], [50000, 50000, 'PARTIAL'], [0, 100000, unpaidThisMonth()]]);
    expect(payment.allocations.map((a) => num(a.amount)).sort()).toEqual([100000, 50000].sort());
    expect(num(payment.allocatedAmount)).toBe(150000);
  });

  it('creates the payment, allocations, receipt and pending invoice together', async () => {
    const { contract, tenant } = await lease(w, (await room(80000)).id);
    const p = await pay(w, 'CASHIER', contract.id, 80000, { methodId: w.methods.MOBILE_MONEY, reference: 'MOMO-778899' });
    expect(p.receipt?.receiptNumber).toMatch(/^REC-\d{4}-\d{6}$/);
    expect(p.invoice?.status).toBe('PENDING');
    expect([p.tenantId, p.contractId, p.buildingId, p.recordedById]).toEqual([tenant.id, contract.id, b.id, w.actors.CASHIER.userId]);
    expect(isoDate(p.businessDate)).toBe(isoDate(today()));
    const snapshot = p.receipt!.snapshot as { lines: Array<{ applied: string }>; amount: string };
    expect(snapshot.amount).toBe('80000.00');
    expect(snapshot.lines).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: 'PAYMENT_RECORDED', entityId: p.id, userId: w.actors.CASHIER.userId } })).toBe(1);
  });

  it('issues gap-free, strictly increasing receipt numbers', async () => {
    const { contract } = await lease(w, (await room(90000)).id);
    const first = await pay(w, 'CASHIER', contract.id, 10000);
    await failure(pay(w, 'CASHIER', contract.id, 999999)); // a rejected payment must not consume a number
    const second = await pay(w, 'CASHIER', contract.id, 10000);
    const n = (s: string) => Number(s.split('-')[2]);
    expect(n(second.receipt!.receiptNumber)).toBe(n(first.receipt!.receiptNumber) + 1);
  });

  it('requires a transaction reference for bank and mobile money, and rejects a reused one', async () => {
    const { contract } = await lease(w, (await room(60000)).id);
    expect((await failure(pay(w, 'CASHIER', contract.id, 10000, { methodId: w.methods.BANK }))).code).toBe('REFERENCE_REQUIRED');
    await pay(w, 'CASHIER', contract.id, 10000, { methodId: w.methods.BANK, reference: 'BK-0001' });
    expect((await failure(pay(w, 'CASHIER', contract.id, 10000, { methodId: w.methods.BANK, reference: 'BK-0001' }))).code).toBe('DUPLICATE_REFERENCE');
    expect(await prisma.payment.count({ where: { contractId: contract.id } })).toBe(1);
  });
});

describe('duplicate submission protection', () => {
  it('returns the original payment when the same submission is sent twice', async () => {
    const { contract } = await lease(w, (await room(100000)).id);
    const input = { contractId: contract.id, amount: d(40000), methodId: w.methods.CASH!, idempotencyKey: uid('dup') };
    const first = await recordPayment(w.actors.CASHIER, input);
    const second = await recordPayment(w.actors.CASHIER, input);
    expect(second).toEqual({ paymentId: first.paymentId, replayed: true });
    expect(await prisma.payment.count({ where: { contractId: contract.id } })).toBe(1);
    expect(num((await charges(contract.id))[0]!.amountPaid)).toBe(40000);
  });

  it('creates exactly one payment when CONFIRM is double-clicked (concurrent identical requests)', async () => {
    const { contract } = await lease(w, (await room(100000)).id);
    const input = { contractId: contract.id, amount: d(100000), methodId: w.methods.CASH!, idempotencyKey: uid('race') };
    const results = await Promise.all([1, 2, 3, 4].map(() => recordPayment(w.actors.CASHIER, input)));
    expect(new Set(results.map((r) => r.paymentId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await prisma.payment.count({ where: { contractId: contract.id } })).toBe(1);
    expect(await prisma.receipt.count({ where: { payment: { contractId: contract.id } } })).toBe(1);
    expect(num((await charges(contract.id))[0]!.balance)).toBe(0);
  });

  it('keeps balances correct when two different payments race on the same contract', async () => {
    const { contract } = await lease(w, (await room(100000)).id);
    const attempts = await Promise.allSettled([70000, 70000].map((amount) => recordPayment(w.actors.CASHIER, { contractId: contract.id, amount: d(amount), methodId: w.methods.CASH!, idempotencyKey: uid('two') })));
    // Only one can fit: the second would overpay and must be refused, not squeezed in.
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    expect((await charges(contract.id)).map((c) => [num(c.amountPaid), num(c.balance)])).toEqual([[70000, 30000]]);
  });

  it('refuses a reused submission key that carries a different amount', async () => {
    const { contract } = await lease(w, (await room(100000)).id);
    const key = uid('mis');
    await recordPayment(w.actors.CASHIER, { contractId: contract.id, amount: d(10000), methodId: w.methods.CASH!, idempotencyKey: key });
    const err = await failure(recordPayment(w.actors.CASHIER, { contractId: contract.id, amount: d(20000), methodId: w.methods.CASH!, idempotencyKey: key }));
    expect(err.code).toBe('IDEMPOTENCY_MISMATCH');
  });
});

describe('immutable ledger and reversal', () => {
  it('blocks editing or deleting financial records, even with direct database access', async () => {
    const { contract } = await lease(w, (await room(100000)).id);
    const p = await pay(w, 'CASHIER', contract.id, 100000);
    expect((await failure(prisma.payment.update({ where: { id: p.id }, data: { amount: 1, allocatedAmount: 1 } }))).message).toMatch(/immutable/i);
    expect((await failure(prisma.payment.update({ where: { id: p.id }, data: { tenantId: contract.tenantId, paidAt: new Date(0) } }))).message).toMatch(/immutable/i);
    expect((await failure(prisma.payment.delete({ where: { id: p.id } }))).message).toMatch(/cannot be deleted/i);
    expect((await failure(prisma.paymentAllocation.deleteMany({ where: { paymentId: p.id } }))).message).toMatch(/append-only/i);
    expect((await failure(prisma.paymentAllocation.updateMany({ where: { paymentId: p.id }, data: { amount: 5 } }))).message).toMatch(/append-only/i);
    expect((await failure(prisma.receipt.delete({ where: { paymentId: p.id } }))).message).toMatch(/cannot be deleted/i);
    expect((await failure(prisma.rentCharge.deleteMany({ where: { contractId: contract.id } }))).message).toMatch(/cannot be deleted/i);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: p.id } });
    expect((await failure(prisma.auditLog.update({ where: { id: log.id }, data: { summary: 'tampered' } }))).message).toMatch(/append-only/i);
    expect((await failure(prisma.auditLog.delete({ where: { id: log.id } }))).message).toMatch(/append-only/i);
    expect(num((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).amount)).toBe(100000);
  });

  it('corrects a payment by reversal: the original stays, a reversal entry is added, balances reopen', async () => {
    const { contract } = await lease(w, (await room(100000)).id, 1);
    const p = await pay(w, 'CASHIER', contract.id, 150000);
    const { request, decide } = await reverse(p.id);
    // A cashier can only request; nothing changes until someone with authority approves.
    expect(request.executed).toBe(false);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('POSTED');
    await decide();

    const original = await prisma.payment.findUniqueOrThrow({ where: { id: p.id }, include: { receipt: true, invoice: true, reversedBy: true } });
    expect([original.status, num(original.amount), num(original.allocatedAmount)]).toEqual(['REVERSED', 150000, 150000]);
    expect(original.receipt?.voidedAt).not.toBeNull();
    expect(original.invoice?.status).toBe('CANCELLED');
    expect([original.reversedBy?.type, num(original.reversedBy?.amount), original.reversedBy?.reason]).toEqual(['REVERSAL', -150000, 'Entered against the wrong tenant']);
    expect((await charges(contract.id)).map((c) => [num(c.amountPaid), num(c.balance)])).toEqual([[0, 100000], [0, 100000]]);

    // The ledger nets to zero and still shows both entries.
    const ledger = await prisma.payment.findMany({ where: { contractId: contract.id } });
    expect(ledger).toHaveLength(2);
    expect(ledger.reduce((a, x) => a + num(x.amount), 0)).toBe(0);

    // Complete audit trail: who recorded, who requested, who approved, with the reason.
    const trail = await prisma.auditLog.findMany({ where: { entityId: p.id }, orderBy: { id: 'asc' } });
    expect(trail.map((t) => t.action)).toEqual(['PAYMENT_RECORDED', 'APPROVAL_REQUESTED', 'PAYMENT_REVERSED', 'APPROVAL_APPROVED']);
    expect(trail[2]!.userId).toBe(w.actors.MANAGEMENT.userId);
    expect(trail[2]!.summary).toContain('Entered against the wrong tenant');

    // The correct payment can now be entered.
    await pay(w, 'CASHIER', contract.id, 100000);
    expect((await charges(contract.id)).map((c) => c.status)).toEqual(['PAID', unpaidThisMonth()]);
  });

  it('cannot reverse a payment twice, nor reverse a reversal', async () => {
    const { contract } = await lease(w, (await room(50000)).id);
    const p = await pay(w, 'CASHIER', contract.id, 50000);
    await (await reverse(p.id)).decide();
    expect((await failure(reverse(p.id))).code).toBe('ALREADY_REVERSED');
    const reversal = await prisma.payment.findFirstOrThrow({ where: { reversesId: p.id } });
    expect((await failure(reverse(reversal.id))).code).toBe('NOT_REVERSIBLE');
    expect((await failure(prisma.payment.update({ where: { id: p.id }, data: { status: 'POSTED' } }))).message).toMatch(/cannot be re-posted/i);
  });

  it('reverses an advance payment including the months it had pre-paid', async () => {
    const { contract } = await lease(w, (await room(100000)).id);
    const p = await pay(w, 'ACCOUNTANT', contract.id, 300000, { overpayment: 'ADVANCE' });
    await (await reverse(p.id, 'Cheque bounced')).decide();
    expect((await charges(contract.id)).every((c) => num(c.amountPaid) === 0 && num(c.balance) === 100000)).toBe(true);
    const checks = await reconcile(w.orgId, monthsAgo(3), endOfThisMonth());
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });
});

describe('verification, periods and deposits', () => {
  it('requires a second person to verify a payment', async () => {
    const { contract } = await lease(w, (await room(50000)).id);
    const p = await pay(w, 'ACCOUNTANT', contract.id, 50000);
    expect((await failure(verifyPayment(w.actors.ACCOUNTANT, p.id))).status).toBe(403);
    const verified = await verifyPayment(w.actors.MANAGEMENT, p.id);
    expect(verified.verifiedById).toBe(w.actors.MANAGEMENT.userId);
    expect((await failure(verifyPayment(w.actors.MANAGEMENT, p.id))).status).toBe(409);
  });

  it('blocks new entries in a closed accounting period until it is reopened', async () => {
    const { contract } = await lease(w, (await room(50000)).id, 2);
    const lastMonth = monthsAgo(1);
    const dated = new Date(addDays(lastMonth, 10).getTime() + 10 * 3_600_000);
    expect((await failure(closePeriod(w.actors.MANAGEMENT, thisMonth()))).code).toBe('PERIOD_NOT_ENDED');
    const period = await closePeriod(w.actors.MANAGEMENT, lastMonth, 'Month-end');
    expect((await failure(pay(w, 'CASHIER', contract.id, 50000, { paidAt: dated }))).code).toBe('PERIOD_CLOSED');
    // The database refuses it too, independent of the application check.
    const existing = await pay(w, 'CASHIER', contract.id, 10000);
    const bypass = prisma.payment.create({ data: { ...existing, id: undefined, allocations: undefined, receipt: undefined, invoice: undefined, idempotencyKey: uid('bypass'), businessDate: addDays(lastMonth, 10), createdAt: undefined } as never });
    expect((await failure(bypass)).message).toMatch(/period .* is closed/i);

    await reopenPeriod(w.actors.MANAGEMENT, period.id, 'Late bank statement');
    await expect(pay(w, 'CASHIER', contract.id, 40000, { paidAt: dated })).resolves.toBeTruthy();
    expect(await prisma.auditLog.count({ where: { action: { in: ['PERIOD_CLOSED', 'PERIOD_REOPENED'] } } })).toBe(2);
  });

  it('keeps security deposits out of the rent ledger', async () => {
    const { contract } = await lease(w, (await room(70000)).id, 0, { depositAmount: d(70000) });
    await recordDepositPayment(w.actors.ACCOUNTANT, { contractId: contract.id, amount: d(70000), methodId: w.methods.CASH! });
    expect(num(await depositHeld(prisma, contract.id))).toBe(70000);
    expect(await prisma.payment.count({ where: { contractId: contract.id } })).toBe(0);
    expect(num((await charges(contract.id))[0]!.amountPaid)).toBe(0);
    expect((await failure(recordDepositPayment(w.actors.ACCOUNTANT, { contractId: contract.id, amount: d(1), methodId: w.methods.CASH! }))).code).toBe('DEPOSIT_EXCEEDED');
    const txn = await prisma.depositTransaction.findFirstOrThrow({ where: { contractId: contract.id } });
    expect((await failure(prisma.depositTransaction.delete({ where: { id: txn.id } }))).message).toMatch(/append-only/i);
  });
});
