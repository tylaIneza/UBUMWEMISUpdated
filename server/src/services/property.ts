import { inTransaction, lockRoom, prisma, Prisma, type Tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { Actor } from '../http/context.js';
import { addDays, isoDate } from '../lib/dates.js';
import type { Money } from '../lib/money.js';
import { money, sum } from '../lib/money.js';
import { audit, diff } from './audit.js';
import { orgToday } from './org.js';

export const OCCUPYING_STATUSES = ['ACTIVE', 'EXPIRING', 'EXPIRED'] as const;
/** Contracts that are still billed: occupying ones plus a RENEWED contract running out its remaining months. */
export const BILLABLE_STATUSES = ['ACTIVE', 'EXPIRING', 'EXPIRED', 'RENEWED'] as const;

// ───────────────────────── Buildings ─────────────────────────

export async function listBuildings(orgId: string) {
  const [buildings, roomCounts, floorCounts] = await Promise.all([
    prisma.building.findMany({ where: { orgId }, orderBy: { name: 'asc' } }),
    prisma.room.groupBy({ by: ['buildingId', 'status'], where: { building: { orgId } }, _count: { _all: true } }),
    prisma.floor.groupBy({ by: ['buildingId'], where: { building: { orgId } }, _count: { _all: true } }),
  ]);
  return buildings.map((b) => {
    const counts: Record<string, number> = { VACANT: 0, RESERVED: 0, OCCUPIED: 0, MAINTENANCE: 0, INACTIVE: 0 };
    for (const rc of roomCounts) if (rc.buildingId === b.id) counts[rc.status] = rc._count._all;
    const totalRooms = Object.values(counts).reduce((a, c) => a + c, 0);
    return { ...b, floorCount: floorCounts.find((f) => f.buildingId === b.id)?._count._all ?? 0, totalRooms, roomCounts: counts };
  });
}

export async function getBuilding(orgId: string, id: string, db: Tx | typeof prisma = prisma) {
  const building = await db.building.findFirst({ where: { id, orgId } });
  if (!building) throw notFound('Building');
  return building;
}

export interface BuildingInput {
  code: string;
  name: string;
  address?: string | null;
  description?: string | null;
  /** The building's own company details, printed on its reports, receipts and contracts. */
  companyName?: string | null;
  tin?: string | null;
  phone?: string | null;
  email?: string | null;
  managerName?: string | null;
  bankName?: string | null;
  bankAccount?: string | null;
  upi?: string | null;
  district?: string | null;
  sector?: string | null;
  cell?: string | null;
  village?: string | null;
  /** The building's own lease contract file (server/templates). */
  contractTemplate?: string | null;
}

export async function createBuilding(actor: Actor, input: BuildingInput) {
  return inTransaction(async (tx) => {
    const building = await tx.building.create({
      data: { ...input, orgId: actor.orgId, code: input.code.toUpperCase() },
    });
    await audit(tx, actor, { action: 'BUILDING_CREATED', entityType: 'Building', entityId: building.id, summary: `Building ${building.name} (${building.code}) created`, newValue: building });
    return building;
  });
}

export async function updateBuilding(actor: Actor, id: string, input: Partial<BuildingInput> & { status?: 'ACTIVE' | 'INACTIVE' }) {
  return inTransaction(async (tx) => {
    const before = await getBuilding(actor.orgId, id, tx);
    if (input.status === 'INACTIVE') {
      const occupied = await tx.room.count({ where: { buildingId: id, status: { in: ['OCCUPIED', 'RESERVED'] } } });
      if (occupied > 0) throw conflict(`This building still has ${occupied} occupied or reserved room(s) and cannot be made inactive.`);
    }
    const building = await tx.building.update({
      where: { id },
      data: { ...input, code: input.code?.toUpperCase() },
    });
    const d = diff(before, building);
    if (d) await audit(tx, actor, { action: 'BUILDING_UPDATED', entityType: 'Building', entityId: id, summary: `Building ${building.name} updated`, oldValue: d.old, newValue: d.new });
    return building;
  });
}

// ───────────────────────── Floors ─────────────────────────

export async function listFloors(orgId: string, buildingId?: string) {
  const floors = await prisma.floor.findMany({
    where: { building: { orgId }, ...(buildingId ? { buildingId } : {}) },
    include: { building: { select: { id: true, name: true, code: true } }, _count: { select: { rooms: true } } },
    orderBy: [{ building: { name: 'asc' } }, { level: 'asc' }],
  });
  const occupied = await prisma.room.groupBy({ by: ['floorId'], where: { status: 'OCCUPIED', building: { orgId } }, _count: { _all: true } });
  return floors.map(({ _count, ...f }) => ({ ...f, roomCount: _count.rooms, occupiedCount: occupied.find((o) => o.floorId === f.id)?._count._all ?? 0 }));
}

export async function createFloor(actor: Actor, input: { buildingId: string; name: string; level: number }) {
  return inTransaction(async (tx) => {
    await getBuilding(actor.orgId, input.buildingId, tx);
    const floor = await tx.floor.create({ data: input });
    await audit(tx, actor, { action: 'FLOOR_CREATED', entityType: 'Floor', entityId: floor.id, summary: `Floor ${floor.name} created`, newValue: floor });
    return floor;
  });
}

async function getFloor(orgId: string, id: string, db: Tx | typeof prisma = prisma) {
  const floor = await db.floor.findFirst({ where: { id, building: { orgId } } });
  if (!floor) throw notFound('Floor');
  return floor;
}

export async function updateFloor(actor: Actor, id: string, input: { name?: string; level?: number }) {
  return inTransaction(async (tx) => {
    const before = await getFloor(actor.orgId, id, tx);
    const floor = await tx.floor.update({ where: { id }, data: input });
    const d = diff(before, floor);
    if (d) await audit(tx, actor, { action: 'FLOOR_UPDATED', entityType: 'Floor', entityId: id, summary: `Floor ${floor.name} updated`, oldValue: d.old, newValue: d.new });
    return floor;
  });
}

// ───────────────────────── Rooms ─────────────────────────

export interface RoomInput {
  buildingId: string;
  floorId: string;
  number: string;
  roomType?: string;
  monthlyRent: Money;
  depositRequired?: Money;
  description?: string | null;
  areaSqm?: Money | null;
}

export async function createRoom(actor: Actor, input: RoomInput) {
  const today = await orgToday(actor.orgId);
  return inTransaction(async (tx) => {
    const floor = await getFloor(actor.orgId, input.floorId, tx);
    if (floor.buildingId !== input.buildingId) throw badRequest('The selected floor does not belong to the selected building.', 'FLOOR_MISMATCH');
    const room = await tx.room.create({
      data: {
        buildingId: input.buildingId, floorId: input.floorId, number: input.number.trim().toUpperCase(),
        roomType: input.roomType ?? 'Shop', monthlyRent: input.monthlyRent, depositRequired: input.depositRequired ?? 0,
        description: input.description ?? null, areaSqm: input.areaSqm ?? null,
      },
    });
    await tx.roomRentRate.create({ data: { roomId: room.id, amount: input.monthlyRent, effectiveFrom: today, reason: 'Initial rent', createdById: actor.userId } });
    await audit(tx, actor, { action: 'ROOM_CREATED', entityType: 'Room', entityId: room.id, summary: `Room ${room.number} created with rent ${room.monthlyRent}`, newValue: room });
    return room;
  });
}

export async function getRoom(orgId: string, id: string, db: Tx | typeof prisma = prisma) {
  const room = await db.room.findFirst({ where: { id, building: { orgId } } });
  if (!room) throw notFound('Room');
  return room;
}

export async function updateRoom(
  actor: Actor,
  id: string,
  input: { number?: string; roomType?: string; depositRequired?: Money; description?: string | null; areaSqm?: Money | null; status?: 'VACANT' | 'MAINTENANCE' | 'INACTIVE'; floorId?: string },
) {
  return inTransaction(async (tx) => {
    await lockRoom(tx, id);
    const before = await getRoom(actor.orgId, id, tx);
    if (input.status && input.status !== before.status) {
      // OCCUPIED and RESERVED are derived from contracts/reservations and can never be set or cleared by hand.
      if (before.status === 'OCCUPIED') throw conflict('This room is occupied. Terminate the contract to vacate it.', 'ROOM_OCCUPIED');
      if (before.status === 'RESERVED') throw conflict('This room is reserved. Cancel the reservation first.', 'ROOM_RESERVED');
    }
    if (input.floorId && input.floorId !== before.floorId) {
      const floor = await tx.floor.findFirst({ where: { id: input.floorId, buildingId: before.buildingId } });
      if (!floor) throw badRequest('Choose a floor of the same building.', 'FLOOR_MISMATCH');
      // Contracts, charges and payments record the floor they belonged to; a room with history stays where it is.
      if ((await tx.contract.count({ where: { roomId: id, status: { not: 'DRAFT' } } })) > 0) throw conflict('This room has contracts, so it cannot be moved to another floor (its rent history belongs to its current floor).', 'HAS_HISTORY');
      await tx.contract.updateMany({ where: { roomId: id, status: 'DRAFT' }, data: { floorId: input.floorId } });
    }
    const room = await tx.room.update({
      where: { id },
      data: { floorId: input.floorId, number: input.number?.trim().toUpperCase(), roomType: input.roomType, depositRequired: input.depositRequired, description: input.description, areaSqm: input.areaSqm, status: input.status },
    });
    const d = diff(before, room);
    if (d) await audit(tx, actor, { action: 'ROOM_UPDATED', entityType: 'Room', entityId: id, summary: `Room ${room.number} updated`, oldValue: d.old, newValue: d.new });
    return room;
  });
}

/**
 * Changes a room's standard rent from `effectiveFrom` onward. The current rate row is
 * closed and a new one opened — past rates and past charges are never rewritten.
 * Existing contracts keep their contractual rent; only new contracts pick up the new rate.
 */
export async function changeRoomRent(actor: Actor, roomId: string, input: { amount: Money; effectiveFrom: Date; reason: string }) {
  const today = await orgToday(actor.orgId);
  return inTransaction(async (tx) => {
    await lockRoom(tx, roomId);
    const room = await getRoom(actor.orgId, roomId, tx);
    const open = await tx.roomRentRate.findFirst({ where: { roomId, effectiveTo: null } });
    // A room that has never been let has no rent history worth keeping: correct its rent directly (typos at registration).
    if ((await tx.contract.count({ where: { roomId, status: { not: 'DRAFT' } } })) === 0) {
      if (money(room.monthlyRent).equals(input.amount)) throw badRequest('The new rent is the same as the current rent.');
      const first = await tx.roomRentRate.findFirst({ where: { roomId }, orderBy: { effectiveFrom: 'asc' } });
      await tx.roomRentRate.deleteMany({ where: { roomId } });
      const rate = await tx.roomRentRate.create({ data: { roomId, amount: input.amount, effectiveFrom: first?.effectiveFrom ?? today, reason: input.reason, createdById: actor.userId } });
      await tx.room.update({ where: { id: roomId }, data: { monthlyRent: input.amount } });
      await audit(tx, actor, {
        action: 'ROOM_RENT_CHANGED', entityType: 'Room', entityId: roomId, summary: `Room ${room.number} rent corrected ${room.monthlyRent} → ${input.amount} (room never let): ${input.reason}`,
        oldValue: { monthlyRent: room.monthlyRent }, newValue: { monthlyRent: input.amount, reason: input.reason },
      });
      return rate;
    }
    if (input.effectiveFrom < today) throw badRequest('Rent cannot be changed retroactively. Choose today or a later date.', 'RETROACTIVE_RENT');
    if (open && input.effectiveFrom <= open.effectiveFrom) {
      throw badRequest(`The new rent must take effect after the current rate started (${isoDate(open.effectiveFrom)}).`, 'RETROACTIVE_RENT');
    }
    if (open && money(open.amount).equals(input.amount)) throw badRequest('The new rent is the same as the current rent.');
    if (open) await tx.roomRentRate.update({ where: { id: open.id }, data: { effectiveTo: addDays(input.effectiveFrom, -1) } });
    const rate = await tx.roomRentRate.create({ data: { roomId, amount: input.amount, effectiveFrom: input.effectiveFrom, reason: input.reason, createdById: actor.userId } });
    // room.monthlyRent mirrors the rate in force today; a future-dated rate is picked up by the daily job.
    if (input.effectiveFrom <= today) await tx.room.update({ where: { id: roomId }, data: { monthlyRent: input.amount } });
    await audit(tx, actor, {
      action: 'ROOM_RENT_CHANGED', entityType: 'Room', entityId: roomId,
      summary: `Room ${room.number} rent ${room.monthlyRent} → ${input.amount} from ${isoDate(input.effectiveFrom)}: ${input.reason}`,
      oldValue: { monthlyRent: open?.amount ?? room.monthlyRent }, newValue: { monthlyRent: input.amount, effectiveFrom: isoDate(input.effectiveFrom), reason: input.reason },
    });
    return rate;
  });
}

/** Room standard rent in force on a given date. */
export async function roomRentOn(db: Tx | typeof prisma, roomId: string, on: Date): Promise<Money | null> {
  const rate = await db.roomRentRate.findFirst({
    where: { roomId, effectiveFrom: { lte: on }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }] },
  });
  if (rate) return money(rate.amount);
  // Before the first recorded rate (e.g. a back-dated contract on a newly registered room): use the earliest rate.
  const first = await db.roomRentRate.findFirst({ where: { roomId }, orderBy: { effectiveFrom: 'asc' } });
  return first ? money(first.amount) : null;
}

