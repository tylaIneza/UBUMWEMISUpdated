import { inTransaction, lockContract, lockRoom, prisma, Prisma, type Tx } from '../db.js';
import type { Contract } from '../generated/prisma/client.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { can, type Actor } from '../http/context.js';
import { addDays, businessDate, daysBetween, endOfMonth, isoDate, periodLabel, startOfMonth } from '../lib/dates.js';
import type { Money } from '../lib/money.js';
import { formatMoney, money, sum, ZERO } from '../lib/money.js';
import { audit, diff } from './audit.js';
import { applyCredit, dueDatesFor, generateChargesForContract, rentForPeriod, voidCharge } from './charges.js';
import { assertPeriodOpen } from './periods.js';
import { depositHeld } from './deposits.js';
import { getOrg } from './org.js';
import { OCCUPYING_STATUSES, roomRentOn } from './property.js';
import { nextDocumentNumber } from './sequences.js';

export interface ContractInput {
  tenantId: string;
  roomId: string;
  startDate: Date;
  endDate: Date;
  /** Omit to use the room's standard rent. A different value is a tenant-specific rent and needs authorisation + reason. */
  monthlyRent?: Money;
  rentOverrideReason?: string;
  depositAmount?: Money;
  paymentDueDay?: number;
  graceDays?: number;
  specialTerms?: string;
  /** false = save as DRAFT (room is not occupied yet). */
  activate: boolean;
  /** Import only: first month to bill in this system. */
  billingStart?: Date;
}

const isOccupying = (status: string) => (OCCUPYING_STATUSES as readonly string[]).includes(status);

/** Checks the room can take a new occupant and returns it. Caller holds the room lock. */
async function assertRoomAssignable(tx: Tx, orgId: string, roomId: string, tenantId: string) {
  const room = await tx.room.findFirst({ where: { id: roomId, building: { orgId } }, include: { building: true, floor: true } });
  if (!room) throw notFound('Room');
  const occupant = await tx.contract.findFirst({ where: { roomId, status: { in: [...OCCUPYING_STATUSES] } }, include: { tenant: { select: { fullName: true } } } });
  if (occupant || room.status === 'OCCUPIED') {
    throw conflict('This room is already occupied. An active contract already exists for this room.', 'ROOM_OCCUPIED',
      occupant ? { contractNumber: occupant.contractNumber, tenant: occupant.tenant.fullName } : undefined);
  }
  let reservationId: string | null = null;
  if (room.status === 'RESERVED') {
    const reservation = await tx.reservation.findFirst({ where: { roomId, status: 'ACTIVE' } });
    if (reservation && reservation.tenantId !== tenantId) {
      throw conflict(`Room ${room.number} is reserved for ${reservation.prospectName} until ${isoDate(reservation.expiresOn)}. Cancel the reservation or choose another room.`, 'ROOM_RESERVED');
    }
    reservationId = reservation?.id ?? null;
  } else if (room.status !== 'VACANT') {
    throw conflict(`Room ${room.number} is ${room.status === 'MAINTENANCE' ? 'under maintenance' : 'inactive'} and cannot be assigned to a tenant.`, 'ROOM_NOT_AVAILABLE');
  }
  if (room.building.status !== 'ACTIVE') throw conflict('This building is inactive.', 'ROOM_NOT_AVAILABLE');
  return { room, reservationId };
}

async function occupy(tx: Tx, actor: Actor, contract: Contract, reservationId: string | null, today: Date) {
  await tx.room.update({ where: { id: contract.roomId }, data: { status: 'OCCUPIED' } });
  if (reservationId) await tx.reservation.update({ where: { id: reservationId }, data: { status: 'CONVERTED' } });
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: contract.tenantId } });
  if (tenant.status !== 'ACTIVE') await tx.tenant.update({ where: { id: tenant.id }, data: { status: 'ACTIVE', statusReason: null } });
  await tx.contractRentRate.create({ data: { contractId: contract.id, amount: contract.monthlyRent, effectiveFrom: contract.startDate, reason: 'Contract rent at signing', createdById: actor.userId } });
  await generateChargesForContract(tx, contract, today);
}

export async function createContract(actor: Actor, input: ContractInput) {
  return inTransaction((tx) => createContractTx(tx, actor, input));
}

