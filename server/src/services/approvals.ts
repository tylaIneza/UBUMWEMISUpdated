import { z } from 'zod';
import { inTransaction, lockContract, prisma, Prisma, type Tx } from '../db.js';
import type { ApprovalRequest } from '../generated/prisma/client.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { can, type Actor } from '../http/context.js';
import { parseDate, periodLabel } from '../lib/dates.js';
import { Decimal, formatMoney, money } from '../lib/money.js';
import { audit } from './audit.js';
import { deriveStatus, rentForPeriod } from './charges.js';
import { depositHeld, postDepositRefund } from './deposits.js';
import { orgToday } from './org.js';
import { postReversal } from './payments.js';
import { assertPeriodOpen } from './periods.js';

/**
 * Approval workflow for sensitive operations: SUBMITTED → APPROVED (and executed in the
 * same transaction) or REJECTED. A user who holds `approval.decide` is approving their
 * own request by submitting it, so it executes immediately — still recorded as an
 * approval row naming them as approver.
 */

const reversalPayload = z.object({});
const adjustmentPayload = z.object({
  type: z.enum(['DISCOUNT', 'SURCHARGE']),
  amount: z.string(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
});
const waiverPayload = z.object({ chargeId: z.string(), amount: z.string() });
const refundPayload = z.object({ amount: z.string(), methodId: z.string().nullable(), reference: z.string().nullable() });

export interface ApprovalSubmission {
  type: ApprovalRequest['type'];
  entityType: string;
  entityId: string;
  summary: string;
  reason: string;
  payload: Record<string, unknown>;
}

async function execute(tx: Tx, actor: Actor, approval: ApprovalRequest): Promise<void> {
  switch (approval.type) {
    case 'PAYMENT_REVERSAL': {
      reversalPayload.parse(approval.payload);
      await postReversal(tx, actor, approval.entityId, approval.reason);
      return;
    }
    case 'RENT_ADJUSTMENT': {
      const p = adjustmentPayload.parse(approval.payload);
      await lockContract(tx, approval.entityId);
      const contract = await tx.contract.findFirst({ where: { id: approval.entityId, orgId: actor.orgId } });
      if (!contract) throw notFound('Contract');
      const today = await orgToday(actor.orgId, tx);
      await tx.rentAdjustment.create({
        data: { contractId: contract.id, type: p.type, amount: new Decimal(p.amount), reason: approval.reason.slice(0, 255), effectiveFrom: parseDate(p.effectiveFrom), effectiveTo: p.effectiveTo ? parseDate(p.effectiveTo) : null, approvalId: approval.id },
      });
      // Re-price charges that already exist inside the adjustment window. Originals stay visible: baseAmount is untouched.
      const charges = await tx.rentCharge.findMany({ where: { contractId: contract.id, status: { not: 'VOID' } }, orderBy: { period: 'asc' } });
      for (const charge of charges) {
        const priced = await rentForPeriod(tx, contract, charge.period);
        // Keep the rate the charge was billed at; only the adjustment component changes.
        const base = money(charge.baseAmount);
        let adjustment = priced.adjustment;
        if (base.plus(adjustment).lessThan(0)) adjustment = base.negated();
        if (adjustment.equals(charge.adjustmentAmount)) continue;
        const amountDue = base.plus(adjustment);
        const settled = money(charge.amountPaid).plus(charge.amountWaived);
        if (amountDue.lessThan(settled)) {
          throw conflict(`${periodLabel(charge.period)} already has ${formatMoney(settled)} paid, which is more than the adjusted rent of ${formatMoney(amountDue)}. Choose a later effective date.`, 'ADJUSTMENT_BELOW_PAID');
        }
        await assertPeriodOpen(tx, actor.orgId, charge.period, `The rent charge for ${periodLabel(charge.period)}`);
        const status = deriveStatus({ amountDue, amountPaid: money(charge.amountPaid), amountWaived: money(charge.amountWaived), overdueFrom: charge.overdueFrom }, today);
        await tx.rentCharge.update({ where: { id: charge.id }, data: { adjustmentAmount: adjustment, amountDue, balance: amountDue.minus(settled), status } });
      }
      return;
    }
    case 'DEBT_WAIVER': {
      const p = waiverPayload.parse(approval.payload);
      const found = await tx.rentCharge.findFirst({ where: { id: p.chargeId, orgId: actor.orgId } });
      if (!found) throw notFound('Rent charge');
      await lockContract(tx, found.contractId);
      const charge = await tx.rentCharge.findUniqueOrThrow({ where: { id: p.chargeId } });
      const amount = new Decimal(p.amount);
      if (charge.status === 'VOID') throw conflict('This rent charge has been voided.');
      if (amount.greaterThan(charge.balance)) throw conflict(`Only ${formatMoney(charge.balance)} is still outstanding for ${periodLabel(charge.period)}; ${formatMoney(amount)} cannot be waived.`, 'WAIVER_EXCEEDS_BALANCE');
      const today = await orgToday(actor.orgId, tx);
      const amountWaived = money(charge.amountWaived).plus(amount);
      const status = deriveStatus({ amountDue: money(charge.amountDue), amountPaid: money(charge.amountPaid), amountWaived, overdueFrom: charge.overdueFrom }, today);
      await tx.rentCharge.update({ where: { id: charge.id }, data: { amountWaived, balance: money(charge.balance).minus(amount), status, note: `Waived ${formatMoney(amount)}: ${approval.reason}`.slice(0, 255) } });
      return;
    }
    case 'DEPOSIT_REFUND': {
      const p = refundPayload.parse(approval.payload);
      await postDepositRefund(tx, actor, approval.id, { contractId: approval.entityId, amount: new Decimal(p.amount), methodId: p.methodId ?? undefined, reference: p.reference ?? undefined, reason: approval.reason.slice(0, 255) });
      return;
    }
  }
}

/** Validates a request before it enters the queue, so obviously impossible requests are refused immediately. */
async function precheck(tx: Tx, actor: Actor, s: ApprovalSubmission): Promise<void> {
  const duplicate = await tx.approvalRequest.findFirst({ where: { orgId: actor.orgId, type: s.type, entityId: s.entityId, status: 'SUBMITTED' } });
  if (duplicate) throw conflict('A request of this kind is already awaiting approval for this record.', 'ALREADY_REQUESTED');
  if (s.type === 'PAYMENT_REVERSAL') {
    const payment = await tx.payment.findFirst({ where: { id: s.entityId, orgId: actor.orgId } });
    if (!payment) throw notFound('Payment');
    if (payment.type !== 'PAYMENT') throw conflict('A reversal entry cannot itself be reversed.', 'NOT_REVERSIBLE');
    if (payment.status === 'REVERSED') throw conflict('This payment has already been reversed.', 'ALREADY_REVERSED');
  } else if (s.type === 'DEBT_WAIVER') {
    const p = waiverPayload.parse(s.payload);
    const charge = await tx.rentCharge.findFirst({ where: { id: p.chargeId, orgId: actor.orgId } });
    if (!charge) throw notFound('Rent charge');
    if (new Decimal(p.amount).greaterThan(charge.balance)) throw badRequest(`Only ${formatMoney(charge.balance)} is outstanding for ${periodLabel(charge.period)}.`, 'WAIVER_EXCEEDS_BALANCE');
  } else if (s.type === 'DEPOSIT_REFUND') {
    const p = refundPayload.parse(s.payload);
    const contract = await tx.contract.findFirst({ where: { id: s.entityId, orgId: actor.orgId } });
    if (!contract) throw notFound('Contract');
    const held = await depositHeld(tx, contract.id);
    if (new Decimal(p.amount).greaterThan(held)) throw badRequest(`The refund exceeds the deposit held (${formatMoney(held)}).`, 'DEPOSIT_EXCEEDED');
  } else {
    const p = adjustmentPayload.parse(s.payload);
    const contract = await tx.contract.findFirst({ where: { id: s.entityId, orgId: actor.orgId } });
    if (!contract) throw notFound('Contract');
    if (p.effectiveTo && parseDate(p.effectiveTo) < parseDate(p.effectiveFrom)) throw badRequest('The adjustment end date is before its start date.', 'INVALID_DATES');
  }
}

export async function submitApproval(actor: Actor, s: ApprovalSubmission): Promise<{ approval: ApprovalRequest; executed: boolean }> {
  return inTransaction(async (tx) => {
    await precheck(tx, actor, s);
    const selfApprove = can(actor, 'approval.decide');
    let approval = await tx.approvalRequest.create({
      data: { orgId: actor.orgId, type: s.type, entityType: s.entityType, entityId: s.entityId, summary: s.summary.slice(0, 255), reason: s.reason, payload: s.payload as Prisma.InputJsonValue, requestedById: actor.userId },
    });
    await audit(tx, actor, { action: 'APPROVAL_REQUESTED', entityType: s.entityType, entityId: s.entityId, summary: `${s.summary} — requested: ${s.reason}`, newValue: { approvalId: approval.id, type: s.type, payload: s.payload } });
    if (selfApprove) {
      await execute(tx, actor, approval);
      approval = await tx.approvalRequest.update({ where: { id: approval.id }, data: { status: 'APPROVED', decidedById: actor.userId, decidedAt: new Date(), decisionNote: 'Approved by requester (holds approval authority)' } });
      await audit(tx, actor, { action: 'APPROVAL_APPROVED', entityType: s.entityType, entityId: s.entityId, summary: `${s.summary} — approved and posted`, newValue: { approvalId: approval.id } });
    }
    return { approval, executed: selfApprove };
  });
}

export async function decideApproval(actor: Actor, id: string, approve: boolean, note?: string) {
  return inTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM approval_requests WHERE id = ${id} FOR UPDATE`;
    const approval = await tx.approvalRequest.findFirst({ where: { id, orgId: actor.orgId } });
    if (!approval) throw notFound('Approval request');
    if (approval.status !== 'SUBMITTED') throw conflict(`This request has already been ${approval.status.toLowerCase()}.`, 'ALREADY_DECIDED');
    if (!approve && !note?.trim()) throw badRequest('Give a reason for rejecting the request.', 'REASON_REQUIRED');
    if (approve) await execute(tx, actor, approval);
    const updated = await tx.approvalRequest.update({
      where: { id }, data: { status: approve ? 'APPROVED' : 'REJECTED', decidedById: actor.userId, decidedAt: new Date(), decisionNote: note?.trim() || null },
    });
    await audit(tx, actor, {
      action: approve ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED', entityType: approval.entityType, entityId: approval.entityId,
      summary: `${approval.summary} — ${approve ? 'approved and posted' : `rejected: ${note}`}`, newValue: { approvalId: id },
    });
    return updated;
  });
}

export async function cancelApproval(actor: Actor, id: string) {
  return inTransaction(async (tx) => {
    const approval = await tx.approvalRequest.findFirst({ where: { id, orgId: actor.orgId } });
    if (!approval) throw notFound('Approval request');
    if (approval.status !== 'SUBMITTED') throw conflict('Only a pending request can be withdrawn.');
    if (approval.requestedById !== actor.userId && !can(actor, 'approval.decide')) throw conflict('Only the person who made the request can withdraw it.');
    const updated = await tx.approvalRequest.update({ where: { id }, data: { status: 'CANCELLED', decidedById: actor.userId, decidedAt: new Date() } });
    await audit(tx, actor, { action: 'APPROVAL_CANCELLED', entityType: approval.entityType, entityId: approval.entityId, summary: `${approval.summary} — request withdrawn` });
    return updated;
  });
}

export async function listApprovals(orgId: string, f: { status?: string; type?: string }, page: { page: number; pageSize: number }) {
  const where: Prisma.ApprovalRequestWhereInput = {
    orgId, ...(f.status ? { status: f.status as ApprovalRequest['status'] } : {}), ...(f.type ? { type: f.type as ApprovalRequest['type'] } : {}),
  };
  const [total, items] = await Promise.all([
    prisma.approvalRequest.count({ where }),
    prisma.approvalRequest.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (page.page - 1) * page.pageSize, take: page.pageSize,
      include: { requestedBy: { select: { fullName: true } }, decidedBy: { select: { fullName: true } } },
    }),
  ]);
  return { items, total };
}