/** Daily job: make room.monthlyRent reflect future-dated rates that have now come into force. */
export async function syncRoomRents(orgId: string, today: Date): Promise<number> {
  return prisma.$executeRaw`
    UPDATE rooms r
    JOIN buildings b ON b.id = r.buildingId
    JOIN room_rent_rates rr ON rr.roomId = r.id AND rr.effectiveFrom <= ${today} AND (rr.effectiveTo IS NULL OR rr.effectiveTo >= ${today})
    SET r.monthlyRent = rr.amount
    WHERE b.orgId = ${orgId} AND r.monthlyRent <> rr.amount`;
}

export interface RoomFilter {
  buildingId?: string;
  floorId?: string;
  status?: string;
  q?: string;
  /** Only rooms a new tenant can be assigned to right now. */
  available?: boolean;
  page: number;
  pageSize: number;
  sort?: string;
  dir: 'asc' | 'desc';
}

export async function listRooms(orgId: string, f: RoomFilter) {
  const where: Prisma.RoomWhereInput = {
    building: { orgId },
    ...(f.buildingId ? { buildingId: f.buildingId } : {}),
    ...(f.floorId ? { floorId: f.floorId } : {}),
    ...(f.available ? { status: 'VACANT' } : f.status ? { status: f.status as Prisma.RoomWhereInput['status'] } : {}),
    ...(f.q ? { OR: [{ number: { contains: f.q } }, { description: { contains: f.q } }, { roomType: { contains: f.q } }] } : {}),
  };
  const orderBy: Prisma.RoomOrderByWithRelationInput[] =
    f.sort === 'rent' ? [{ monthlyRent: f.dir }] : f.sort === 'status' ? [{ status: f.dir }, { number: 'asc' }]
      : [{ building: { name: 'asc' } }, { floor: { level: 'asc' } }, { number: f.dir }];
  const [total, rooms] = await Promise.all([
    prisma.room.count({ where }),
    prisma.room.findMany({
      where, orderBy, skip: (f.page - 1) * f.pageSize, take: f.pageSize,
      include: {
        building: { select: { id: true, name: true, code: true } },
        floor: { select: { id: true, name: true, level: true } },
        contracts: {
          where: { status: { in: [...OCCUPYING_STATUSES] } },
          select: { id: true, contractNumber: true, status: true, startDate: true, endDate: true, leaseStart: true, monthlyRent: true, tenant: { select: { id: true, fullName: true, phone: true } } },
        },
      },
    }),
  ]);
  const balances = await outstandingByRoom(rooms.map((r) => r.id));
  const items = rooms.map(({ contracts, ...r }) => ({ ...r, currentContract: contracts[0] ?? null, outstanding: balances.get(r.id) ?? money(0) }));
  return { items, total };
}