/** Transaction-aware core of contract creation (also used by the data import, which wraps many in one transaction). */
export async function createContractTx(tx: Tx, actor: Actor, input: ContractInput) {
  const org = await getOrg(actor.orgId, tx);
  const today = businessDate(org.timezone);
  if (input.endDate < input.startDate) throw badRequest('The contract end date must be on or after the start date.', 'INVALID_DATES');
  if (daysBetween(input.startDate, input.endDate) > 366 * 20) throw badRequest('The contract period is unrealistically long. Check the dates.', 'INVALID_DATES');

  {
    await lockRoom(tx, input.roomId);
    const tenant = await tx.tenant.findFirst({ where: { id: input.tenantId, orgId: actor.orgId } });
    if (!tenant) throw notFound('Tenant');
    if (tenant.status === 'BLACKLISTED') throw conflict(`${tenant.fullName} is blacklisted and cannot be given a new contract.`, 'TENANT_BLACKLISTED');
    const { room, reservationId } = await assertRoomAssignable(tx, actor.orgId, input.roomId, input.tenantId);

    const roomRent = (await roomRentOn(tx, room.id, input.startDate)) ?? money(room.monthlyRent);
    const monthlyRent = input.monthlyRent ?? roomRent;
    const overridden = !monthlyRent.equals(roomRent);
    if (overridden) {
      if (!can(actor, 'contract.rent.override')) throw forbidden(`The rent for room ${room.number} is ${formatMoney(roomRent)}. You are not authorised to set a tenant-specific rent.`);
      if (!input.rentOverrideReason?.trim()) throw badRequest('A reason is required when the contract rent differs from the room rent.', 'REASON_REQUIRED');
    }

    const overlap = await tx.contract.findFirst({
      where: { roomId: room.id, status: { not: 'DRAFT' }, startDate: { lte: input.endDate }, OR: [{ terminatedOn: { gte: input.startDate } }, { terminatedOn: null, endDate: { gte: input.startDate } }] },
    });
    if (overlap) {
      throw conflict(`The contract dates overlap contract ${overlap.contractNumber} for this room (${isoDate(overlap.startDate)} – ${isoDate(overlap.terminatedOn ?? overlap.endDate)}). Choose a start date after it ends.`, 'CONTRACT_OVERLAP');
    }

    const contractNumber = await nextDocumentNumber(tx, actor.orgId, 'CONTRACT', org.contractPrefix, input.startDate.getUTCFullYear());
    const contract = await tx.contract.create({
      data: {
        orgId: actor.orgId, contractNumber, tenantId: tenant.id, roomId: room.id, floorId: room.floorId, buildingId: room.buildingId,
        startDate: input.startDate, endDate: input.endDate, monthlyRent, roomRentAtSigning: roomRent,
        rentOverrideReason: overridden ? input.rentOverrideReason!.trim() : null,
        depositAmount: input.depositAmount ?? money(room.depositRequired),
        paymentDueDay: input.paymentDueDay ?? org.defaultDueDay, graceDays: input.graceDays ?? org.defaultGraceDays,
        specialTerms: input.specialTerms ?? null, status: input.activate ? 'ACTIVE' : 'DRAFT',
        activatedAt: input.activate ? new Date() : null, createdById: actor.userId, billingStart: input.billingStart ?? null,
      },
    });
    if (input.activate) await occupy(tx, actor, contract, reservationId, today);
    await audit(tx, actor, {
      action: 'CONTRACT_CREATED', entityType: 'Contract', entityId: contract.id,
      summary: `Contract ${contractNumber} ${input.activate ? 'activated' : 'drafted'}: ${tenant.fullName} → room ${room.number} (${room.building.name}), ${isoDate(input.startDate)} – ${isoDate(input.endDate)}, rent ${formatMoney(monthlyRent)}`,
      newValue: contract,
    });
    if (overridden) {
      await audit(tx, actor, {
        action: 'CONTRACT_RENT_OVERRIDE', entityType: 'Contract', entityId: contract.id,
        summary: `Tenant-specific rent ${formatMoney(monthlyRent)} instead of room rent ${formatMoney(roomRent)}: ${input.rentOverrideReason}`,
        oldValue: { roomRent }, newValue: { monthlyRent, reason: input.rentOverrideReason },
      });
    }
    return contract;
  }
}

