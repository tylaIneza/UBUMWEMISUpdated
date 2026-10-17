import { inTransaction, prisma, Prisma } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { can, type Actor } from '../http/context.js';
import { money, sum, ZERO } from '../lib/money.js';
import { parsePhone, phoneSearchDigits } from '../lib/phone.js';
import { idNumberProblem, normalizeIdNumber, normalizeTin, tinProblem, type IdType } from '../lib/identity.js';
import { audit, diff } from './audit.js';
import { orgToday } from './org.js';
import { BILLABLE_STATUSES, OCCUPYING_STATUSES } from './property.js';

export interface TenantInput {
  fullName: string;
  idType?: string;
  idNumber: string;
  phone: string;
  email?: string | null;
  address?: string | null;
  businessName?: string | null;
  tin?: string | null;
  district?: string | null;
  sector?: string | null;
  cell?: string | null;
  village?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  notes?: string | null;
}

/** Finds the tenant (if any) already registered with this document number. */
export async function findByIdNumber(orgId: string, idNumber: string, exceptId?: string) {
  return prisma.tenant.findFirst({
    where: { orgId, idNumber: normalizeIdNumber(idNumber), ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, fullName: true, phone: true, status: true },
  });
}

/** Rejects an invalid number, or one that already belongs to another tenant (with a message naming them). */
async function assertIdNumber(orgId: string, idType: IdType, idNumber: string, exceptId?: string) {
  const problem = idNumberProblem(idType, idNumber);
  if (problem) throw badRequest(problem, 'INVALID_ID_NUMBER', { fields: { idNumber: problem } });
  const existing = await findByIdNumber(orgId, idNumber, exceptId);
  if (existing) {
    throw conflict(`ID number ${normalizeIdNumber(idNumber)} is already registered to ${existing.fullName}. One ID or passport number can belong to only one tenant — open that tenant instead of registering them again.`, 'DUPLICATE_TENANT',
      { fields: { idNumber: `Already registered to ${existing.fullName}.` }, tenantId: existing.id, fullName: existing.fullName });
  }
}

/** Finds the tenant (if any) already registered with this TIN. */
export async function findByTin(orgId: string, tin: string, exceptId?: string) {
  return prisma.tenant.findFirst({
    where: { orgId, tin: normalizeTin(tin), ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, fullName: true, phone: true, status: true },
  });
}

/** A TIN is the number on one RDB certificate, so it can belong to only one tenant. */
async function assertTin(orgId: string, tin: string, exceptId?: string) {
  const problem = tinProblem(tin);
  if (problem) throw badRequest(problem, 'INVALID_TIN', { fields: { tin: problem } });
  const existing = await findByTin(orgId, tin, exceptId);
  if (existing) {
    throw conflict(`TIN ${normalizeTin(tin)} is already registered to ${existing.fullName}. One TIN (RDB certificate) can belong to only one tenant.`, 'DUPLICATE_TIN',
      { fields: { tin: `Already registered to ${existing.fullName}.` }, tenantId: existing.id, fullName: existing.fullName });
  }
}

export async function createTenant(actor: Actor, input: TenantInput) {
  const idType = (input.idType ?? 'NATIONAL_ID') as IdType;
  await assertIdNumber(actor.orgId, idType, input.idNumber);
  if (input.tin) await assertTin(actor.orgId, input.tin);
  return inTransaction(async (tx) => {
    // The unique index on (organization, ID number) is the final guarantee if two people register the same person at once.
    const tenant = await tx.tenant.create({ data: { orgId: actor.orgId, ...input, idNumber: normalizeIdNumber(input.idNumber), tin: input.tin ? normalizeTin(input.tin) : null, idType, status: 'INACTIVE' } });
    await audit(tx, actor, { action: 'TENANT_CREATED', entityType: 'Tenant', entityId: tenant.id, summary: `Tenant ${tenant.fullName} registered`, newValue: tenant });
    return tenant;
  });
}

export async function updateTenant(actor: Actor, id: string, input: Partial<TenantInput>) {
  const current = await prisma.tenant.findFirst({ where: { id, orgId: actor.orgId } });
  if (!current) throw notFound('Tenant');
  const idType = (input.idType ?? current.idType) as IdType;
  const idNumber = input.idNumber ?? current.idNumber;
  // Check the number when it (or its type) changes, so older records can still be edited until they are corrected.
  if (normalizeIdNumber(idNumber) !== current.idNumber || idType !== current.idType) await assertIdNumber(actor.orgId, idType, idNumber, id);
  if (input.tin && normalizeTin(input.tin) !== current.tin) await assertTin(actor.orgId, input.tin, id);
  return inTransaction(async (tx) => {
    const before = await tx.tenant.findFirst({ where: { id, orgId: actor.orgId } });
    if (!before) throw notFound('Tenant');
    const tenant = await tx.tenant.update({ where: { id }, data: { ...input, idNumber: input.idNumber === undefined ? undefined : normalizeIdNumber(input.idNumber), tin: input.tin ? normalizeTin(input.tin) : input.tin } });
    const d = diff(before, tenant);
    if (d) await audit(tx, actor, { action: 'TENANT_UPDATED', entityType: 'Tenant', entityId: id, summary: `Tenant ${tenant.fullName} updated`, oldValue: d.old, newValue: d.new });
    return tenant;
  });
}

