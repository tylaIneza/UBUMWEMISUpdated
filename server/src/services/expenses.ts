import { inTransaction, prisma, Prisma } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { can, type Actor } from '../http/context.js';

import type { Money } from '../lib/money.js';
import { formatMoney, money } from '../lib/money.js';
import { audit, diff } from './audit.js';
import { orgToday } from './org.js';
import { assertPeriodOpen } from './periods.js';
import { nextDocumentNumber } from './sequences.js';

export interface ExpenseInput {
  scope: 'ORGANIZATION' | 'BUILDING' | 'FLOOR' | 'ROOM';
  buildingId?: string;
  floorId?: string;
  roomId?: string;
  categoryId: string;
  description: string;
  amount: Money;
  expenseDate: Date;
  methodId?: string;
  supplier?: string;
  reference?: string;
  maintenanceRequestId?: string;
  /** Save without submitting for approval. */
  draft?: boolean;
}

/** Resolves and validates where an expense belongs, so building reports can never mix properties. */
async function resolveScope(tx: Prisma.TransactionClient, orgId: string, input: Pick<ExpenseInput, 'scope' | 'buildingId' | 'floorId' | 'roomId'>) {
  if (input.scope === 'ORGANIZATION') return { buildingId: null, floorId: null, roomId: null };
  if (input.scope === 'ROOM') {
    if (!input.roomId) throw badRequest('Select the room this expense belongs to.', 'INVALID_SCOPE');
    const room = await tx.room.findFirst({ where: { id: input.roomId, building: { orgId } } });
    if (!room) throw notFound('Room');
    return { buildingId: room.buildingId, floorId: room.floorId, roomId: room.id };
  }
  if (input.scope === 'FLOOR') {
    if (!input.floorId) throw badRequest('Select the floor this expense belongs to.', 'INVALID_SCOPE');
    const floor = await tx.floor.findFirst({ where: { id: input.floorId, building: { orgId } } });
    if (!floor) throw notFound('Floor');
    return { buildingId: floor.buildingId, floorId: floor.id, roomId: null };
  }
  if (!input.buildingId) throw badRequest('Select the building this expense belongs to.', 'INVALID_SCOPE');
  const building = await tx.building.findFirst({ where: { id: input.buildingId, orgId } });
  if (!building) throw notFound('Building');
  return { buildingId: building.id, floorId: null, roomId: null };
}

export async function createExpense(actor: Actor, input: ExpenseInput) {
  const today = await orgToday(actor.orgId);
  if (input.expenseDate > today) throw badRequest('The expense date cannot be in the future.', 'FUTURE_DATE');
  return inTransaction(async (tx) => {
    await assertPeriodOpen(tx, actor.orgId, input.expenseDate, 'This expense');
    const scope = await resolveScope(tx, actor.orgId, input);
    const category = await tx.expenseCategory.findFirst({ where: { id: input.categoryId, orgId: actor.orgId, isActive: true } });
    if (!category) throw badRequest('Select a valid expense category.', 'INVALID_CATEGORY');
    if (input.methodId) {
      const method = await tx.paymentMethod.findFirst({ where: { id: input.methodId, orgId: actor.orgId } });
      if (!method) throw badRequest('Select a valid payment method.', 'INVALID_METHOD');
    }
    if (input.maintenanceRequestId) {
      const request = await tx.maintenanceRequest.findFirst({ where: { id: input.maintenanceRequestId, orgId: actor.orgId } });
      if (!request) throw notFound('Maintenance request');
      if (scope.buildingId !== request.buildingId) throw badRequest('The expense must belong to the same building as the linked maintenance request.', 'INVALID_SCOPE');
    }
    const number = await nextDocumentNumber(tx, actor.orgId, 'EXPENSE', 'EXP', input.expenseDate.getUTCFullYear());
    const expense = await tx.expense.create({
      data: {
        orgId: actor.orgId, number, scope: input.scope, ...scope, categoryId: category.id, description: input.description, amount: input.amount,
        expenseDate: input.expenseDate, methodId: input.methodId ?? null, supplier: input.supplier ?? null, reference: input.reference ?? null,
        maintenanceRequestId: input.maintenanceRequestId ?? null, status: input.draft ? 'DRAFT' : 'SUBMITTED', recordedById: actor.userId,
      },
    });
    await audit(tx, actor, { action: 'EXPENSE_RECORDED', entityType: 'Expense', entityId: expense.id, summary: `Expense ${number}: ${formatMoney(input.amount)} — ${category.name} — ${input.description}`, newValue: expense });
    return expense;
  });
}