export async function activateContract(actor: Actor, id: string) {
  const org = await getOrg(actor.orgId);
  const today = businessDate(org.timezone);
  return inTransaction(async (tx) => {
    const draft = await tx.contract.findFirst({ where: { id, orgId: actor.orgId } });
    if (!draft) throw notFound('Contract');
    await lockRoom(tx, draft.roomId);
    if (draft.status !== 'DRAFT') throw conflict('Only a draft contract can be activated.');
    const { reservationId } = await assertRoomAssignable(tx, actor.orgId, draft.roomId, draft.tenantId);
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: draft.tenantId } });
    if (tenant.status === 'BLACKLISTED') throw conflict(`${tenant.fullName} is blacklisted and cannot be given a new contract.`, 'TENANT_BLACKLISTED');
    const contract = await tx.contract.update({ where: { id }, data: { status: 'ACTIVE', activatedAt: new Date() } });
    await occupy(tx, actor, contract, reservationId, today);
    await audit(tx, actor, { action: 'CONTRACT_ACTIVATED', entityType: 'Contract', entityId: id, summary: `Contract ${contract.contractNumber} activated`, oldValue: { status: 'DRAFT' }, newValue: { status: 'ACTIVE' } });
    return contract;
  });
}

export async function updateContract(
  actor: Actor,
  id: string,
  input: { paymentDueDay?: number; graceDays?: number; specialTerms?: string | null; endDate?: Date; startDate?: Date; depositAmount?: Money },
) {
  return inTransaction(async (tx) => {
    await lockContract(tx, id);
    const before = await tx.contract.findFirst({ where: { id, orgId: actor.orgId } });
    if (!before) throw notFound('Contract');
    if (['TERMINATED', 'RENEWED'].includes(before.status)) throw conflict('A closed contract can no longer be changed.');
    const isDraft = before.status === 'DRAFT';
    if (!isDraft && (input.startDate || input.endDate || input.depositAmount)) {
      throw conflict('Dates and deposit of an active contract cannot be edited. Renew or terminate the contract instead.', 'CONTRACT_LOCKED');
    }
    const contract = await tx.contract.update({
      where: { id },
      data: { paymentDueDay: input.paymentDueDay, graceDays: input.graceDays, specialTerms: input.specialTerms, startDate: input.startDate, endDate: input.endDate, depositAmount: input.depositAmount },
    });
    const d = diff(before, contract);
    if (d) await audit(tx, actor, { action: 'CONTRACT_UPDATED', entityType: 'Contract', entityId: id, summary: `Contract ${contract.contractNumber} terms updated (applies to future charges only)`, oldValue: d.old, newValue: d.new });
    return contract;
  });
}

export async function deleteDraftContract(actor: Actor, id: string) {
  return inTransaction(async (tx) => {
    const contract = await tx.contract.findFirst({ where: { id, orgId: actor.orgId } });
    if (!contract) throw notFound('Contract');
    if (contract.status !== 'DRAFT') throw conflict('Only a draft contract can be discarded. Terminate an active contract instead.');
    await tx.contract.delete({ where: { id } });
    await audit(tx, actor, { action: 'CONTRACT_DRAFT_DISCARDED', entityType: 'Contract', entityId: id, summary: `Draft contract ${contract.contractNumber} discarded`, oldValue: contract });
  });
}

/**
 * Rent increase/decrease during a contract. The current rate row is closed and a new
 * one opened from `effectiveFrom`; charges already generated are not touched.
 */