/**
 * Manual status changes. ACTIVE / FORMER follow from contracts automatically; staff can
 * only mark a tenant without a current contract INACTIVE, or (with authority) blacklist.
 */
export async function setTenantStatus(actor: Actor, id: string, status: 'INACTIVE' | 'BLACKLISTED' | 'FORMER', reason?: string) {
  return inTransaction(async (tx) => {
    const tenant = await tx.tenant.findFirst({ where: { id, orgId: actor.orgId } });
    if (!tenant) throw notFound('Tenant');
    const blacklistChange = status === 'BLACKLISTED' || tenant.status === 'BLACKLISTED';
    if (blacklistChange) {
      if (!can(actor, 'tenant.blacklist')) throw forbidden('You are not authorised to change a tenant\'s blacklist status.');
      if (!reason?.trim()) throw badRequest('A reason is required to change blacklist status.', 'REASON_REQUIRED');
    }
    const occupying = await tx.contract.count({ where: { tenantId: id, status: { in: [...OCCUPYING_STATUSES] } } });
    if (occupying > 0 && status !== 'BLACKLISTED') throw conflict('This tenant has an active contract. Terminate the contract first.', 'TENANT_ACTIVE');
    const updated = await tx.tenant.update({ where: { id }, data: { status, statusReason: reason?.trim() || null } });
    await audit(tx, actor, { action: status === 'BLACKLISTED' ? 'TENANT_BLACKLISTED' : 'TENANT_STATUS_CHANGED', entityType: 'Tenant', entityId: id, summary: `Tenant ${tenant.fullName}: ${tenant.status} → ${status}${reason ? ` (${reason})` : ''}`, oldValue: { status: tenant.status }, newValue: { status, reason } });
    return updated;
  });
}

export interface TenantFilter {
  q?: string;
  status?: string;
  buildingId?: string;
  floorId?: string;
  withArrears?: boolean;
}

export async function listTenants(orgId: string, f: TenantFilter, page: { page: number; pageSize: number }, sort?: string, dir: 'asc' | 'desc' = 'asc') {
  const where: Prisma.TenantWhereInput = {
    orgId,
    ...(f.status ? { status: f.status as Prisma.TenantWhereInput['status'] } : {}),
    ...(f.buildingId || f.floorId
      ? { contracts: { some: { status: { in: [...OCCUPYING_STATUSES] }, ...(f.buildingId ? { buildingId: f.buildingId } : {}), ...(f.floorId ? { floorId: f.floorId } : {}) } } }
      : {}),
    ...(f.withArrears ? { charges: { some: { status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } } } } : {}),
    ...(f.q
      ? { OR: [{ fullName: { contains: f.q } }, { phone: { contains: phoneSearchDigits(f.q) ?? f.q } }, { idNumber: { contains: f.q } }, { businessName: { contains: f.q } }, { email: { contains: f.q } }] }
      : {}),
  };
  const [total, tenants] = await Promise.all([
    prisma.tenant.count({ where }),
    prisma.tenant.findMany({
      where, orderBy: sort === 'created' ? { createdAt: dir } : { fullName: dir }, skip: (page.page - 1) * page.pageSize, take: page.pageSize,
      include: {
        contracts: {
          where: { status: { in: [...OCCUPYING_STATUSES] } },
          select: { id: true, contractNumber: true, status: true, monthlyRent: true, endDate: true, room: { select: { id: true, number: true } }, floor: { select: { name: true } }, building: { select: { id: true, name: true } } },
        },
      },
    }),
  ]);
  const balances = await prisma.rentCharge.groupBy({ by: ['tenantId'], where: { tenantId: { in: tenants.map((t) => t.id) }, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } }, _sum: { balance: true } });
  const map = new Map(balances.map((b) => [b.tenantId, money(b._sum.balance)]));
  return { items: tenants.map(({ contracts, ...t }) => ({ ...t, currentContracts: contracts, outstanding: map.get(t.id) ?? ZERO })), total };
}

