import { inTransaction, lockContract, prisma, type Tx } from '../db.js';
import type { Contract, Prisma, RentCharge } from '../generated/prisma/client.js';
import { addDays, addMonths, dayInMonth, endOfMonth, maxDate, minDate, monthsBetween, startOfMonth } from '../lib/dates.js';
import type { Money } from '../lib/money.js';
import { Decimal, minMoney, money, ZERO } from '../lib/money.js';
import { logger } from '../logger.js';
import { BILLABLE_STATUSES } from './property.js';

export type ChargeStatus = RentCharge['status'];

/** The single place a rent charge's status is derived from its amounts. */
export function deriveStatus(c: { amountDue: Money; amountPaid: Money; amountWaived: Money; overdueFrom: Date }, today: Date): ChargeStatus {
  const balance = c.amountDue.minus(c.amountPaid).minus(c.amountWaived);
  if (balance.lessThanOrEqualTo(0)) return c.amountWaived.greaterThan(0) && c.amountPaid.isZero() ? 'WAIVED' : 'PAID';
  if (c.amountPaid.greaterThan(0)) return 'PARTIAL';
  return today > c.overdueFrom ? 'OVERDUE' : 'UNPAID';
}

/** Last day the contract bills for: the move-out date if terminated, otherwise the contract end date. */
export function billingEnd(contract: Pick<Contract, 'endDate' | 'terminatedOn'>): Date {
  return contract.terminatedOn ? minDate(contract.terminatedOn, contract.endDate) : contract.endDate;
}

/**
 * Share of a calendar month that the contract covers, as [days covered, days in month].
 * A contract running 15 Jan → 14 Jan next year covers 17/31 of its first month and
 * 14/31 of its last, so twelve months of rent are billed in total — and a room that
 * changes tenant mid-month is never billed two full months for the same month.
 */
export function coveredDays(contract: Pick<Contract, 'startDate' | 'endDate'>, period: Date): [number, number] {
  const monthEnd = endOfMonth(period);
  const daysInMonth = monthEnd.getUTCDate();
  const from = maxDate(period, contract.startDate);
  const to = minDate(monthEnd, contract.endDate);
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  return [Math.min(Math.max(days, 0), daysInMonth), daysInMonth];
}

/**
 * What a contract owes for one billing month: the contractual rate in force at the start
 * of that month (or at the contract start, for the first month) plus/minus approved
 * adjustments, prorated by days for a partial first or last month (organization setting).
 * Amounts are rounded to whole francs. An early move-out does not reduce the month's charge.
 */
export async function rentForPeriod(tx: Tx, contract: Contract, period: Date): Promise<RentForPeriod> {
  const on = maxDate(period, contract.startDate);
  const [rates, adjustments, org] = await Promise.all([
    tx.contractRentRate.findMany({ where: { contractId: contract.id, effectiveFrom: { lte: on }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }] } }),
    tx.rentAdjustment.findMany({ where: { contractId: contract.id, status: 'ACTIVE', effectiveFrom: { lte: on }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }] } }),
    tx.organization.findUnique({ where: { id: contract.orgId }, select: { proratePartialMonths: true } }),
  ]);
  return rentFrom(contract, period, rates, adjustments, Boolean(org?.proratePartialMonths));
}

type RentForPeriod = { base: Money; adjustment: Money; due: Money; prorated: [number, number] | null };
type Rate = { amount: Prisma.Decimal; effectiveFrom: Date; effectiveTo: Date | null };
type Adjustment = Rate & { type: string; status: string };

/** The same calculation from rates and adjustments already loaded — used when pricing many contracts at once. */
function rentFrom(contract: Contract, period: Date, rates: Rate[], adjustments: Adjustment[], prorate: boolean): RentForPeriod {
  const on = maxDate(period, contract.startDate);
  const inForce = (r: Rate) => r.effectiveFrom <= on && (r.effectiveTo === null || r.effectiveTo >= on);
  const rate = rates.find(inForce);
  let base = money(rate?.amount ?? contract.monthlyRent);
  let adjustment = ZERO;
  for (const a of adjustments) if (a.status === 'ACTIVE' && inForce(a)) adjustment = a.type === 'DISCOUNT' ? adjustment.minus(a.amount) : adjustment.plus(a.amount);
  const [days, daysInMonth] = coveredDays(contract, period);
  const partial = prorate && days > 0 && days < daysInMonth;
  if (partial) {
    const share = (amount: Money) => amount.times(days).dividedBy(daysInMonth).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    base = share(base);
    adjustment = share(adjustment);
  }
  // A discount can never push a charge below zero.
  if (base.plus(adjustment).lessThan(0)) adjustment = base.negated();
  return { base, adjustment, due: base.plus(adjustment), prorated: partial ? [days, daysInMonth] : null };
}