export async function changeContractRent(actor: Actor, id: string, input: { amount: Money; effectiveFrom: Date; reason: string }) {
  const org = await getOrg(actor.orgId);
  const today = businessDate(org.timezone);
  return inTransaction(async (tx) => {
    await lockContract(tx, id);
    const contract = await tx.contract.findFirst({ where: { id, orgId: actor.orgId } });
    if (!contract) throw notFound('Contract');
    if (!isOccupying(contract.status)) throw conflict('Rent can only be changed on an active contract.');
    if (input.effectiveFrom.getTime() !== startOfMonth(input.effectiveFrom).getTime()) throw badRequest('A rent change must take effect on the first day of a month.', 'INVALID_DATE');
    const lastCharge = await tx.rentCharge.findFirst({ where: { contractId: id, status: { not: 'VOID' } }, orderBy: { period: 'desc' } });
    if (lastCharge && input.effectiveFrom <= lastCharge.period) {
      throw badRequest(`Rent has already been billed up to ${isoDate(endOfMonth(lastCharge.period))}. The change can take effect from ${isoDate(addDays(endOfMonth(lastCharge.period), 1))} at the earliest; use a rent adjustment to correct an existing month.`, 'RETROACTIVE_RENT');
    }
    if (input.effectiveFrom < startOfMonth(today)) throw badRequest('Rent cannot be changed retroactively.', 'RETROACTIVE_RENT');
    if (input.effectiveFrom > contract.endDate) throw badRequest('The effective date is after the contract end date.', 'INVALID_DATE');
    const open = await tx.contractRentRate.findFirst({ where: { contractId: id, effectiveTo: null } });
    if (open && input.effectiveFrom <= open.effectiveFrom) throw badRequest('The new rent must take effect after the current rate started.', 'RETROACTIVE_RENT');
    if (open) await tx.contractRentRate.update({ where: { id: open.id }, data: { effectiveTo: addDays(input.effectiveFrom, -1) } });
    await tx.contractRentRate.create({ data: { contractId: id, amount: input.amount, effectiveFrom: input.effectiveFrom, reason: input.reason, createdById: actor.userId } });
    if (input.effectiveFrom <= today) await tx.contract.update({ where: { id }, data: { monthlyRent: input.amount } });
    await audit(tx, actor, {
      action: 'CONTRACT_RENT_CHANGED', entityType: 'Contract', entityId: id,
      summary: `Contract ${contract.contractNumber} rent ${formatMoney(contract.monthlyRent)} → ${formatMoney(input.amount)} from ${isoDate(input.effectiveFrom)}: ${input.reason}`,
      oldValue: { monthlyRent: contract.monthlyRent }, newValue: { monthlyRent: input.amount, effectiveFrom: isoDate(input.effectiveFrom), reason: input.reason },
    });
    return tx.contract.findUniqueOrThrow({ where: { id } });
  });
}

/** Daily job: contract.monthlyRent mirrors the contract rate in force today. */
export async function syncContractRents(orgId: string, today: Date): Promise<number> {
  return prisma.$executeRaw`
    UPDATE contracts c
    JOIN contract_rent_rates r ON r.contractId = c.id AND r.effectiveFrom <= ${today} AND (r.effectiveTo IS NULL OR r.effectiveTo >= ${today})
    SET c.monthlyRent = r.amount
    WHERE c.orgId = ${orgId} AND c.status IN ('ACTIVE', 'EXPIRING', 'EXPIRED') AND c.monthlyRent <> r.amount`;
}

/**
 * Corrects the dates of a running contract — typically the start, when the tenant starts using the room on a
 * different day from the one the contract (or its first payment) was recorded. Rent is counted from the new start:
 * months outside the new period, and months whose amount or due date changes, are voided (money already paid to
 * them returns to the tenant as credit) and billed again; the credit then settles the new charges, oldest first.
 */