export async function outstandingByRoom(roomIds: string[]): Promise<Map<string, Money>> {
  if (!roomIds.length) return new Map();
  const rows = await prisma.rentCharge.groupBy({
    by: ['roomId'],
    where: { roomId: { in: roomIds }, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] }, contract: { status: { in: [...BILLABLE_STATUSES] } } },
    _sum: { balance: true },
  });
  return new Map(rows.map((r) => [r.roomId, money(r._sum.balance)]));
}

export async function roomDetail(orgId: string, id: string) {
  const room = await prisma.room.findFirst({
    where: { id, building: { orgId } },
    include: {
      building: { select: { id: true, name: true, code: true } },
      floor: { select: { id: true, name: true, level: true } },
      rentRates: { orderBy: { effectiveFrom: 'desc' }, include: { createdBy: { select: { fullName: true } } } },
      reservations: { orderBy: { createdAt: 'desc' }, take: 10, include: { tenant: { select: { id: true, fullName: true } } } },
      contracts: {
        orderBy: { startDate: 'desc' },
        include: { tenant: { select: { id: true, fullName: true, phone: true, businessName: true } } },
      },
    },
  });
  if (!room) throw notFound('Room');
  const current = room.contracts.find((c) => (OCCUPYING_STATUSES as readonly string[]).includes(c.status)) ?? null;
  const today = await orgToday(orgId);
  const charges = await prisma.rentCharge.findMany({
    where: { roomId: id, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] }, contract: { status: { in: [...BILLABLE_STATUSES] } } },
    select: { balance: true, overdueFrom: true },
  });
  const credit = await prisma.payment.aggregate({ where: { roomId: id, type: 'PAYMENT', status: 'POSTED', contract: { status: { in: [...BILLABLE_STATUSES] } } }, _sum: { unallocatedAmount: true } });
  const financial = {
    outstanding: sum(charges.map((c) => c.balance)),
    overdue: sum(charges.filter((c) => c.overdueFrom < today).map((c) => c.balance)),
    credit: money(credit._sum.unallocatedAmount),
  };
  const openMaintenance = await prisma.maintenanceRequest.count({ where: { roomId: id, status: { notIn: ['COMPLETED', 'CANCELLED'] } } });
  return { ...room, currentContract: current, financial, openMaintenance };
}