export function dueDatesFor(contract: Pick<Contract, 'startDate' | 'paymentDueDay' | 'graceDays'>, period: Date) {
  const dueDate = maxDate(dayInMonth(period, contract.paymentDueDay), contract.startDate);
  return { dueDate, overdueFrom: addDays(dueDate, contract.graceDays) };
}

/** Creates the rent charge for one month if it does not exist yet. Caller must hold the contract lock. */
export async function ensureCharge(tx: Tx, contract: Contract, period: Date, today: Date): Promise<RentCharge> {
  const existing = await tx.rentCharge.findFirst({ where: { contractId: contract.id, period, status: { not: 'VOID' } } });
  if (existing) return existing;
  const { base, adjustment, due, prorated } = await rentForPeriod(tx, contract, period);
  const { dueDate, overdueFrom } = dueDatesFor(contract, period);
  const status = deriveStatus({ amountDue: due, amountPaid: ZERO, amountWaived: ZERO, overdueFrom }, today);
  return tx.rentCharge.create({
    data: {
      orgId: contract.orgId, contractId: contract.id, tenantId: contract.tenantId, roomId: contract.roomId,
      floorId: contract.floorId, buildingId: contract.buildingId, period,
      baseAmount: base, adjustmentAmount: adjustment, amountDue: due, balance: due, status, dueDate, overdueFrom,
      note: prorated ? `Prorated: ${prorated[0]} of ${prorated[1]} days` : null,
    },
  });
}

/** Billing months of a contract up to and including the month of `upTo`. */
export function billablePeriods(contract: Pick<Contract, 'startDate' | 'endDate' | 'terminatedOn' | 'billingStart'>, upTo: Date): Date[] {
  const first = firstBillablePeriod(contract);
  const last = minDate(startOfMonth(upTo), startOfMonth(billingEnd(contract)));
  if (last < first) return [];
  return monthsBetween(first, last);
}

export function firstBillablePeriod(contract: Pick<Contract, 'startDate' | 'billingStart'>): Date {
  return startOfMonth(contract.billingStart ? maxDate(contract.billingStart, contract.startDate) : contract.startDate);
}

/** The next month this contract could still be billed for after `after` (used for advance payments), or null. */
export function nextBillablePeriod(contract: Pick<Contract, 'startDate' | 'endDate' | 'terminatedOn' | 'status' | 'billingStart'>, after: Date | null): Date | null {
  if (!(BILLABLE_STATUSES as readonly string[]).includes(contract.status)) return null;
  const candidate = after ? maxDate(addMonths(after, 1), firstBillablePeriod(contract)) : firstBillablePeriod(contract);
  return candidate <= startOfMonth(billingEnd(contract)) ? candidate : null;
}

/** Generates every missing charge of a contract up to the current month. Caller holds the contract lock. */
export async function generateChargesForContract(tx: Tx, contract: Contract, today: Date): Promise<RentCharge[]> {
  if (contract.status === 'DRAFT') return [];
  const created: RentCharge[] = [];
  const periods = billablePeriods(contract, today);
  if (!periods.length) return created;
  const existing = new Set(
    (await tx.rentCharge.findMany({ where: { contractId: contract.id, status: { not: 'VOID' } }, select: { period: true } })).map((c) => c.period.getTime()),
  );
  for (const period of periods) {
    if (existing.has(period.getTime())) continue;
    created.push(await ensureCharge(tx, contract, period, today));
  }
  return created;
}

/** Applies a signed change to a charge's paid amount and re-derives balance and status. */
export async function applyToCharge(tx: Tx, chargeId: string, delta: Money, today: Date): Promise<RentCharge> {
  const charge = await tx.rentCharge.findUniqueOrThrow({ where: { id: chargeId } });
  const amountPaid = money(charge.amountPaid).plus(delta);
  const balance = money(charge.amountDue).minus(amountPaid).minus(charge.amountWaived);
  const status = charge.status === 'VOID' ? 'VOID' : deriveStatus({ amountDue: money(charge.amountDue), amountPaid, amountWaived: money(charge.amountWaived), overdueFrom: charge.overdueFrom }, today);
  return tx.rentCharge.update({ where: { id: chargeId }, data: { amountPaid, balance, status } });
}

/**
 * Voids one rent charge. Money already allocated to it goes back to its payments as unallocated credit
 * (append-only: a negative allocation is posted). Returns the amount released. Caller holds the contract lock.
 */
export async function voidCharge(tx: Tx, charge: RentCharge, note: string, today: Date): Promise<Money> {
  let released = ZERO;
  const allocations = await tx.paymentAllocation.groupBy({ by: ['paymentId'], where: { rentChargeId: charge.id }, _sum: { amount: true } });
  for (const a of allocations) {
    const net = money(a._sum.amount);
    if (net.lessThanOrEqualTo(0)) continue;
    await tx.paymentAllocation.create({ data: { paymentId: a.paymentId, rentChargeId: charge.id, amount: net.negated() } });
    await applyToCharge(tx, charge.id, net.negated(), today);
    const p = await tx.payment.findUniqueOrThrow({ where: { id: a.paymentId } });
    if (p.status === 'POSTED') {
      await tx.payment.update({ where: { id: p.id }, data: { allocatedAmount: money(p.allocatedAmount).minus(net), unallocatedAmount: money(p.unallocatedAmount).plus(net) } });
      released = released.plus(net);
    }
  }
  await tx.rentCharge.update({ where: { id: charge.id }, data: { status: 'VOID', amountWaived: 0, balance: money(charge.amountDue), note } });
  return released;
}

