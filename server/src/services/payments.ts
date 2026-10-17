import { inTransaction, lockContract, prisma, Prisma, type Tx } from '../db.js';
import type { Contract, Payment } from '../generated/prisma/client.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { can, type Actor } from '../http/context.js';
import { businessDate, isoDate, periodLabel } from '../lib/dates.js';
import type { Money } from '../lib/money.js';
import { formatMoney, minMoney, money, sum, ZERO } from '../lib/money.js';
import { logger } from '../logger.js';
import { audit } from './audit.js';
import { applyToCharge, ensureCharge, nextBillablePeriod, rentForPeriod } from './charges.js';
import { getOrg } from './org.js';
import { assertPeriodOpen } from './periods.js';
import { clearReconcileCache } from './reconcileCache.js';
import { nextDocumentNumber } from './sequences.js';

export interface AllocationLine {
  /** null for a future month whose charge does not exist yet (advance payment). */
  chargeId: string | null;
  period: Date;
  periodLabel: string;
  amountDue: Money;
  balanceBefore: Money;
  applied: Money;
  balanceAfter: Money;
  future: boolean;
}

export interface AllocationPlan {
  outstandingBefore: Money;
  lines: AllocationLine[];
  /** Part of the payment applied to rent charges (existing + future). */
  allocated: Money;
  /** How much the payment exceeds what is currently outstanding. */
  excess: Money;
  /** Part of the excess applied to future months. */
  advanceAllocated: Money;
  /** Part that cannot be applied to any month and stays as credit on the contract. */
  unallocated: Money;
  outstandingAfter: Money;
  monthsCovered: string[];
}

/**
 * Works out exactly how a payment would be applied: oldest outstanding month first
 * (allocation rule OLDEST_FIRST). When `withAdvance` is set, any excess is applied to
 * the following months of the contract; whatever still remains is unallocated credit.
 * Pure planning — writes nothing.
 */
export async function planAllocation(tx: Tx, contract: Contract, amount: Money, withAdvance: boolean): Promise<AllocationPlan> {
  const outstanding = await tx.rentCharge.findMany({
    where: { contractId: contract.id, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] }, balance: { gt: 0 } },
    orderBy: { period: 'asc' },
  });
  const outstandingBefore = sum(outstanding.map((c) => c.balance));
  const lines: AllocationLine[] = [];
  let remaining = amount;
  for (const c of outstanding) {
    const balanceBefore = money(c.balance);
    const applied = minMoney(remaining, balanceBefore);
    lines.push({ chargeId: c.id, period: c.period, periodLabel: periodLabel(c.period), amountDue: money(c.amountDue), balanceBefore, applied, balanceAfter: balanceBefore.minus(applied), future: false });
    remaining = remaining.minus(applied);
  }
  const excess = remaining;
  let advanceAllocated = ZERO;
  if (withAdvance && remaining.greaterThan(0)) {
    const last = await tx.rentCharge.findFirst({ where: { contractId: contract.id, status: { not: 'VOID' } }, orderBy: { period: 'desc' }, select: { period: true } });
    let period = nextBillablePeriod(contract, last?.period ?? null);
    while (period && remaining.greaterThan(0)) {
      const { due } = await rentForPeriod(tx, contract, period);
      if (due.greaterThan(0)) {
        const applied = minMoney(remaining, due);
        lines.push({ chargeId: null, period, periodLabel: periodLabel(period), amountDue: due, balanceBefore: due, applied, balanceAfter: due.minus(applied), future: true });
        remaining = remaining.minus(applied);
        advanceAllocated = advanceAllocated.plus(applied);
      }
      period = nextBillablePeriod(contract, period);
    }
  }
  const unallocated = withAdvance ? remaining : ZERO;
  const allocated = amount.minus(withAdvance ? unallocated : excess);
  return {
    outstandingBefore, lines: lines.filter((l) => l.applied.greaterThan(0) || !l.future), allocated, excess, advanceAllocated, unallocated,
    outstandingAfter: outstandingBefore.minus(minMoney(amount, outstandingBefore)),
    monthsCovered: lines.filter((l) => l.applied.greaterThan(0) && l.balanceAfter.isZero()).map((l) => l.periodLabel),
  };
}

