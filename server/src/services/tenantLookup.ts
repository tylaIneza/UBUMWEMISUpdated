import { prisma } from '../db.js';
import { AppError, badRequest } from '../errors.js';
import { isoDate } from '../lib/dates.js';
import { normalizeTin, tinProblem } from '../lib/identity.js';
import { Decimal } from '../lib/money.js';
import { audit } from './audit.js';
import type { ClientInfo } from './auth.js';
import { getOrg, orgToday } from './org.js';
import { OCCUPYING_STATUSES } from './property.js';

/**
 * Public "check my balance" on the sign-in page: a tenant enters their TIN and sees their rooms,
 * unpaid months, total outstanding and last payment. No sign-in, so it returns only that summary
 * (never phone, ID, e-mail or payment references), is rate-limited by the route, and every lookup is audited.
 */
export async function lookupByTin(rawTin: string, client: ClientInfo) {
  const problem = tinProblem(rawTin);
  if (problem) throw badRequest(problem, 'TIN_INVALID');
  const tin = normalizeTin(rawTin);
  // TIN is unique per organisation; archived tenants have had their balance waived and are hidden.
  const tenants = await prisma.tenant.findMany({ where: { tin, status: { not: 'ARCHIVED' } }, orderBy: { createdAt: 'asc' } });
  if (!tenants.length) throw new AppError(404, 'TIN_NOT_FOUND', 'No tenant is registered with this TIN number. Check the number, or contact the office.');

  return Promise.all(tenants.map(async (tenant) => {
    const [org, today] = await Promise.all([getOrg(tenant.orgId), orgToday(tenant.orgId)]);
    const [contracts, open, last] = await Promise.all([
      prisma.contract.findMany({
        where: { tenantId: tenant.id, status: { in: [...OCCUPYING_STATUSES] } },
        orderBy: { startDate: 'asc' },
        select: { monthlyRent: true, room: { select: { number: true } }, floor: { select: { name: true } }, building: { select: { name: true } } },
      }),
      prisma.rentCharge.findMany({
        where: { tenantId: tenant.id, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] }, balance: { gt: 0 } },
        orderBy: [{ period: 'asc' }, { createdAt: 'asc' }],
        select: { period: true, amountDue: true, amountPaid: true, balance: true, dueDate: true, overdueFrom: true, room: { select: { number: true } }, building: { select: { name: true } } },
      }),
      prisma.payment.findFirst({
        where: { tenantId: tenant.id, type: 'PAYMENT', status: 'POSTED' },
        orderBy: { paidAt: 'desc' },
        select: { paidAt: true, amount: true, room: { select: { number: true } }, building: { select: { name: true } }, method: { select: { name: true } } },
      }),
    ]);
    await audit(prisma, null, {
      action: 'TENANT_SELF_LOOKUP', entityType: 'Tenant', entityId: tenant.id,
      summary: `Balance looked up by TIN on the sign-in page (${client.ip ?? 'unknown IP'})`,
    }, tenant.orgId);
    return {
      organization: org.name, currency: org.currency, today: isoDate(today),
      tenant: { fullName: tenant.fullName, businessName: tenant.businessName },
      rooms: contracts.map((c) => ({ room: c.room.number, floor: c.floor.name, building: c.building.name, monthlyRent: c.monthlyRent })),
      unpaid: open.map((c) => ({
        period: isoDate(c.period), room: c.room.number, building: c.building.name, dueDate: isoDate(c.dueDate),
        amountDue: c.amountDue, amountPaid: c.amountPaid, balance: c.balance, overdue: c.overdueFrom < today,
      })),
      outstanding: open.reduce((a, c) => a.plus(c.balance), new Decimal(0)),
      lastPayment: last && { date: last.paidAt, amount: last.amount, room: last.room.number, building: last.building.name, method: last.method.name },
    };
  }));
}