/**
 * Uses a contract's unallocated advance credit to settle outstanding charges, oldest
 * payment and oldest charge first. Caller holds the contract lock.
 */
export async function applyCredit(tx: Tx, contractId: string, today: Date): Promise<Money> {
  const credits = await tx.payment.findMany({
    where: { contractId, type: 'PAYMENT', status: 'POSTED', unallocatedAmount: { gt: 0 } },
    orderBy: { paidAt: 'asc' },
  });
  let applied = ZERO;
  for (const payment of credits) {
    let available = money(payment.unallocatedAmount);
    const charges = await tx.rentCharge.findMany({
      where: { contractId, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] }, balance: { gt: 0 } },
      orderBy: { period: 'asc' },
    });
    if (!charges.length) break;
    for (const charge of charges) {
      if (available.lessThanOrEqualTo(0)) break;
      const amount = minMoney(available, money(charge.balance));
      await tx.paymentAllocation.create({ data: { paymentId: payment.id, rentChargeId: charge.id, amount } });
      await applyToCharge(tx, charge.id, amount, today);
      available = available.minus(amount);
      applied = applied.plus(amount);
    }
    await tx.payment.update({
      where: { id: payment.id },
      data: { unallocatedAmount: available, allocatedAmount: money(payment.amount).minus(available) },
    });
  }
  return applied;
}

/**
 * Monthly billing run (idempotent): creates the missing charges of every billable
 * contract up to the current month and applies any advance credit to them.
 */
export async function generateDueCharges(orgId: string, today: Date): Promise<{ contracts: number; created: number; creditApplied: Money }> {
  const contracts = await prisma.contract.findMany({ where: { orgId, status: { in: [...BILLABLE_STATUSES] } }, select: { id: true } });
  let created = 0;
  let creditApplied = ZERO;
  for (const { id } of contracts) {
    try {
      await inTransaction(async (tx) => {
        await lockContract(tx, id);
        const contract = await tx.contract.findUniqueOrThrow({ where: { id } });
        const fresh = await generateChargesForContract(tx, contract, today);
        created += fresh.length;
        if (fresh.length) creditApplied = creditApplied.plus(await applyCredit(tx, id, today));
      });
    } catch (err) {
      logger.error({ err, contractId: id }, 'rent charge generation failed for contract');
    }
  }
  return { contracts: contracts.length, created, creditApplied };
}

/** Marks unpaid charges whose grace period has passed as OVERDUE. Cheap and idempotent. */
export async function refreshOverdue(orgId: string, today: Date): Promise<number> {
  return prisma.$executeRaw`
    UPDATE rent_charges SET status = 'OVERDUE', updatedAt = NOW(3)
    WHERE orgId = ${orgId} AND status = 'UNPAID' AND overdueFrom < ${today}`;
}

/** Sum of rent that active contracts will be billed for a future month (forecast). */
export async function expectedRentForMonth(orgId: string, period: Date, buildingId?: string): Promise<Money> {
  const monthEnd = endOfMonth(period);
  const contracts = await prisma.contract.findMany({
    where: {
      orgId, status: { in: ['ACTIVE', 'EXPIRING'] }, startDate: { lte: monthEnd }, endDate: { gte: period },
      ...(buildingId ? { buildingId } : {}),
    },
  });
  // Load every contract's rates and adjustments in a few queries (not several per contract), then price in memory.
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { proratePartialMonths: true } });
  const rates = new Map<string, Rate[]>();
  const adjustments = new Map<string, Adjustment[]>();
  for (let i = 0; i < contracts.length; i += 2000) {
    const ids = contracts.slice(i, i + 2000).map((c) => c.id);
    const [r, a] = await Promise.all([
      prisma.contractRentRate.findMany({ where: { contractId: { in: ids }, effectiveFrom: { lte: monthEnd } } }),
      prisma.rentAdjustment.findMany({ where: { contractId: { in: ids }, status: 'ACTIVE', effectiveFrom: { lte: monthEnd } } }),
    ]);
    for (const x of r) rates.set(x.contractId, [...(rates.get(x.contractId) ?? []), x]);
    for (const x of a) adjustments.set(x.contractId, [...(adjustments.get(x.contractId) ?? []), x]);
  }
  let total = ZERO;
  for (const c of contracts) total = total.plus(rentFrom(c, period, rates.get(c.id) ?? [], adjustments.get(c.id) ?? [], Boolean(org?.proratePartialMonths)).due);
  return total;
}