async function loadContractForPayment(tx: Tx, actor: Actor, contractId: string) {
  const contract = await tx.contract.findFirst({
    where: { id: contractId, orgId: actor.orgId },
    include: { tenant: true, room: true, floor: true, building: true },
  });
  if (!contract) throw notFound('Contract');
  if (contract.status === 'DRAFT') throw conflict('This contract is still a draft. Activate it before recording payments.', 'CONTRACT_DRAFT');
  return contract;
}

/** Advance credit held on a contract (payments not yet applied to any month). */
export async function contractCredit(db: Tx | typeof prisma, contractId: string): Promise<Money> {
  const agg = await db.payment.aggregate({ where: { contractId, type: 'PAYMENT', status: 'POSTED' }, _sum: { unallocatedAmount: true } });
  return money(agg._sum.unallocatedAmount);
}

export async function previewPayment(actor: Actor, input: { contractId: string; amount: Money; overpayment?: 'REJECT' | 'ADVANCE' }) {
  return inTransaction(async (tx) => {
    const contract = await loadContractForPayment(tx, actor, input.contractId);
    const withAdvance = input.overpayment === 'ADVANCE';
    const plan = await planAllocation(tx, contract, input.amount, withAdvance);
    return {
      contract: {
        id: contract.id, contractNumber: contract.contractNumber, status: contract.status, monthlyRent: contract.monthlyRent,
        tenant: { id: contract.tenant.id, fullName: contract.tenant.fullName, phone: contract.tenant.phone },
        room: { id: contract.room.id, number: contract.room.number }, floor: { id: contract.floor.id, name: contract.floor.name },
        building: { id: contract.building.id, name: contract.building.name },
      },
      plan,
      credit: await contractCredit(tx, contract.id),
      overpaid: plan.excess.greaterThan(0),
      canRecordAdvance: can(actor, 'payment.advance'),
    };
  });
}

export interface PaymentInput {
  contractId: string;
  amount: Money;
  methodId: string;
  reference?: string;
  paidAt?: Date;
  notes?: string;
  /** What to do if the amount exceeds the outstanding balance. Default REJECT. */
  overpayment?: 'REJECT' | 'ADVANCE';
  /** Client-generated key identifying this submission; a retry with the same key never creates a second payment. */
  idempotencyKey: string;
}

function sameSubmission(existing: Payment, input: PaymentInput): boolean {
  return existing.contractId === input.contractId && money(existing.amount).equals(input.amount) && existing.methodId === input.methodId;
}

async function findBySubmission(actor: Actor, input: PaymentInput) {
  const existing = await prisma.payment.findUnique({ where: { orgId_idempotencyKey: { orgId: actor.orgId, idempotencyKey: input.idempotencyKey } } });
  if (!existing) return null;
  if (!sameSubmission(existing, input)) {
    throw conflict('This submission key was already used for a different payment. Reload the page and try again.', 'IDEMPOTENCY_MISMATCH');
  }
  return existing;
}

/**
 * Records a rent payment. In ONE transaction: payment → allocations → charge balances
 * → receipt → invoice (EBM pending) → audit log. Any failure rolls everything back.
 */
