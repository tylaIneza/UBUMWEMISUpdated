import { inTransaction, lockContract, prisma, type Db, type Tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import type { Actor } from '../http/context.js';
import type { Money } from '../lib/money.js';
import { formatMoney, money, ZERO } from '../lib/money.js';
import { audit } from './audit.js';
import { orgToday } from './org.js';
import { nextDocumentNumber } from './sequences.js';

/**
 * Security deposit currently held for a contract.
 * held = payments − refunds − deductions + corrections. Deposits are a liability,
 * tracked in their own ledger, and are never part of rental income.
 */
export async function depositHeld(db: Db, contractId: string): Promise<Money> {
  const rows = await db.depositTransaction.groupBy({ by: ['type'], where: { contractId }, _sum: { amount: true } });
  let held = ZERO;
  for (const r of rows) {
    const amount = money(r._sum.amount);
    held = r.type === 'PAYMENT' || r.type === 'CORRECTION' ? held.plus(amount) : held.minus(amount);
  }
  return held;
}

async function contractFor(tx: Tx, actor: Actor, contractId: string) {
  const contract = await tx.contract.findFirst({ where: { id: contractId, orgId: actor.orgId }, include: { tenant: true, room: true } });
  if (!contract) throw notFound('Contract');
  return contract;
}

export async function recordDepositPayment(actor: Actor, input: { contractId: string; amount: Money; txnDate?: Date; methodId: string; reference?: string }) {
  const today = await orgToday(actor.orgId);
  return inTransaction(async (tx) => {
    await lockContract(tx, input.contractId);
    const contract = await contractFor(tx, actor, input.contractId);
    const method = await tx.paymentMethod.findFirst({ where: { id: input.methodId, orgId: actor.orgId, isActive: true } });
    if (!method) throw badRequest('Select a valid payment method.', 'INVALID_METHOD');
    if (method.requiresReference && !input.reference?.trim()) throw badRequest(`A transaction reference is required for ${method.name}.`, 'REFERENCE_REQUIRED');
    const txnDate = input.txnDate ?? today;
    if (txnDate > today) throw badRequest('The date cannot be in the future.', 'FUTURE_DATE');
    const held = await depositHeld(tx, contract.id);
    const remaining = money(contract.depositAmount).minus(held);
    if (input.amount.greaterThan(remaining)) {
      throw badRequest(`The deposit required is ${formatMoney(contract.depositAmount)} and ${formatMoney(held)} is already held. At most ${formatMoney(remaining.lessThan(0) ? 0 : remaining)} more can be recorded.`, 'DEPOSIT_EXCEEDED');
    }
    const number = await nextDocumentNumber(tx, actor.orgId, 'DEPOSIT', 'DEP', txnDate.getUTCFullYear());
    const txn = await tx.depositTransaction.create({
      data: { orgId: actor.orgId, number, contractId: contract.id, type: 'PAYMENT', amount: input.amount, txnDate, methodId: method.id, reference: input.reference?.trim() || null, recordedById: actor.userId },
    });
    await audit(tx, actor, { action: 'DEPOSIT_RECEIVED', entityType: 'Contract', entityId: contract.id, summary: `Security deposit ${formatMoney(input.amount)} received from ${contract.tenant.fullName} (${number})`, newValue: txn });
    return txn;
  });
}

export async function recordDepositDeduction(actor: Actor, input: { contractId: string; amount: Money; reason: string }) {
  const today = await orgToday(actor.orgId);
  return inTransaction(async (tx) => {
    await lockContract(tx, input.contractId);
    const contract = await contractFor(tx, actor, input.contractId);
    const held = await depositHeld(tx, contract.id);
    if (input.amount.greaterThan(held)) throw badRequest(`The deduction exceeds the deposit held (${formatMoney(held)}).`, 'DEPOSIT_EXCEEDED');
    const number = await nextDocumentNumber(tx, actor.orgId, 'DEPOSIT', 'DEP', today.getUTCFullYear());
    const txn = await tx.depositTransaction.create({ data: { orgId: actor.orgId, number, contractId: contract.id, type: 'DEDUCTION', amount: input.amount, txnDate: today, reason: input.reason, recordedById: actor.userId } });
    await audit(tx, actor, { action: 'DEPOSIT_DEDUCTION', entityType: 'Contract', entityId: contract.id, summary: `Deposit deduction ${formatMoney(input.amount)} for ${contract.tenant.fullName}: ${input.reason}`, newValue: txn });
    return txn;
  });
}

/** Pays a deposit refund out (called once the refund has been approved). */
export async function postDepositRefund(tx: Tx, actor: Actor, approvalId: string, input: { contractId: string; amount: Money; methodId?: string; reference?: string; reason: string }) {
  await lockContract(tx, input.contractId);
  const contract = await contractFor(tx, actor, input.contractId);
  const held = await depositHeld(tx, contract.id);
  if (input.amount.greaterThan(held)) throw badRequest(`The refund (${formatMoney(input.amount)}) exceeds the deposit held (${formatMoney(held)}).`, 'DEPOSIT_EXCEEDED');
  const today = await orgToday(actor.orgId, tx);
  const number = await nextDocumentNumber(tx, actor.orgId, 'DEPOSIT', 'DEP', today.getUTCFullYear());
  const txn = await tx.depositTransaction.create({
    data: { orgId: actor.orgId, number, contractId: contract.id, type: 'REFUND', amount: input.amount, txnDate: today, methodId: input.methodId ?? null, reference: input.reference ?? null, reason: input.reason, recordedById: actor.userId, approvalId },
  });
  await audit(tx, actor, { action: 'DEPOSIT_REFUNDED', entityType: 'Contract', entityId: contract.id, summary: `Deposit refund ${formatMoney(input.amount)} to ${contract.tenant.fullName} (${number})`, newValue: txn });
  return txn;
}

export async function listDeposits(orgId: string, f: { buildingId?: string; onlyHeld?: boolean }) {
  const contracts = await prisma.contract.findMany({
    where: { orgId, status: { not: 'DRAFT' }, ...(f.buildingId ? { buildingId: f.buildingId } : {}), OR: [{ depositAmount: { gt: 0 } }, { deposits: { some: {} } }] },
    select: {
      id: true, contractNumber: true, status: true, depositAmount: true,
      tenant: { select: { id: true, fullName: true } }, room: { select: { id: true, number: true } }, building: { select: { id: true, name: true } },
      deposits: { select: { type: true, amount: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const rows = contracts.map(({ deposits, ...c }) => {
    let paid = ZERO, refunded = ZERO, deducted = ZERO, corrections = ZERO;
    for (const d of deposits) {
      const a = money(d.amount);
      if (d.type === 'PAYMENT') paid = paid.plus(a);
      else if (d.type === 'REFUND') refunded = refunded.plus(a);
      else if (d.type === 'DEDUCTION') deducted = deducted.plus(a);
      else corrections = corrections.plus(a);
    }
    const held = paid.plus(corrections).minus(refunded).minus(deducted);
    return { ...c, paid, refunded, deducted, corrections, held };
  });
  return f.onlyHeld ? rows.filter((r) => !r.held.isZero()) : rows;
}