/** Building → floor → room status map for the dashboard. */
export async function roomMap(orgId: string, buildingId?: string) {
  const buildings = await prisma.building.findMany({
    where: { orgId, status: 'ACTIVE', ...(buildingId ? { id: buildingId } : {}) },
    orderBy: { name: 'asc' },
    select: {
      id: true, name: true, code: true,
      floors: {
        orderBy: { level: 'asc' },
        select: {
          id: true, name: true, level: true,
          rooms: {
            orderBy: { number: 'asc' },
            select: {
              id: true, number: true, status: true, monthlyRent: true,
              contracts: { where: { status: { in: [...OCCUPYING_STATUSES] } }, select: { id: true, status: true, tenant: { select: { fullName: true } } } },
            },
          },
        },
      },
    },
  });
  const roomIds = buildings.flatMap((b) => b.floors.flatMap((f) => f.rooms.map((r) => r.id)));
  const balances = await outstandingByRoom(roomIds);
  return buildings.map((b) => ({
    ...b,
    floors: b.floors.map((f) => ({
      ...f,
      rooms: f.rooms.map(({ contracts, ...r }) => ({
        ...r, tenantName: contracts[0]?.tenant.fullName ?? null, contractId: contracts[0]?.id ?? null,
        contractStatus: contracts[0]?.status ?? null, outstanding: balances.get(r.id) ?? money(0),
      })),
    })),
  }));
}