export async function recordPayment(actor: Actor, input: PaymentInput): Promise<{ paymentId: string; replayed: boolean }> {
  const replay = await findBySubmission(actor, input);
  if (replay) return { paymentId: replay.id, replayed: true };

  const org = await getOrg(actor.orgId);
  const now = new Date();
  const paidAt = input.paidAt ?? now;
  if (paidAt.getTime() > now.getTime() + 5 * 60_000) throw badRequest('The payment date cannot be in the future.', 'FUTURE_DATE');
  const bizDate = businessDate(org.timezone, paidAt);
  const today = businessDate(org.timezone, now);

  try {
    const paymentId = await inTransaction(async (tx) => {
      await lockContract(tx, input.contractId);
      const contract = await loadContractForPayment(tx, actor, input.contractId);
      const method = await tx.paymentMethod.findFirst({ where: { id: input.methodId, orgId: actor.orgId } });
      if (!method || !method.isActive) throw badRequest('Select a valid payment method.', 'INVALID_METHOD');
      const reference = input.reference?.trim() || null;
      if (method.requiresReference && !reference) throw badRequest(`A transaction reference is required for ${method.name} payments.`, 'REFERENCE_REQUIRED');
      if (bizDate < contract.startDate && !can(actor, 'payment.advance')) {
        throw badRequest('The payment date is before the contract start date.', 'INVALID_DATE');
      }
      await assertPeriodOpen(tx, actor.orgId, bizDate, 'This payment');

      const wantsAdvance = input.overpayment === 'ADVANCE';
      const plan = await planAllocation(tx, contract, input.amount, wantsAdvance);
      if (plan.excess.greaterThan(0)) {
        if (!wantsAdvance) {
          const nothingDue = plan.outstandingBefore.isZero();
          throw new AppError(409, 'OVERPAYMENT',
            nothingDue
              ? `There is no outstanding balance on this contract. ${formatMoney(input.amount)} can only be recorded as an advance payment.`
              : `Payment exceeds current outstanding balance by ${formatMoney(plan.excess)}.`,
            { outstanding: plan.outstandingBefore, excess: plan.excess, canRecordAdvance: can(actor, 'payment.advance') });
        }
        if (!can(actor, 'payment.advance')) throw forbidden('You are not authorised to record advance payments. Ask a manager or accountant.');
      }

      const payment = await tx.payment.create({
        data: {
          orgId: actor.orgId, type: 'PAYMENT', status: 'POSTED', tenantId: contract.tenantId, contractId: contract.id,
          roomId: contract.roomId, floorId: contract.floorId, buildingId: contract.buildingId,
          amount: input.amount, allocatedAmount: plan.allocated, unallocatedAmount: plan.unallocated,
          paidAt, businessDate: bizDate, methodId: method.id, reference, notes: input.notes?.trim() || null,
          idempotencyKey: input.idempotencyKey, recordedById: actor.userId,
          // With verification switched off (Settings → Billing), recording the payment is enough.
          ...(org.requirePaymentVerification ? {} : { verifiedById: actor.userId, verifiedAt: new Date() }),
        },
      });

      const receiptLines: Array<{ period: string; applied: string; balanceAfter: string; advance: boolean }> = [];
      for (const line of plan.lines) {
        if (!line.applied.greaterThan(0)) continue;
        const chargeId = line.chargeId ?? (await ensureCharge(tx, contract, line.period, today)).id;
        await tx.paymentAllocation.create({ data: { paymentId: payment.id, rentChargeId: chargeId, amount: line.applied } });
        const updated = await applyToCharge(tx, chargeId, line.applied, today);
        receiptLines.push({ period: line.periodLabel, applied: line.applied.toFixed(2), balanceAfter: money(updated.balance).toFixed(2), advance: line.future });
      }

      const year = bizDate.getUTCFullYear();
      const receiptNumber = await nextDocumentNumber(tx, actor.orgId, 'RECEIPT', org.receiptPrefix, year);
      await tx.receipt.create({
        data: {
          orgId: actor.orgId, receiptNumber, paymentId: payment.id, issuedById: actor.userId,
          snapshot: {
            // The receipt is issued by the company that owns the building, when the building has its own details.
            organization: contract.building.companyName
              ? { name: contract.building.companyName, tin: contract.building.tin, address: contract.building.address, phone: contract.building.phone }
              : { name: org.name, tin: org.tin, address: org.address, phone: org.phone },
            receiptNumber, tenant: { name: contract.tenant.fullName, phone: contract.tenant.phone, businessName: contract.tenant.businessName },
            building: contract.building.name, floor: contract.floor.name, room: contract.room.number,
            contractNumber: contract.contractNumber, amount: input.amount.toFixed(2), currency: org.currency,
            method: method.name, reference, paidAt: paidAt.toISOString(), businessDate: isoDate(bizDate),
            lines: receiptLines, advanceCredit: plan.unallocated.toFixed(2), outstandingAfter: plan.outstandingAfter.toFixed(2),
            recordedBy: actor.name,
          },
        },
      });
      const invoiceNumber = await nextDocumentNumber(tx, actor.orgId, 'INVOICE', org.invoicePrefix, year);
      await tx.invoice.create({
        data: { orgId: actor.orgId, invoiceNumber, paymentId: payment.id, tenantId: contract.tenantId, buildingId: contract.buildingId, amount: input.amount, issueDate: bizDate, status: 'PENDING' },
      });
      await audit(tx, actor, {
        action: plan.excess.greaterThan(0) ? 'ADVANCE_PAYMENT_RECORDED' : 'PAYMENT_RECORDED', entityType: 'Payment', entityId: payment.id,
        summary: `${formatMoney(input.amount)} received from ${contract.tenant.fullName} for room ${contract.room.number} (${method.name}) — receipt ${receiptNumber}`,
        newValue: { receiptNumber, amount: input.amount, method: method.code, reference, businessDate: isoDate(bizDate), allocations: receiptLines, unallocated: plan.unallocated },
      });
      return payment.id;
    });
    clearReconcileCache(actor.orgId);
    logger.info({ paymentId, userId: actor.userId, amount: input.amount.toFixed(2) }, 'payment recorded');
    return { paymentId, replayed: false };
  } catch (err) {
    // A concurrent request with the same key may have won the race — return its result instead of failing.
    const replayed = await findBySubmission(actor, input).catch(() => null);
    if (replayed) return { paymentId: replayed.id, replayed: true };
    throw err;
  }
}