export async function correctContractDates(actor: Actor, id: string, input: { startDate: Date; endDate: Date; reason: string }) {
  const org = await getOrg(actor.orgId);
  const today = businessDate(org.timezone);
  return inTransaction(async (tx) => {
    const found = await tx.contract.findFirst({ where: { id, orgId: actor.orgId } });
    if (!found) throw notFound('Contract');
    await lockRoom(tx, found.roomId);
    await lockContract(tx, id);
    const before = await tx.contract.findUniqueOrThrow({ where: { id } });
    if (!isOccupying(before.status)) {
      throw conflict(before.status === 'DRAFT' ? 'Change the dates of a draft with Edit terms.' : `This contract is ${before.status.toLowerCase()}, so its dates can no longer be corrected.`, 'NOT_ACTIVE');
    }
    if (!input.reason.trim()) throw badRequest('Give a reason for correcting the dates.', 'REASON_REQUIRED');
    if (input.endDate < input.startDate) throw badRequest('The end date must be on or after the start date.', 'INVALID_DATES');
    if (input.endDate < today) throw badRequest('The end date cannot be in the past. To end the tenancy, terminate or renew the contract.', 'INVALID_DATES');
    if (before.startDate.getTime() === input.startDate.getTime() && before.endDate.getTime() === input.endDate.getTime()) return before;
    const clash = await tx.contract.findFirst({
      where: { roomId: before.roomId, id: { not: id }, status: { not: 'DRAFT' }, startDate: { lte: input.endDate }, OR: [{ terminatedOn: { gte: input.startDate } }, { terminatedOn: null, endDate: { gte: input.startDate } }] },
      include: { tenant: { select: { fullName: true } } },
    });
    if (clash) {
      const clashEnd = clash.terminatedOn ?? clash.endDate;
      throw conflict(`These dates overlap contract ${clash.contractNumber} (${clash.tenant.fullName}, ${isoDate(clash.startDate)} – ${isoDate(clashEnd)}) for the same room. The start date must be after ${isoDate(clashEnd)}.`, 'DATES_OVERLAP');
    }

    const contract = await tx.contract.update({
      where: { id },
      data: { startDate: input.startDate, endDate: input.endDate, status: input.endDate < today ? 'EXPIRED' : input.endDate <= addDays(today, org.expiringSoonDays) ? 'EXPIRING' : 'ACTIVE' },
    });
    // Re-bill every month that is no longer in the period, or whose rent or due date is different now.
    const first = startOfMonth(input.startDate);
    const last = startOfMonth(input.endDate);
    const charges = await tx.rentCharge.findMany({ where: { contractId: id, status: { not: 'VOID' } }, orderBy: { period: 'asc' } });
    const stale = [];
    for (const charge of charges) {
      if (charge.period < first || charge.period > last) { stale.push(charge); continue; }
      const { due } = await rentForPeriod(tx, contract, charge.period);
      if (!due.equals(money(charge.amountDue)) || dueDatesFor(contract, charge.period).dueDate.getTime() !== charge.dueDate.getTime()) stale.push(charge);
    }
    const waived = stale.find((c) => money(c.amountWaived).greaterThan(0));
    if (waived) throw conflict(`Part of the rent for ${periodLabel(waived.period)} was waived, and that month would be billed again. Cancel the waiver first, then correct the dates.`, 'CHARGE_WAIVED');
    let released = ZERO;
    for (const charge of stale) {
      await assertPeriodOpen(tx, actor.orgId, charge.period, `The rent charge for ${periodLabel(charge.period)}`);
      released = released.plus(await voidCharge(tx, charge, `Voided: contract dates corrected to ${isoDate(input.startDate)} – ${isoDate(input.endDate)}`, today));
    }
    const created = await generateChargesForContract(tx, contract, today);
    for (const charge of created) await assertPeriodOpen(tx, actor.orgId, charge.period, `The rent charge for ${periodLabel(charge.period)}`);
    await applyCredit(tx, id, today);
    await audit(tx, actor, {
      action: 'CONTRACT_DATES_CORRECTED', entityType: 'Contract', entityId: id,
      summary: `Contract ${contract.contractNumber} dates corrected from ${isoDate(before.startDate)} – ${isoDate(before.endDate)} to ${isoDate(input.startDate)} – ${isoDate(input.endDate)}: ${input.reason.trim()}`,
      oldValue: { startDate: isoDate(before.startDate), endDate: isoDate(before.endDate), status: before.status },
      newValue: { startDate: isoDate(input.startDate), endDate: isoDate(input.endDate), status: contract.status, rebilledMonths: stale.map((c) => isoDate(c.period)), creditReleased: released, reason: input.reason.trim() },
    });
    return contract;
  });
}

export interface TerminationInput {
  moveOutDate: Date;
  reason: string;
  roomCondition?: string;
  /** Put the room into MAINTENANCE instead of VACANT and open a maintenance request. */
  needsMaintenance?: boolean;
  maintenanceNote?: string;
  depositDeduction?: Money;
  deductionReason?: string;
}

/**
 * Move-out. ACTIVE contract → TERMINATED → room VACANT (or MAINTENANCE). Nothing is
 * deleted: the tenant, contract, charges and payments all remain as history.
 */