// ───────────────────────── Reservations ─────────────────────────

export async function createReservation(
  actor: Actor,
  input: { roomId: string; tenantId?: string; prospectName: string; prospectPhone?: string; reservedOn: Date; expiresOn: Date; depositAmount?: Money; notes?: string },
) {
  return inTransaction(async (tx) => {
    await lockRoom(tx, input.roomId);
    const room = await getRoom(actor.orgId, input.roomId, tx);
    if (room.status !== 'VACANT') {
      throw conflict(`Only a vacant room can be reserved. Room ${room.number} is currently ${room.status.toLowerCase()}.`, 'ROOM_NOT_AVAILABLE');
    }
    if (input.tenantId) {
      const tenant = await tx.tenant.findFirst({ where: { id: input.tenantId, orgId: actor.orgId } });
      if (!tenant) throw notFound('Tenant');
    }
    const reservation = await tx.reservation.create({
      data: {
        roomId: input.roomId, tenantId: input.tenantId ?? null, prospectName: input.prospectName, prospectPhone: input.prospectPhone ?? null,
        reservedOn: input.reservedOn, expiresOn: input.expiresOn, depositAmount: input.depositAmount ?? 0, notes: input.notes ?? null, createdById: actor.userId,
      },
    });
    await tx.room.update({ where: { id: room.id }, data: { status: 'RESERVED' } });
    await audit(tx, actor, { action: 'ROOM_RESERVED', entityType: 'Room', entityId: room.id, summary: `Room ${room.number} reserved for ${input.prospectName} until ${isoDate(input.expiresOn)}`, newValue: reservation });
    return reservation;
  });
}