/**
 * Posts the reversal of a payment (called once a reversal has been approved).
 * The original row is kept and flagged REVERSED; a negative REVERSAL row and negative
 * allocation rows are appended; affected charges are re-opened; the receipt is voided
 * and the invoice cancelled. Caller provides the transaction.
 */
export async function postReversal(tx: Tx, actor: Actor, paymentId: string, reason: string): Promise<Payment> {
  const found = await tx.payment.findFirst({ where: { id: paymentId, orgId: actor.orgId } });
  if (!found) throw notFound('Payment');
  await lockContract(tx, found.contractId);
  const original = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { tenant: true, room: true, receipt: true } });
  if (original.type !== 'PAYMENT') throw conflict('A reversal entry cannot itself be reversed.', 'NOT_REVERSIBLE');
  if (original.status === 'REVERSED') throw conflict('This payment has already been reversed.', 'ALREADY_REVERSED');

  const org = await getOrg(actor.orgId, tx);
  const now = new Date();
  const today = businessDate(org.timezone, now);
  await assertPeriodOpen(tx, actor.orgId, today, 'The reversal');

  const reversal = await tx.payment.create({
    data: {
      orgId: original.orgId, type: 'REVERSAL', status: 'POSTED', tenantId: original.tenantId, contractId: original.contractId,
      roomId: original.roomId, floorId: original.floorId, buildingId: original.buildingId,
      amount: money(original.amount).negated(), allocatedAmount: money(original.allocatedAmount).negated(),
      unallocatedAmount: money(original.unallocatedAmount).negated(),
      paidAt: now, businessDate: today, methodId: original.methodId, reference: original.reference,
      idempotencyKey: `reversal:${original.id}`, reversesId: original.id, reason, recordedById: actor.userId,
    },
  });
  // Net amount this payment currently contributes to each charge.
  const grouped = await tx.paymentAllocation.groupBy({ by: ['rentChargeId'], where: { paymentId: original.id }, _sum: { amount: true } });
  for (const g of grouped) {
    const net = money(g._sum.amount);
    if (net.isZero()) continue;
    await tx.paymentAllocation.create({ data: { paymentId: reversal.id, rentChargeId: g.rentChargeId, amount: net.negated() } });
    await applyToCharge(tx, g.rentChargeId, net.negated(), today);
  }
  await tx.payment.update({ where: { id: original.id }, data: { status: 'REVERSED' } });
  if (original.receipt) await tx.receipt.update({ where: { id: original.receipt.id }, data: { voidedAt: now, voidReason: reason.slice(0, 255) } });
  await tx.invoice.updateMany({ where: { paymentId: original.id, status: { not: 'CANCELLED' } }, data: { status: 'CANCELLED', statusNote: `Payment reversed: ${reason}`.slice(0, 255), updatedById: actor.userId } });
  await audit(tx, actor, {
    action: 'PAYMENT_REVERSED', entityType: 'Payment', entityId: original.id,
    summary: `Payment ${original.receipt?.receiptNumber ?? original.id} of ${formatMoney(original.amount)} from ${original.tenant.fullName} reversed: ${reason}`,
    oldValue: { status: 'POSTED', amount: original.amount }, newValue: { status: 'REVERSED', reversalId: reversal.id, reason },
  });
  clearReconcileCache(actor.orgId);
  logger.info({ paymentId: original.id, reversalId: reversal.id, userId: actor.userId }, 'payment reversed');
  return reversal;
}