export async function terminateContract(actor: Actor, id: string, input: TerminationInput) {
  const org = await getOrg(actor.orgId);
  const today = businessDate(org.timezone);
  return inTransaction(async (tx) => {
    const found = await tx.contract.findFirst({ where: { id, orgId: actor.orgId } });
    if (!found) throw notFound('Contract');
    await lockRoom(tx, found.roomId);
    await lockContract(tx, id);
    const contract = await tx.contract.findUniqueOrThrow({ where: { id }, include: { tenant: true, room: true } });
    if (!isOccupying(contract.status)) throw conflict(`This contract is ${contract.status.toLowerCase()} and cannot be terminated.`, 'NOT_ACTIVE');
    if (input.moveOutDate < contract.startDate) throw badRequest('The move-out date cannot be before the contract start date.', 'INVALID_DATES');
    if (input.moveOutDate > today) throw badRequest('The move-out date cannot be in the future. Record the termination on the day the tenant leaves.', 'INVALID_DATES');

    // Bill up to the move-out month, then remove charges for months after it.
    const moveOutMonth = startOfMonth(input.moveOutDate);
    await generateChargesForContract(tx, { ...contract, terminatedOn: input.moveOutDate }, today);
    const later = await tx.rentCharge.findMany({ where: { contractId: id, period: { gt: moveOutMonth }, status: { not: 'VOID' } } });
    let released = ZERO;
    for (const charge of later) released = released.plus(await voidCharge(tx, charge, 'Voided at contract termination', today));
    // Released credit first settles any arrears that remain.
    if (released.greaterThan(0)) await applyCredit(tx, id, today);

    const open = await tx.rentCharge.findMany({ where: { contractId: id, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } }, select: { balance: true } });
    const finalBalance = sum(open.map((c) => c.balance));

    if (input.depositDeduction?.greaterThan(0)) {
      if (!can(actor, 'deposit.manage')) throw forbidden('You are not authorised to record deposit deductions.');
      if (!input.deductionReason?.trim()) throw badRequest('A reason is required for a deposit deduction.', 'REASON_REQUIRED');
      const held = await depositHeld(tx, id);
      if (input.depositDeduction.greaterThan(held)) throw badRequest(`The deduction (${formatMoney(input.depositDeduction)}) exceeds the deposit held (${formatMoney(held)}).`, 'DEPOSIT_EXCEEDED');
      const number = await nextDocumentNumber(tx, actor.orgId, 'DEPOSIT', 'DEP', today.getUTCFullYear());
      await tx.depositTransaction.create({ data: { orgId: actor.orgId, number, contractId: id, type: 'DEDUCTION', amount: input.depositDeduction, txnDate: today, reason: input.deductionReason.trim(), recordedById: actor.userId } });
    }

    const updated = await tx.contract.update({
      where: { id },
      data: { status: 'TERMINATED', terminatedOn: input.moveOutDate, terminationReason: input.reason, roomCondition: input.roomCondition ?? null, finalBalance },
    });
    await tx.room.update({ where: { id: contract.roomId }, data: { status: input.needsMaintenance ? 'MAINTENANCE' : 'VACANT' } });
    if (input.needsMaintenance) {
      const number = await nextDocumentNumber(tx, actor.orgId, 'MAINTENANCE', 'MNT', today.getUTCFullYear());
      await tx.maintenanceRequest.create({
        data: {
          orgId: actor.orgId, number, buildingId: contract.buildingId, floorId: contract.floorId, roomId: contract.roomId,
          title: `Move-out repairs — room ${contract.room.number}`, description: input.maintenanceNote ?? input.roomCondition ?? null,
          priority: 'MEDIUM', status: 'REPORTED', reportedOn: today, reportedById: actor.userId,
        },
      });
    }
    const stillOccupying = await tx.contract.count({ where: { tenantId: contract.tenantId, status: { in: [...OCCUPYING_STATUSES] } } });
    if (stillOccupying === 0 && contract.tenant.status === 'ACTIVE') await tx.tenant.update({ where: { id: contract.tenantId }, data: { status: 'FORMER' } });

    await audit(tx, actor, {
      action: 'CONTRACT_TERMINATED', entityType: 'Contract', entityId: id,
      summary: `Contract ${contract.contractNumber} terminated: ${contract.tenant.fullName} moved out of room ${contract.room.number} on ${isoDate(input.moveOutDate)}. Final rent balance ${formatMoney(finalBalance)}. Reason: ${input.reason}`,
      oldValue: { status: contract.status, roomStatus: 'OCCUPIED' },
      newValue: { status: 'TERMINATED', moveOutDate: isoDate(input.moveOutDate), finalBalance, roomStatus: input.needsMaintenance ? 'MAINTENANCE' : 'VACANT', roomCondition: input.roomCondition, voidedCharges: later.length, creditReleased: released },
    });
    return updated;
  });
}

export interface RenewalInput {
  endDate: Date;
  monthlyRent?: Money;
  rentChangeReason?: string;
  paymentDueDay?: number;
  graceDays?: number;
  specialTerms?: string;
}