export async function endReservation(actor: Actor | null, orgId: string, id: string, status: 'CANCELLED' | 'EXPIRED') {
  return inTransaction(async (tx) => {
    const found = await tx.reservation.findFirst({ where: { id, room: { building: { orgId } } }, include: { room: true } });
    if (!found) throw notFound('Reservation');
    await lockRoom(tx, found.roomId);
    const reservation = await tx.reservation.findUniqueOrThrow({ where: { id } });
    if (reservation.status !== 'ACTIVE') throw conflict('This reservation is no longer active.');
    const updated = await tx.reservation.update({ where: { id }, data: { status } });
    const room = await tx.room.findUniqueOrThrow({ where: { id: found.roomId } });
    if (room.status === 'RESERVED') await tx.room.update({ where: { id: room.id }, data: { status: 'VACANT' } });
    await audit(tx, actor, { action: status === 'CANCELLED' ? 'RESERVATION_CANCELLED' : 'RESERVATION_EXPIRED', entityType: 'Room', entityId: room.id, summary: `Reservation of room ${room.number} for ${reservation.prospectName} ${status.toLowerCase()}` }, orgId);
    return updated;
  });
}

export async function listReservations(orgId: string, f: { buildingId?: string; status?: string }) {
  return prisma.reservation.findMany({
    where: { room: { building: { orgId }, ...(f.buildingId ? { buildingId: f.buildingId } : {}) }, ...(f.status ? { status: f.status as Prisma.ReservationWhereInput['status'] } : {}) },
    include: { room: { select: { id: true, number: true, monthlyRent: true, building: { select: { name: true } }, floor: { select: { name: true } } } }, tenant: { select: { id: true, fullName: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}