export async function updateExpense(actor: Actor, id: string, input: Partial<ExpenseInput>) {
  return inTransaction(async (tx) => {
    const before = await tx.expense.findFirst({ where: { id, orgId: actor.orgId } });
    if (!before) throw notFound('Expense');
    if (!['DRAFT', 'SUBMITTED', 'REJECTED'].includes(before.status)) throw conflict('An approved expense cannot be edited. Void it and record a new one instead.', 'EXPENSE_LOCKED');
    if (before.recordedById !== actor.userId && !can(actor, 'expense.approve')) throw forbidden('Only the person who recorded this expense can edit it.');
    const scope = input.scope ? await resolveScope(tx, actor.orgId, { scope: input.scope, buildingId: input.buildingId, floorId: input.floorId, roomId: input.roomId }) : {};
    const expenseDate = input.expenseDate ?? before.expenseDate;
    await assertPeriodOpen(tx, actor.orgId, expenseDate, 'This expense');
    const expense = await tx.expense.update({
      where: { id },
      data: {
        scope: input.scope, ...scope, categoryId: input.categoryId, description: input.description, amount: input.amount, expenseDate: input.expenseDate,
        methodId: input.methodId, supplier: input.supplier, reference: input.reference, maintenanceRequestId: input.maintenanceRequestId,
        // Editing a rejected expense sends it back for approval.
        status: before.status === 'REJECTED' ? 'SUBMITTED' : before.status === 'DRAFT' && input.draft === false ? 'SUBMITTED' : undefined,
      },
    });
    const d = diff(before, expense);
    if (d) await audit(tx, actor, { action: 'EXPENSE_UPDATED', entityType: 'Expense', entityId: id, summary: `Expense ${expense.number} updated`, oldValue: d.old, newValue: d.new });
    return expense;
  });
}

export async function decideExpense(actor: Actor, id: string, decision: 'APPROVED' | 'REJECTED' | 'VOID', note?: string) {
  return inTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM expenses WHERE id = ${id} FOR UPDATE`;
    const before = await tx.expense.findFirst({ where: { id, orgId: actor.orgId } });
    if (!before) throw notFound('Expense');
    if (decision === 'VOID') {
      if (before.status !== 'APPROVED') throw conflict('Only an approved expense can be voided.');
      if (!note?.trim()) throw badRequest('A reason is required to void an expense.', 'REASON_REQUIRED');
      await assertPeriodOpen(tx, actor.orgId, before.expenseDate, 'This expense');
    } else {
      if (before.status !== 'SUBMITTED') throw conflict(`This expense is ${before.status.toLowerCase()} and cannot be ${decision.toLowerCase()}.`);
      if (decision === 'REJECTED' && !note?.trim()) throw badRequest('Give a reason for rejecting the expense.', 'REASON_REQUIRED');
      if (decision === 'APPROVED') await assertPeriodOpen(tx, actor.orgId, before.expenseDate, 'This expense');
    }
    const expense = await tx.expense.update({ where: { id }, data: { status: decision, approvedById: decision === 'VOID' ? before.approvedById : actor.userId, decidedAt: new Date(), decisionNote: note?.trim() || null } });
    await audit(tx, actor, {
      action: `EXPENSE_${decision}`, entityType: 'Expense', entityId: id,
      summary: `Expense ${before.number} (${formatMoney(before.amount)}) ${decision.toLowerCase()}${note ? `: ${note}` : ''}`, oldValue: { status: before.status }, newValue: { status: decision, note },
    });
    return expense;
  });
}

export interface ExpenseFilter {
  buildingId?: string;
  floorId?: string;
  roomId?: string;
  categoryId?: string;
  status?: string;
  scope?: string;
  from?: Date;
  to?: Date;
  q?: string;
  maintenanceRequestId?: string;
}

export function expenseWhere(orgId: string, f: ExpenseFilter): Prisma.ExpenseWhereInput {
  return {
    orgId,
    ...(f.buildingId ? { buildingId: f.buildingId } : {}), ...(f.floorId ? { floorId: f.floorId } : {}), ...(f.roomId ? { roomId: f.roomId } : {}),
    ...(f.categoryId ? { categoryId: f.categoryId } : {}), ...(f.status ? { status: f.status as Prisma.ExpenseWhereInput['status'] } : {}),
    ...(f.scope ? { scope: f.scope as Prisma.ExpenseWhereInput['scope'] } : {}),
    ...(f.maintenanceRequestId ? { maintenanceRequestId: f.maintenanceRequestId } : {}),
    ...(f.from || f.to ? { expenseDate: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
    ...(f.q ? { OR: [{ description: { contains: f.q } }, { supplier: { contains: f.q } }, { number: { contains: f.q } }, { reference: { contains: f.q } }] } : {}),
  };
}

export const expenseInclude = {
  building: { select: { id: true, name: true } }, floor: { select: { id: true, name: true } }, room: { select: { id: true, number: true } },
  category: { select: { id: true, name: true } }, method: { select: { id: true, name: true } },
  recordedBy: { select: { id: true, fullName: true } }, approvedBy: { select: { id: true, fullName: true } },
  maintenance: { select: { id: true, number: true, title: true } },
} satisfies Prisma.ExpenseInclude;

export async function listExpenses(orgId: string, f: ExpenseFilter, page: { page: number; pageSize: number }) {
  const where = expenseWhere(orgId, f);
  const [total, items, approved] = await Promise.all([
    prisma.expense.count({ where }),
    prisma.expense.findMany({ where, include: expenseInclude, orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }], skip: (page.page - 1) * page.pageSize, take: page.pageSize }),
    prisma.expense.aggregate({ where: { ...where, status: 'APPROVED' }, _sum: { amount: true } }),
  ]);
  return { items, total, approvedTotal: money(approved._sum.amount) };
}

export async function expenseDetail(orgId: string, id: string) {
  const expense = await prisma.expense.findFirst({ where: { id, orgId }, include: expenseInclude });
  if (!expense) throw notFound('Expense');
  return expense;
}

