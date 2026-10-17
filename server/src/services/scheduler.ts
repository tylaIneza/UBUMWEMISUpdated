import { prisma } from '../db.js';
import { addDays, businessDate, isoDate, periodLabel } from '../lib/dates.js';
import { formatMoney } from '../lib/money.js';
import { logger } from '../logger.js';
import { generateDueCharges, refreshOverdue } from './charges.js';
import { refreshContractStatuses, syncContractRents } from './contracts.js';
import { missingEbmWhere } from './invoices.js';
import { notifyPermission } from './notifications.js';
import { endReservation, syncRoomRents } from './property.js';

/**
 * Housekeeping that keeps derived state current. Every step is idempotent, so the job
 * can safely run at start-up, hourly, and on demand ("Run billing now").
 */
export async function runDailyJobs(orgId: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  const today = businessDate(org.timezone);
  const day = isoDate(today);

  await syncRoomRents(orgId, today);
  await syncContractRents(orgId, today);
  const contractChanges = await refreshContractStatuses(orgId, today, org.expiringSoonDays);

  const stale = await prisma.reservation.findMany({ where: { status: 'ACTIVE', expiresOn: { lt: today }, room: { building: { orgId } } }, select: { id: true } });
  for (const r of stale) await endReservation(null, orgId, r.id, 'EXPIRED').catch((err) => logger.warn({ err, reservationId: r.id }, 'reservation expiry failed'));

  const billing = await generateDueCharges(orgId, today);
  const newlyOverdue = await refreshOverdue(orgId, today);

  // ── Notifications ──
  const overdue = await prisma.rentCharge.findMany({
    where: { orgId, balance: { gt: 0 }, overdueFrom: { lt: today, gte: addDays(today, -3) }, status: { in: ['OVERDUE', 'PARTIAL'] } },
    include: { tenant: { select: { fullName: true } }, room: { select: { number: true } } },
    take: 500,
  });
  for (const c of overdue) {
    await notifyPermission(prisma, orgId, 'payment.create', {
      category: 'RENT', title: `Rent overdue — room ${c.room.number}`, entityType: 'Tenant', entityId: c.tenantId, dedupeKey: `overdue:${c.id}`,
      body: `${c.tenant.fullName} owes ${formatMoney(c.balance)} for ${periodLabel(c.period)} (due ${isoDate(c.dueDate)}).`,
    });
  }
  const dueSoon = await prisma.rentCharge.count({ where: { orgId, balance: { gt: 0 }, dueDate: { gte: today, lte: addDays(today, org.dueSoonDays) }, status: { in: ['UNPAID', 'PARTIAL'] } } });
  if (dueSoon > 0) {
    await notifyPermission(prisma, orgId, 'payment.create', { category: 'RENT', title: 'Rent due soon', body: `${dueSoon} rent charge(s) fall due within ${org.dueSoonDays} day(s).`, entityType: 'RentLedger', dedupeKey: `due-soon:${day}` });
  }
  const expiring = await prisma.contract.findMany({ where: { orgId, status: { in: ['EXPIRING', 'EXPIRED'] } }, include: { tenant: { select: { fullName: true } }, room: { select: { number: true } } }, take: 500 });
  for (const c of expiring) {
    await notifyPermission(prisma, orgId, 'contract.manage', {
      category: 'CONTRACT', entityType: 'Contract', entityId: c.id, dedupeKey: `contract-${c.status.toLowerCase()}:${c.id}`,
      title: c.status === 'EXPIRED' ? `Contract expired — room ${c.room.number}` : `Contract expiring — room ${c.room.number}`,
      body: `${c.contractNumber} (${c.tenant.fullName}) ${c.status === 'EXPIRED' ? 'ended' : 'ends'} on ${isoDate(c.endDate)}. Renew or terminate it.`,
    });
  }
  const missingEbm = await prisma.invoice.count({ where: missingEbmWhere(orgId) });
  if (missingEbm > 0) {
    await notifyPermission(prisma, orgId, 'invoice.manage', { category: 'FINANCE', title: 'Missing EBM references', body: `${missingEbm} payment(s) have no recorded EBM/invoice reference.`, entityType: 'Invoice', dedupeKey: `missing-ebm:${day}` });
  }
  const summary = { day, ...contractChanges, reservationsExpired: stale.length, chargesCreated: billing.created, creditApplied: billing.creditApplied.toFixed(2), newlyOverdue };
  logger.info(summary, 'daily jobs completed');
  return summary;
}

let timer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  const tick = async () => {
    try {
      const orgs = await prisma.organization.findMany({ select: { id: true } });
      for (const org of orgs) await runDailyJobs(org.id);
    } catch (err) {
      logger.error({ err }, 'scheduled jobs failed');
    }
  };
  void tick();
  timer = setInterval(() => void tick(), 60 * 60 * 1000);
  timer.unref();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