export async function tenantDetail(orgId: string, id: string) {
  const tenant = await prisma.tenant.findFirst({
    where: { id, orgId },
    include: {
      contracts: {
        orderBy: { startDate: 'desc' },
        include: { room: { select: { id: true, number: true } }, floor: { select: { id: true, name: true } }, building: { select: { id: true, name: true } } },
      },
    },
  });
  if (!tenant) throw notFound('Tenant');
  const today = await orgToday(orgId);
  const open = await prisma.rentCharge.findMany({ where: { tenantId: id, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } }, select: { balance: true, overdueFrom: true, contractId: true } });
  const [paid, credit, lastPayment] = await Promise.all([
    prisma.payment.aggregate({ where: { tenantId: id }, _sum: { amount: true } }),
    prisma.payment.aggregate({ where: { tenantId: id, type: 'PAYMENT', status: 'POSTED' }, _sum: { unallocatedAmount: true } }),
    prisma.payment.findFirst({ where: { tenantId: id, type: 'PAYMENT', status: 'POSTED' }, orderBy: { paidAt: 'desc' }, select: { paidAt: true, amount: true } }),
  ]);
  const current = tenant.contracts.filter((c) => (OCCUPYING_STATUSES as readonly string[]).includes(c.status));
  const byContract = new Map<string, ReturnType<typeof money>>();
  for (const c of open) byContract.set(c.contractId, (byContract.get(c.contractId) ?? ZERO).plus(c.balance));
  return {
    ...tenant,
    idNumberProblem: idNumberProblem(tenant.idType as IdType, tenant.idNumber),
    phoneProblem: parsePhone(tenant.phone).e164 === tenant.phone ? null : (parsePhone(tenant.phone).problem ?? 'Saved in an old format.'),
    contracts: tenant.contracts.map((c) => ({ ...c, outstanding: byContract.get(c.id) ?? ZERO, billable: (BILLABLE_STATUSES as readonly string[]).includes(c.status) })),
    currentContracts: current,
    financial: {
      outstanding: sum(open.map((c) => c.balance)),
      overdue: sum(open.filter((c) => c.overdueFrom < today).map((c) => c.balance)),
      totalPaid: money(paid._sum.amount), credit: money(credit._sum.unallocatedAmount),
      monthlyRent: sum(current.map((c) => c.monthlyRent)), lastPayment,
    },
  };
}

export interface LedgerFilter {
  tenantId?: string;
  contractId?: string;
  roomId?: string;
  buildingId?: string;
  floorId?: string;
  status?: string;
  from?: Date;
  to?: Date;
  overdueOnly?: boolean;
  /** Only rent whose due date has passed and is not fully paid (unpaid, partly paid or overdue). */
  owingOnly?: boolean;
  includeVoid?: boolean;
}

/** Rent ledger rows (one per billed month) with the payments applied to each. */
export async function rentLedger(orgId: string, f: LedgerFilter, page: { page: number; pageSize: number }, dir: 'asc' | 'desc' = 'desc') {
  const today = await orgToday(orgId);
  const where: Prisma.RentChargeWhereInput = {
    orgId,
    ...(f.tenantId ? { tenantId: f.tenantId } : {}), ...(f.contractId ? { contractId: f.contractId } : {}),
    ...(f.roomId ? { roomId: f.roomId } : {}), ...(f.buildingId ? { buildingId: f.buildingId } : {}), ...(f.floorId ? { floorId: f.floorId } : {}),
    ...(f.status ? { status: f.status as Prisma.RentChargeWhereInput['status'] } : f.includeVoid ? {} : { status: { not: 'VOID' } }),
    ...(f.overdueOnly ? { balance: { gt: 0 }, overdueFrom: { lt: today }, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } } : {}),
    // In AND so it combines with the status filter above instead of replacing it.
    // Due date already passed — the same rule as the arrears report, so its PDF matches this list.
    ...(f.owingOnly ? { AND: [{ balance: { gt: 0 }, dueDate: { lt: today }, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } }] } : {}),
    ...(f.from || f.to ? { period: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
  };
  const [total, items, totals] = await Promise.all([
    prisma.rentCharge.count({ where }),
    prisma.rentCharge.findMany({
      where, orderBy: [{ period: dir }, { createdAt: 'asc' }], skip: (page.page - 1) * page.pageSize, take: page.pageSize,
      include: {
        tenant: { select: { id: true, fullName: true, phone: true } }, room: { select: { id: true, number: true } },
        floor: { select: { name: true } }, building: { select: { id: true, name: true } },
        contract: { select: { id: true, contractNumber: true, status: true } },
        allocations: {
          orderBy: { createdAt: 'asc' },
          include: { payment: { select: { id: true, type: true, status: true, paidAt: true, amount: true, reference: true, method: { select: { name: true } }, receipt: { select: { receiptNumber: true } }, recordedBy: { select: { fullName: true } } } } },
        },
      },
    }),
    prisma.rentCharge.aggregate({ where, _sum: { amountDue: true, amountPaid: true, amountWaived: true, balance: true } }),
  ]);
  return {
    items: items.map((c) => ({ ...c, isOverdue: money(c.balance).greaterThan(0) && c.overdueFrom < today && c.status !== 'VOID', daysOverdue: money(c.balance).greaterThan(0) && c.overdueFrom < today ? Math.round((today.getTime() - c.overdueFrom.getTime()) / 86_400_000) : 0 })),
    total,
    totals: { amountDue: money(totals._sum.amountDue), amountPaid: money(totals._sum.amountPaid), amountWaived: money(totals._sum.amountWaived), balance: money(totals._sum.balance) },
  };
}