/** Renewal: the old contract becomes RENEWED and a new ACTIVE contract starts the day after it ends. */
export async function renewContract(actor: Actor, id: string, input: RenewalInput) {
  const org = await getOrg(actor.orgId);
  const today = businessDate(org.timezone);
  return inTransaction(async (tx) => {
    const found = await tx.contract.findFirst({ where: { id, orgId: actor.orgId } });
    if (!found) throw notFound('Contract');
    await lockRoom(tx, found.roomId);
    await lockContract(tx, id);
    const old = await tx.contract.findUniqueOrThrow({ where: { id }, include: { tenant: true, room: true } });
    if (!isOccupying(old.status)) throw conflict(`This contract is ${old.status.toLowerCase()} and cannot be renewed.`, 'NOT_ACTIVE');
    if (old.tenant.status === 'BLACKLISTED') throw conflict(`${old.tenant.fullName} is blacklisted; the contract cannot be renewed.`, 'TENANT_BLACKLISTED');
    const startDate = addDays(old.endDate, 1);
    if (input.endDate < startDate) throw badRequest(`The new end date must be after ${isoDate(old.endDate)}, when the current contract ends.`, 'INVALID_DATES');
    const monthlyRent = input.monthlyRent ?? money(old.monthlyRent);
    if (!monthlyRent.equals(old.monthlyRent)) {
      if (!can(actor, 'room.rent.manage') && !can(actor, 'contract.rent.override')) throw forbidden('You are not authorised to change the rent on renewal.');
      if (!input.rentChangeReason?.trim()) throw badRequest('A reason is required when the rent changes on renewal.', 'REASON_REQUIRED');
    }
    const roomRent = (await roomRentOn(tx, old.roomId, startDate)) ?? money(old.room.monthlyRent);

    // Order matters: release the room's single "occupying" slot before the new contract takes it.
    await tx.contract.update({ where: { id }, data: { status: 'RENEWED' } });
    const contractNumber = await nextDocumentNumber(tx, actor.orgId, 'CONTRACT', org.contractPrefix, startDate.getUTCFullYear());
    const renewed = await tx.contract.create({
      data: {
        orgId: actor.orgId, contractNumber, tenantId: old.tenantId, roomId: old.roomId, floorId: old.floorId, buildingId: old.buildingId,
        startDate, endDate: input.endDate, monthlyRent, roomRentAtSigning: roomRent,
        rentOverrideReason: monthlyRent.equals(roomRent) ? null : (input.rentChangeReason?.trim() ?? old.rentOverrideReason),
        depositAmount: old.depositAmount, paymentDueDay: input.paymentDueDay ?? old.paymentDueDay, graceDays: input.graceDays ?? old.graceDays,
        specialTerms: input.specialTerms ?? old.specialTerms, status: 'ACTIVE', activatedAt: new Date(), renewedFromId: old.id, createdById: actor.userId,
      },
    });
    await tx.contractRentRate.create({ data: { contractId: renewed.id, amount: monthlyRent, effectiveFrom: startDate, reason: 'Contract rent at renewal', createdById: actor.userId } });

    // The security deposit follows the tenancy to the new contract.
    const held = await depositHeld(tx, old.id);
    if (!held.isZero()) {
      const year = today.getUTCFullYear();
      const outNo = await nextDocumentNumber(tx, actor.orgId, 'DEPOSIT', 'DEP', year);
      await tx.depositTransaction.create({ data: { orgId: actor.orgId, number: outNo, contractId: old.id, type: 'CORRECTION', amount: held.negated(), txnDate: today, reason: `Transferred to renewal contract ${contractNumber}`, recordedById: actor.userId } });
      const inNo = await nextDocumentNumber(tx, actor.orgId, 'DEPOSIT', 'DEP', year);
      await tx.depositTransaction.create({ data: { orgId: actor.orgId, number: inNo, contractId: renewed.id, type: 'CORRECTION', amount: held, txnDate: today, reason: `Transferred from contract ${old.contractNumber}`, recordedById: actor.userId } });
    }
    // Unused advance credit on the old contract is not moved automatically; it stays visible on the old contract.
    await generateChargesForContract(tx, renewed, today);
    await audit(tx, actor, {
      action: 'CONTRACT_RENEWED', entityType: 'Contract', entityId: old.id,
      summary: `Contract ${old.contractNumber} renewed as ${contractNumber} (${isoDate(startDate)} – ${isoDate(input.endDate)}), rent ${formatMoney(monthlyRent)}`,
      oldValue: { status: old.status, endDate: isoDate(old.endDate), monthlyRent: old.monthlyRent }, newValue: { renewedTo: renewed.id, contractNumber, endDate: isoDate(input.endDate), monthlyRent },
    });
    return renewed;
  });
}

/**
 * Daily job. ACTIVE → EXPIRING when the end date is within the configured window;
 * → EXPIRED once the end date has passed. An EXPIRED contract still occupies its room
 * (the tenant has not moved out) until it is renewed or terminated.
 */
