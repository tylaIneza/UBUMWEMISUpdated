import { inTransaction, lockRoom, prisma, Prisma } from '../db.js';
import type { MaintenanceRequest } from '../generated/prisma/client.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { Actor } from '../http/context.js';
import type { Money } from '../lib/money.js';
import { money } from '../lib/money.js';
import { audit, diff } from './audit.js';
import { orgToday } from './org.js';
import { nextDocumentNumber } from './sequences.js';

type Status = MaintenanceRequest['status'];

/** Allowed workflow moves. COMPLETED and CANCELLED are final. */
const TRANSITIONS: Record<Status, Status[]> = {
  REPORTED: ['APPROVED', 'ASSIGNED', 'IN_PROGRESS', 'CANCELLED'],
  APPROVED: ['ASSIGNED', 'IN_PROGRESS', 'CANCELLED'],
  ASSIGNED: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export interface MaintenanceInput {
  buildingId: string;
  floorId?: string;
  roomId?: string;
  title: string;
  description?: string;
  priority?: MaintenanceRequest['priority'];
  estimatedCost?: Money;
  supplier?: string;
  assignedToId?: string;
  /** Take a vacant room out of service while the work is done. */
  markRoomUnderMaintenance?: boolean;
}

export async function createMaintenance(actor: Actor, input: MaintenanceInput) {
  const today = await orgToday(actor.orgId);
  return inTransaction(async (tx) => {
    let { buildingId } = input;
    let floorId = input.floorId ?? null;
    const roomId = input.roomId ?? null;
    if (roomId) {
      await lockRoom(tx, roomId);
      const room = await tx.room.findFirst({ where: { id: roomId, building: { orgId: actor.orgId } } });
      if (!room) throw notFound('Room');
      buildingId = room.buildingId;
      floorId = room.floorId;
      if (input.markRoomUnderMaintenance) {
        if (room.status !== 'VACANT') throw conflict(`Only a vacant room can be taken out of service. Room ${room.number} is ${room.status.toLowerCase()}.`, 'ROOM_NOT_AVAILABLE');
        await tx.room.update({ where: { id: roomId }, data: { status: 'MAINTENANCE' } });
      }
    } else if (floorId) {
      const floor = await tx.floor.findFirst({ where: { id: floorId, building: { orgId: actor.orgId } } });
      if (!floor) throw notFound('Floor');
      buildingId = floor.buildingId;
    }
    const building = await tx.building.findFirst({ where: { id: buildingId, orgId: actor.orgId } });
    if (!building) throw notFound('Building');
    if (input.assignedToId) {
      const user = await tx.user.findFirst({ where: { id: input.assignedToId, orgId: actor.orgId, deletedAt: null } });
      if (!user) throw badRequest('Select a valid staff member.');
    }
    const number = await nextDocumentNumber(tx, actor.orgId, 'MAINTENANCE', 'MNT', today.getUTCFullYear());
    const request = await tx.maintenanceRequest.create({
      data: {
        orgId: actor.orgId, number, buildingId, floorId, roomId, title: input.title, description: input.description ?? null,
        priority: input.priority ?? 'MEDIUM', status: input.assignedToId ? 'ASSIGNED' : 'REPORTED', reportedOn: today, reportedById: actor.userId,
        assignedToId: input.assignedToId ?? null, estimatedCost: input.estimatedCost ?? null, supplier: input.supplier ?? null,
      },
    });
    await audit(tx, actor, { action: 'MAINTENANCE_REPORTED', entityType: 'MaintenanceRequest', entityId: request.id, summary: `Maintenance ${number}: ${input.title} (${building.name})`, newValue: request });
    return request;
  });
}

export interface MaintenanceUpdate {
  title?: string;
  description?: string | null;
  priority?: MaintenanceRequest['priority'];
  status?: Status;
  assignedToId?: string | null;
  estimatedCost?: Money | null;
  actualCost?: Money | null;
  supplier?: string | null;
  /** When completing: put a room that is under maintenance back to VACANT. */
  returnRoomToService?: boolean;
}

export async function updateMaintenance(actor: Actor, id: string, input: MaintenanceUpdate) {
  const today = await orgToday(actor.orgId);
  return inTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM maintenance_requests WHERE id = ${id} FOR UPDATE`;
    const before = await tx.maintenanceRequest.findFirst({ where: { id, orgId: actor.orgId } });
    if (!before) throw notFound('Maintenance request');
    if (['COMPLETED', 'CANCELLED'].includes(before.status)) throw conflict(`This request is ${before.status.toLowerCase()} and can no longer be changed.`);
    let status = input.status;
    if (status && status !== before.status && !TRANSITIONS[before.status].includes(status)) {
      throw conflict(`A request that is ${before.status.replace('_', ' ').toLowerCase()} cannot be moved to ${status.replace('_', ' ').toLowerCase()}.`, 'INVALID_TRANSITION');
    }
    if (input.assignedToId) {
      const user = await tx.user.findFirst({ where: { id: input.assignedToId, orgId: actor.orgId, deletedAt: null } });
      if (!user) throw badRequest('Select a valid staff member.');
      if (!status && ['REPORTED', 'APPROVED'].includes(before.status)) status = 'ASSIGNED';
    }
    if ((status ?? before.status) === 'ASSIGNED' && !(input.assignedToId ?? before.assignedToId)) throw badRequest('Choose the staff member this request is assigned to.');
    const request = await tx.maintenanceRequest.update({
      where: { id },
      data: {
        title: input.title, description: input.description, priority: input.priority, status, assignedToId: input.assignedToId,
        estimatedCost: input.estimatedCost, actualCost: input.actualCost, supplier: input.supplier,
        completedOn: status === 'COMPLETED' ? today : undefined,
      },
    });
    if ((status === 'COMPLETED' || status === 'CANCELLED') && request.roomId && input.returnRoomToService !== false) {
      await lockRoom(tx, request.roomId);
      const room = await tx.room.findUniqueOrThrow({ where: { id: request.roomId } });
      const otherOpen = await tx.maintenanceRequest.count({ where: { roomId: room.id, id: { not: id }, status: { notIn: ['COMPLETED', 'CANCELLED'] } } });
      if (room.status === 'MAINTENANCE' && otherOpen === 0) await tx.room.update({ where: { id: room.id }, data: { status: 'VACANT' } });
    }
    const d = diff(before, request);
    if (d) await audit(tx, actor, { action: status && status !== before.status ? `MAINTENANCE_${status}` : 'MAINTENANCE_UPDATED', entityType: 'MaintenanceRequest', entityId: id, summary: `Maintenance ${request.number} ${status && status !== before.status ? `→ ${status.replace('_', ' ').toLowerCase()}` : 'updated'}`, oldValue: d.old, newValue: d.new });
    return request;
  });
}

export interface MaintenanceFilter {
  buildingId?: string;
  floorId?: string;
  roomId?: string;
  status?: string;
  priority?: string;
  q?: string;
  from?: Date;
  to?: Date;
}

export function maintenanceWhere(orgId: string, f: MaintenanceFilter): Prisma.MaintenanceRequestWhereInput {
  return {
    orgId,
    ...(f.buildingId ? { buildingId: f.buildingId } : {}), ...(f.floorId ? { floorId: f.floorId } : {}), ...(f.roomId ? { roomId: f.roomId } : {}),
    ...(f.status === 'OPEN' ? { status: { notIn: ['COMPLETED', 'CANCELLED'] } } : f.status ? { status: f.status as Status } : {}),
    ...(f.priority ? { priority: f.priority as MaintenanceRequest['priority'] } : {}),
    ...(f.from || f.to ? { reportedOn: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
    ...(f.q ? { OR: [{ title: { contains: f.q } }, { number: { contains: f.q } }, { supplier: { contains: f.q } }] } : {}),
  };
}

const include = {
  building: { select: { id: true, name: true } }, floor: { select: { id: true, name: true } }, room: { select: { id: true, number: true } },
  reportedBy: { select: { id: true, fullName: true } }, assignedTo: { select: { id: true, fullName: true } },
} satisfies Prisma.MaintenanceRequestInclude;

async function linkedCosts(ids: string[]) {
  if (!ids.length) return new Map<string, Money>();
  const rows = await prisma.expense.groupBy({ by: ['maintenanceRequestId'], where: { maintenanceRequestId: { in: ids }, status: 'APPROVED' }, _sum: { amount: true } });
  return new Map(rows.map((r) => [r.maintenanceRequestId as string, money(r._sum.amount)]));
}

export async function listMaintenance(orgId: string, f: MaintenanceFilter, page: { page: number; pageSize: number }) {
  const where = maintenanceWhere(orgId, f);
  const [total, items] = await Promise.all([
    prisma.maintenanceRequest.count({ where }),
    prisma.maintenanceRequest.findMany({ where, include, orderBy: [{ createdAt: 'desc' }], skip: (page.page - 1) * page.pageSize, take: page.pageSize }),
  ]);
  const costs = await linkedCosts(items.map((i) => i.id));
  return { items: items.map((i) => ({ ...i, expensedCost: costs.get(i.id) ?? money(0) })), total };
}

export async function maintenanceDetail(orgId: string, id: string) {
  const request = await prisma.maintenanceRequest.findFirst({
    where: { id, orgId },
    include: { ...include, expenses: { include: { category: { select: { name: true } } }, orderBy: { expenseDate: 'desc' } } },
  });
  if (!request) throw notFound('Maintenance request');
  const costs = await linkedCosts([id]);
  return { ...request, expensedCost: costs.get(id) ?? money(0) };
}
