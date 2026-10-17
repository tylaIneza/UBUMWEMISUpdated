import { inTransaction, prisma, type Db } from '../db.js';
import { conflict, notFound } from '../errors.js';
import type { Actor } from '../http/context.js';
import { isoDate, periodLabel, startOfMonth } from '../lib/dates.js';
import { audit } from './audit.js';
import { orgToday } from './org.js';

export async function isPeriodClosed(db: Db, orgId: string, date: Date): Promise<boolean> {
  const p = await db.accountingPeriod.findUnique({ where: { orgId_period: { orgId, period: startOfMonth(date) } } });
  return p?.status === 'CLOSED';
}

/** Rejects a financial entry dated inside a closed accounting period. */
export async function assertPeriodOpen(db: Db, orgId: string, date: Date, what = 'This transaction'): Promise<void> {
  if (await isPeriodClosed(db, orgId, date)) {
    throw conflict(
      `${what} is dated ${isoDate(date)}, but the accounting period ${periodLabel(startOfMonth(date))} is closed. Corrections must be posted in an open period as a reversal or adjustment.`,
      'PERIOD_CLOSED',
    );
  }
}

export async function listPeriods(orgId: string) {
  return prisma.accountingPeriod.findMany({ where: { orgId }, orderBy: { period: 'desc' }, include: { closedBy: { select: { fullName: true } } } });
}

export async function closePeriod(actor: Actor, period: Date, note?: string) {
  const month = startOfMonth(period);
  const today = await orgToday(actor.orgId);
  if (month >= startOfMonth(today)) throw conflict('Only a month that has already ended can be closed.', 'PERIOD_NOT_ENDED');
  return inTransaction(async (tx) => {
    const pending = await tx.expense.count({ where: { orgId: actor.orgId, status: { in: ['DRAFT', 'SUBMITTED'] }, expenseDate: { gte: month, lt: new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1)) } } });
    if (pending > 0) throw conflict(`${pending} expense(s) dated in ${periodLabel(month)} are still awaiting approval. Approve or reject them before closing the period.`, 'PERIOD_HAS_PENDING');
    const row = await tx.accountingPeriod.upsert({
      where: { orgId_period: { orgId: actor.orgId, period: month } },
      create: { orgId: actor.orgId, period: month, status: 'CLOSED', closedById: actor.userId, closedAt: new Date(), note: note ?? null },
      update: { status: 'CLOSED', closedById: actor.userId, closedAt: new Date(), note: note ?? null },
    });
    await audit(tx, actor, { action: 'PERIOD_CLOSED', entityType: 'AccountingPeriod', entityId: row.id, summary: `Accounting period ${periodLabel(month)} closed`, newValue: { period: isoDate(month), note } });
    return row;
  });
}

export async function reopenPeriod(actor: Actor, id: string, reason: string) {
  return inTransaction(async (tx) => {
    const row = await tx.accountingPeriod.findFirst({ where: { id, orgId: actor.orgId } });
    if (!row) throw notFound('Accounting period');
    if (row.status !== 'CLOSED') throw conflict('This period is already open.');
    const updated = await tx.accountingPeriod.update({ where: { id }, data: { status: 'OPEN', note: `Reopened: ${reason}`.slice(0, 255) } });
    await audit(tx, actor, { action: 'PERIOD_REOPENED', entityType: 'AccountingPeriod', entityId: id, summary: `Accounting period ${periodLabel(row.period)} reopened: ${reason}` });
    return updated;
  });
}