export async function refreshContractStatuses(orgId: string, today: Date, expiringSoonDays: number): Promise<{ expiring: number; expired: number }> {
  const horizon = addDays(today, expiringSoonDays);
  const expired = await prisma.contract.updateMany({ where: { orgId, status: { in: ['ACTIVE', 'EXPIRING'] }, endDate: { lt: today } }, data: { status: 'EXPIRED' } });
  const expiring = await prisma.contract.updateMany({ where: { orgId, status: 'ACTIVE', endDate: { gte: today, lte: horizon } }, data: { status: 'EXPIRING' } });
  return { expiring: expiring.count, expired: expired.count };
}

export interface ContractFilter {
  buildingId?: string;
  floorId?: string;
  roomId?: string;
  tenantId?: string;
  status?: string;
  q?: string;
  expiringBefore?: Date;
}

export async function listContracts(orgId: string, f: ContractFilter, page: { page: number; pageSize: number }) {
  const where: Prisma.ContractWhereInput = {
    orgId,
    ...(f.buildingId ? { buildingId: f.buildingId } : {}),
    ...(f.floorId ? { floorId: f.floorId } : {}),
    ...(f.roomId ? { roomId: f.roomId } : {}),
    ...(f.tenantId ? { tenantId: f.tenantId } : {}),
    ...(f.status === 'OCCUPYING' ? { status: { in: [...OCCUPYING_STATUSES] } } : f.status ? { status: f.status as Prisma.ContractWhereInput['status'] } : {}),
    ...(f.expiringBefore ? { endDate: { lte: f.expiringBefore } } : {}),
    ...(f.q ? { OR: [{ contractNumber: { contains: f.q } }, { tenant: { fullName: { contains: f.q } } }, { room: { number: { contains: f.q } } }] } : {}),
  };
  const [total, items] = await Promise.all([
    prisma.contract.count({ where }),
    prisma.contract.findMany({
      where, orderBy: [{ createdAt: 'desc' }], skip: (page.page - 1) * page.pageSize, take: page.pageSize,
      include: {
        tenant: { select: { id: true, fullName: true, phone: true } }, room: { select: { id: true, number: true } },
        floor: { select: { id: true, name: true } },
      building: { select: { id: true, name: true, contractTemplate: true } },
        renewedTo: { select: { id: true, contractNumber: true } },
      },
    }),
  ]);
  const balances = await prisma.rentCharge.groupBy({ by: ['contractId'], where: { contractId: { in: items.map((c) => c.id) }, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } }, _sum: { balance: true } });
  const map = new Map(balances.map((b) => [b.contractId, money(b._sum.balance)]));
  return { items: items.map((c) => ({ ...c, outstanding: map.get(c.id) ?? ZERO })), total };
}

export async function contractDetail(orgId: string, id: string) {
  const contract = await prisma.contract.findFirst({
    where: { id, orgId },
    include: {
      tenant: true, room: { select: { id: true, number: true, monthlyRent: true, status: true } },
      floor: { select: { id: true, name: true } },
      building: { select: { id: true, name: true, contractTemplate: true, companyName: true, managerName: true, tin: true, phone: true, email: true, bankName: true, bankAccount: true, upi: true, district: true, sector: true, cell: true, village: true } },
      rentRates: { orderBy: { effectiveFrom: 'asc' }, include: { createdBy: { select: { fullName: true } } } },
      adjustments: { orderBy: { effectiveFrom: 'desc' } },
      renewedFrom: { select: { id: true, contractNumber: true } }, renewedTo: { select: { id: true, contractNumber: true } },
      createdBy: { select: { fullName: true } },
      deposits: { orderBy: { createdAt: 'asc' }, include: { method: { select: { name: true } }, recordedBy: { select: { fullName: true } } } },
    },
  });
  if (!contract) throw notFound('Contract');
  const charges = await prisma.rentCharge.findMany({ where: { contractId: id, status: { not: 'VOID' } }, select: { amountDue: true, amountPaid: true, amountWaived: true, balance: true, status: true } });
  const credit = await prisma.payment.aggregate({ where: { contractId: id, type: 'PAYMENT', status: 'POSTED' }, _sum: { unallocatedAmount: true } });
  return {
    ...contract,
    summary: {
      totalCharged: sum(charges.map((c) => c.amountDue)), totalPaid: sum(charges.map((c) => c.amountPaid)), totalWaived: sum(charges.map((c) => c.amountWaived)),
      outstanding: sum(charges.map((c) => c.balance)), credit: money(credit._sum.unallocatedAmount), depositHeld: await depositHeld(prisma, id),
    },
  };
}