/** A second person confirms a recorded payment (e.g. against the bank / MoMo statement). */
export async function verifyPayment(actor: Actor, paymentId: string) {
  return inTransaction(async (tx) => {
    const payment = await tx.payment.findFirst({ where: { id: paymentId, orgId: actor.orgId }, include: { receipt: true } });
    if (!payment) throw notFound('Payment');
    if (payment.type !== 'PAYMENT' || payment.status !== 'POSTED') throw conflict('Only a posted payment can be verified.');
    if (payment.verifiedAt) throw conflict('This payment has already been verified.');
    if (payment.recordedById === actor.userId) throw forbidden('A payment must be verified by someone other than the person who recorded it.');
    const updated = await tx.payment.update({ where: { id: paymentId }, data: { verifiedById: actor.userId, verifiedAt: new Date() } });
    await audit(tx, actor, { action: 'PAYMENT_VERIFIED', entityType: 'Payment', entityId: paymentId, summary: `Payment ${payment.receipt?.receiptNumber ?? paymentId} verified` });
    return updated;
  });
}

export interface PaymentFilter {
  buildingId?: string;
  floorId?: string;
  roomId?: string;
  tenantId?: string;
  contractId?: string;
  methodId?: string;
  from?: Date;
  to?: Date;
  status?: 'POSTED' | 'REVERSED';
  type?: 'PAYMENT' | 'REVERSAL';
  verified?: boolean;
  q?: string;
}

export function paymentWhere(orgId: string, f: PaymentFilter): Prisma.PaymentWhereInput {
  return {
    orgId,
    ...(f.buildingId ? { buildingId: f.buildingId } : {}),
    ...(f.floorId ? { floorId: f.floorId } : {}),
    ...(f.roomId ? { roomId: f.roomId } : {}),
    ...(f.tenantId ? { tenantId: f.tenantId } : {}),
    ...(f.contractId ? { contractId: f.contractId } : {}),
    ...(f.methodId ? { methodId: f.methodId } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.type ? { type: f.type } : {}),
    ...(f.verified === undefined ? {} : f.verified ? { verifiedAt: { not: null } } : { verifiedAt: null, type: 'PAYMENT', status: 'POSTED' }),
    ...(f.from || f.to ? { businessDate: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
    ...(f.q
      ? { OR: [{ reference: { contains: f.q } }, { receipt: { receiptNumber: { contains: f.q } } }, { tenant: { fullName: { contains: f.q } } }, { room: { number: { contains: f.q } } }] }
      : {}),
  };
}

const paymentListInclude = {
  tenant: { select: { id: true, fullName: true, phone: true } },
  room: { select: { id: true, number: true } },
  floor: { select: { id: true, name: true } },
  building: { select: { id: true, name: true } },
  method: { select: { id: true, code: true, name: true } },
  receipt: { select: { receiptNumber: true, voidedAt: true } },
  invoice: { select: { id: true, invoiceNumber: true, status: true, ebmReference: true } },
  recordedBy: { select: { id: true, fullName: true } },
  verifiedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.PaymentInclude;

export async function listPayments(orgId: string, f: PaymentFilter, page: { page: number; pageSize: number }) {
  const where = paymentWhere(orgId, f);
  const [total, items, totals] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({ where, include: paymentListInclude, orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }], skip: (page.page - 1) * page.pageSize, take: page.pageSize }),
    prisma.payment.aggregate({ where, _sum: { amount: true } }),
  ]);
  return { items, total, netAmount: money(totals._sum.amount) };
}

export async function paymentDetail(orgId: string, id: string) {
  const payment = await prisma.payment.findFirst({
    where: { id, orgId },
    include: {
      ...paymentListInclude,
      contract: { select: { id: true, contractNumber: true, status: true } },
      allocations: { include: { rentCharge: { select: { id: true, period: true, amountDue: true, balance: true, status: true } } }, orderBy: { createdAt: 'asc' } },
      receipt: true,
      reverses: { select: { id: true, receipt: { select: { receiptNumber: true } } } },
      reversedBy: { select: { id: true, reason: true, paidAt: true, recordedBy: { select: { fullName: true } } } },
    },
  });
  if (!payment) throw notFound('Payment');
  const pendingReversal = await prisma.approvalRequest.findFirst({ where: { orgId, type: 'PAYMENT_REVERSAL', entityId: id, status: 'SUBMITTED' }, select: { id: true, reason: true, createdAt: true } });
  return { ...payment, pendingReversal };
}
