import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { addMonths } from '../src/lib/dates.js';
import { expectedRentForMonth } from '../src/services/charges.js';
import { createContract, listContracts } from '../src/services/contracts.js';
import { listPayments } from '../src/services/payments.js';
import { closePeriod } from '../src/services/periods.js';
import { generateReport, type Report } from '../src/services/reports.js';
import { globalSearch } from '../src/services/search.js';
import { archiveTenant, listTenants, restoreTenant } from '../src/services/tenants.js';
import { charges, createWorld, failure, lease, loginAs, makeBuilding, makeTenant, monthsAgo, num, pay, thisMonth, today, type BuildingFixture, type World } from './helpers.js';

let w: World;
let b: BuildingFixture;
const rooms = () => b.floors.flatMap((f) => f.rooms);
const page = { page: 1, pageSize: 100 };
const grand = (r: Report) => num(r.summary.find((s) => s.label === 'Grand total')!.value);

beforeAll(async () => {
  w = await createWorld();
  b = await makeBuilding(w, 'AR', 1, 6);
});

describe('archiving a tenant', () => {
  it('ends the tenancy, waives what is owed and hides the tenant, while their payments still count', async () => {
    const room = rooms()[0]!;
    const { tenant, contract } = await lease(w, room.id, 2);
    const payment = await pay(w, 'CASHIER', contract.id, room.rent); // pays the oldest month only
    const collectedBefore = grand(await generateReport(w.actors.MANAGEMENT, 'daily-collection', { from: today(), to: today() }));
    const expectedBefore = num(await expectedRentForMonth(w.orgId, addMonths(thisMonth(), 1)));

    const archived = await archiveTenant(w.actors.SUPER_ADMIN, tenant.id, 'Left the building');
    expect([archived.status, archived.statusReason]).toEqual(['ARCHIVED', 'Left the building']);
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe('TERMINATED');
    expect((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).status).toBe('VACANT');
    const left = await charges(contract.id);
    expect(left.every((c) => num(c.balance) === 0)).toBe(true);
    expect(left.filter((c) => c.status === 'WAIVED')).toHaveLength(2);

    // Expected rent no longer includes the tenant; the money they paid is still in the collection report.
    expect(num(await expectedRentForMonth(w.orgId, addMonths(thisMonth(), 1)))).toBe(expectedBefore - room.rent);
    expect(grand(await generateReport(w.actors.MANAGEMENT, 'daily-collection', { from: today(), to: today() }))).toBe(collectedBefore);

    // Hidden from lists and search, unless the archive is asked for.
    expect((await listTenants(w.orgId, {}, page)).items.map((t) => t.id)).not.toContain(tenant.id);
    expect((await listTenants(w.orgId, { status: 'ARCHIVED' }, page)).items.map((t) => t.id)).toContain(tenant.id);
    expect((await listPayments(w.orgId, {}, page)).items.map((p) => p.id)).not.toContain(payment.id);
    expect((await listPayments(w.orgId, { tenantId: tenant.id, includeArchived: true }, page)).items.map((p) => p.id)).toContain(payment.id);
    expect((await listContracts(w.orgId, {}, page)).items.map((c) => c.id)).not.toContain(contract.id);
    expect((await globalSearch(w.actors.SUPER_ADMIN, tenant.fullName)).map((h) => h.id)).not.toContain(tenant.id);

    // An archived tenant cannot be given a room until restored.
    const err = await failure(createContract(w.actors.MANAGEMENT, { tenantId: tenant.id, roomId: rooms()[1]!.id, startDate: today(), endDate: addMonths(today(), 12), activate: true }));
    expect(err.code).toBe('TENANT_ARCHIVED');

    const restored = await restoreTenant(w.actors.SUPER_ADMIN, tenant.id);
    expect([restored.status, restored.archivedAt]).toEqual(['FORMER', null]);
    expect((await listTenants(w.orgId, {}, page)).items.map((t) => t.id)).toContain(tenant.id);
    expect(await prisma.auditLog.count({ where: { entityId: tenant.id, action: { in: ['TENANT_ARCHIVED', 'TENANT_RESTORED'] } } })).toBe(2);
  });

  it('works for a tenant who never rented a room', async () => {
    const tenant = await makeTenant(w);
    expect((await archiveTenant(w.actors.SUPER_ADMIN, tenant.id, 'Registered by mistake')).status).toBe('ARCHIVED');
    expect((await failure(archiveTenant(w.actors.SUPER_ADMIN, tenant.id, 'Again'))).code).toBe('ALREADY_ARCHIVED');
  });

  it('is only for those given the permission, and archived tenants are invisible to everyone else', async () => {
    const { tenant, contract } = await lease(w, rooms()[2]!.id, 0);
    const manager = await loginAs(w.emails.MANAGEMENT);
    const admin = await loginAs(w.emails.SUPER_ADMIN);
    expect((await manager.post(`/tenants/${tenant.id}/archive`, { reason: 'Gone' })).status).toBe(403);
    expect((await admin.post(`/tenants/${tenant.id}/archive`, { reason: '' })).status).toBe(400);
    expect((await admin.post(`/tenants/${tenant.id}/archive`, { reason: 'Gone' })).body.status).toBe('ARCHIVED');
    expect((await manager.get(`/tenants/${tenant.id}`)).status).toBe(404);
    expect((await manager.get(`/contracts/${contract.id}`)).status).toBe(404);
    expect((await manager.get('/tenants?status=ARCHIVED')).status).toBe(403);
    expect((await admin.get(`/tenants/${tenant.id}`)).body.status).toBe('ARCHIVED');
    expect((await admin.get('/tenants?status=ARCHIVED')).body.items.map((t: any) => t.id)).toContain(tenant.id);
  });

  it('refuses, changing nothing, when rent still owed lies in a closed accounting month', async () => {
    const { tenant, contract } = await lease(w, rooms()[3]!.id, 2);
    await closePeriod(w.actors.MANAGEMENT, monthsAgo(1), 'Month-end');
    expect((await failure(archiveTenant(w.actors.SUPER_ADMIN, tenant.id, 'Left'))).code).toBe('PERIOD_CLOSED');
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe('ACTIVE');
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).status).toBe('ACTIVE');
  });
});
