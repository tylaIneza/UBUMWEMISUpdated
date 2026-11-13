import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { lookupByTin } from '../src/services/tenantLookup.js';
import { app, charges, createWorld, failure, lease, makeBuilding, num, pay, tinNumber, type BuildingFixture, type World } from './helpers.js';

let w: World;
let b: BuildingFixture;

beforeAll(async () => {
  w = await createWorld();
  b = await makeBuilding(w, 'TL', 1, 3, 200000);
});

describe('tenant balance check by TIN (sign-in page, no account)', () => {
  it('shows the rooms, unpaid months, outstanding total and last payment', async () => {
    const room = b.floors[0]!.rooms[0]!;
    const { tenant, contract } = await lease(w, room.id, 2);
    const tin = tinNumber();
    await prisma.tenant.update({ where: { id: tenant.id }, data: { tin } });
    await pay(w, 'CASHIER', contract.id, room.rent + 50000);

    const [r] = await lookupByTin(`${tin.slice(0, 3)} ${tin.slice(3)}`, { ip: '127.0.0.1' });
    const open = (await charges(contract.id)).filter((c) => num(c.balance) > 0);
    expect(r!.tenant.fullName).toBe(tenant.fullName);
    expect(r!.rooms.map((x) => x.room)).toEqual([room.number]);
    expect(r!.unpaid).toHaveLength(open.length);
    expect(r!.unpaid[0]!.balance.toString()).toBe(open[0]!.balance.toString());
    expect(num(r!.outstanding)).toBe(open.reduce((a, c) => a + num(c.balance), 0));
    expect(num(r!.lastPayment!.amount)).toBe(room.rent + 50000);
    // Only the summary leaves the server: no contact details or identity numbers.
    expect(JSON.stringify(r)).not.toMatch(new RegExp(`${tenant.phone!.replace('+', '\\+')}|${tenant.idNumber}|"tin"`));
    expect(await prisma.auditLog.count({ where: { action: 'TENANT_SELF_LOOKUP', entityId: tenant.id } })).toBe(1);
  });

  it('answers clearly for a wrong or unknown TIN, without revealing anything', async () => {
    expect((await failure(lookupByTin('12345', {}))).code).toBe('TIN_INVALID');
    expect((await failure(lookupByTin('000000001', {}))).code).toBe('TIN_NOT_FOUND');
  });

  it('works without signing in', async () => {
    const res = await request(app).post('/api/v1/public/tenant-balance').send({ tin: '000000002' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TIN_NOT_FOUND');
  });
});
