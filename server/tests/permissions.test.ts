import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { isoDate } from '../src/lib/dates.js';
import { app, createWorld, lease, loginAs, makeBuilding, PASSWORD, pay, tenantDetails, thisMonth, today, uid, type BuildingFixture, type Session, type World } from './helpers.js';

let w: World;
let b: BuildingFixture;
let s: Record<'admin' | 'manager' | 'accountant' | 'cashier' | 'staff' | 'viewer', Session>;
let contractId: string;
let roomId: string;

beforeAll(async () => {
  w = await createWorld();
  b = await makeBuilding(w, 'PM', 1, 3);
  roomId = b.floors[0]!.rooms[0]!.id;
  contractId = (await lease(w, roomId)).contract.id;
  s = {
    admin: await loginAs(w.emails.SUPER_ADMIN), manager: await loginAs(w.emails.MANAGEMENT), accountant: await loginAs(w.emails.ACCOUNTANT),
    cashier: await loginAs(w.emails.CASHIER), staff: await loginAs(w.emails.PROPERTY_STAFF), viewer: await loginAs(w.emails.VIEWER),
  };
});

const payment = (amount = 1000) => ({ contractId, amount, methodId: w.methods.CASH, idempotencyKey: uid('http') });

describe('authentication', () => {
  it('rejects unauthenticated access to every protected area', async () => {
    for (const path of ['/dashboard', '/rooms', '/tenants', '/payments', '/reports/consolidated', '/audit-logs', '/users', '/settings', '/auth/me', '/documents?entityType=Tenant&entityId=' + contractId]) {
      const res = await request(app).get('/api/v1' + path);
      expect(res.status, path).toBe(401);
    }
    expect((await request(app).post('/api/v1/payments').send(payment())).status).toBe(401);
  });

  it('gives the same answer for a wrong password and an unknown account, and never returns the hash', async () => {
    const wrong = await request(app).post('/api/v1/auth/login').send({ email: w.emails.CASHIER, password: 'nope-nope-nope' });
    const unknown = await request(app).post('/api/v1/auth/login').send({ email: 'ghost@test.rw', password: 'nope-nope-nope' });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    const me = await s.cashier.get('/auth/me');
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|scrypt/);
    expect(await prisma.auditLog.count({ where: { action: 'LOGIN_FAILED' } })).toBe(1);
  });

  it('sets an http-only, same-site session cookie and stores only a hash of the token', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: w.emails.VIEWER, password: PASSWORD });
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const token = cookie.split(';')[0]!.split('=')[1]!;
    expect(await prisma.session.count({ where: { tokenHash: token } })).toBe(0);
  });

  it('requires the CSRF token on state-changing requests', async () => {
    const res = await request(app).post('/api/v1/payments').set('Cookie', s.cashier.cookie).send(payment());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF');
    const forged = await request(app).post('/api/v1/payments').set('Cookie', s.cashier.cookie).set('X-CSRF-Token', s.viewer.csrf).send(payment());
    expect(forged.status).toBe(403);
  });

  it('locks the account after repeated failed sign-ins', async () => {
    for (let i = 0; i < 5; i += 1) await request(app).post('/api/v1/auth/login').send({ email: w.emails.PROPERTY_STAFF, password: 'wrong-password-1' });
    const locked = await request(app).post('/api/v1/auth/login').send({ email: w.emails.PROPERTY_STAFF, password: PASSWORD });
    expect(locked.status).toBe(429);
    await prisma.user.update({ where: { email: w.emails.PROPERTY_STAFF }, data: { lockedUntil: null } });
  });

  it('invalidates the session on logout', async () => {
    const temp = await loginAs(w.emails.VIEWER);
    expect((await temp.get('/auth/me')).status).toBe(200);
    expect((await temp.post('/auth/logout')).status).toBe(200);
    expect((await temp.get('/auth/me')).status).toBe(401);
  });

  it('supports password reset with a single-use link and signs out other sessions', async () => {
    const victim = await loginAs(w.emails.VIEWER);
    const link = await s.admin.post(`/users/${w.actors.VIEWER.userId}/reset-link`);
    expect(link.status).toBe(200);
    const token = decodeURIComponent(String(link.body.link).split('token=')[1]!);
    expect((await request(app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'weak' })).status).toBe(400);
    expect((await request(app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'Brand-New-Pass-77' })).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'Another-Pass-88' })).status).toBe(400);
    expect((await victim.get('/auth/me')).status).toBe(401);
    s.viewer = await loginAs(w.emails.VIEWER, 'Brand-New-Pass-77');
    // "Forgot password" never reveals whether an address exists.
    const a = await request(app).post('/api/v1/auth/forgot-password').send({ email: w.emails.VIEWER });
    const z = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'nobody@test.rw' });
    expect(a.body).toEqual(z.body);
  });
});

describe('role restrictions are enforced by the API, not the screen', () => {
  it('viewer: can read dashboards and reports but cannot create or change anything', async () => {
    expect((await s.viewer.get('/dashboard')).status).toBe(200);
    expect((await s.viewer.get('/reports/consolidated')).status).toBe(200);
    expect((await s.viewer.post('/payments', payment())).status).toBe(403);
    expect((await s.viewer.post('/payments/preview', { contractId, amount: 1000 })).status).toBe(403);
    expect((await s.viewer.post('/tenants', { fullName: 'X Y', idNumber: 'ABC12345', phone: '+250788000111' })).status).toBe(403);
    expect((await s.viewer.post('/rooms', { buildingId: b.id, floorId: b.floors[0]!.id, number: 'V1', monthlyRent: 1 })).status).toBe(403);
    expect((await s.viewer.post('/expenses', {})).status).toBe(403);
    expect((await s.viewer.post(`/contracts/${contractId}/terminate`, { moveOutDate: isoDate(today()), reason: 'x' })).status).toBe(403);
    expect((await s.viewer.get('/reports/consolidated/export?format=pdf')).status).toBe(403);
    expect((await s.viewer.get('/audit-logs')).status).toBe(403);
    expect(await prisma.payment.count()).toBe(0);
  });

  it('cashier: can record payments but cannot modify rent configuration', async () => {
    expect((await s.cashier.post('/payments', payment(1000))).status).toBe(201);
    const rent = { amount: 1, effectiveFrom: isoDate(today()), reason: 'cheaper' };
    expect((await s.cashier.post(`/rooms/${roomId}/rent`, rent)).status).toBe(403);
    expect((await s.cashier.post(`/contracts/${contractId}/rent`, { ...rent, effectiveFrom: isoDate(thisMonth()) })).status).toBe(403);
    expect((await s.cashier.patch(`/rooms/${roomId}`, { monthlyRent: 1, description: 'note' })).status).toBe(403);
    expect((await s.cashier.post(`/contracts/${contractId}/adjustments`, { type: 'DISCOUNT', amount: 5000, effectiveFrom: isoDate(thisMonth()), reason: 'x' })).status).toBe(403);
    expect(Number((await prisma.room.findUniqueOrThrow({ where: { id: roomId } })).monthlyRent)).toBe(b.floors[0]!.rooms[0]!.rent);
  });

  it('cashier: limited financial visibility and no advance payments, approvals or administration', async () => {
    for (const path of ['/reports/consolidated', '/reports/daily-collection', '/expenses', '/users', '/settings', '/audit-logs', '/approvals', '/deposits']) {
      expect((await s.cashier.get(path)).status, path).toBe(403);
    }
    const dash = await s.cashier.get('/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body.reconciliation).toEqual([]);
    const advance = await s.cashier.post('/payments', { ...payment(99_000_000), overpayment: 'ADVANCE' });
    expect(advance.status).toBe(403);
    // A cashier may ask for a reversal but cannot approve it.
    const p = await pay(w, 'ACCOUNTANT', contractId, 500);
    const asked = await s.cashier.post(`/payments/${p.id}/reverse`, { reason: 'typo' });
    expect([asked.status, asked.body.executed]).toEqual([201, false]);
    expect((await s.cashier.post(`/approvals/${asked.body.approval.id}/decision`, { approve: true })).status).toBe(403);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('POSTED');
  });

  it('property staff: rooms, tenants and maintenance — but no payments or financial reports', async () => {
    expect((await s.staff.get('/rooms')).status).toBe(200);
    expect((await s.staff.post('/maintenance', { buildingId: b.id, title: 'Door lock' })).status).toBe(201);
    expect((await s.staff.get('/reports/occupancy')).status).toBe(200);
    expect((await s.staff.get('/reports/consolidated')).status).toBe(403);
    expect((await s.staff.get('/payments')).status).toBe(403);
    expect((await s.staff.post('/payments', payment())).status).toBe(403);
    expect((await s.staff.post(`/rooms/${roomId}/rent`, { amount: 1, effectiveFrom: isoDate(today()), reason: 'x' })).status).toBe(403);
  });

  it('accountant: financial work, but not users, roles or settings', async () => {
    expect((await s.accountant.get('/reports/consolidated')).status).toBe(200);
    expect((await s.accountant.get('/expenses')).status).toBe(200);
    expect((await s.accountant.get('/users')).status).toBe(403);
    expect((await s.accountant.patch('/settings/organization', { name: 'Hacked' })).status).toBe(403);
    expect((await s.accountant.post('/expenses/00000000-0000-4000-8000-000000000000/decision', { decision: 'APPROVED' })).status).toBe(403);
  });

  it('a newly created limited user is restricted immediately, and losing a role takes effect at once', async () => {
    const created = await s.admin.post('/users', { email: 'newcashier@test.rw', fullName: 'New Cashier', password: 'Initial-Pass-2026', roles: ['CASHIER'] });
    expect(created.status).toBe(201);
    const fresh = await loginAs('newcashier@test.rw', 'Initial-Pass-2026');
    expect((await fresh.get('/auth/me')).body.user.mustChangePassword).toBe(true);
    expect((await fresh.post('/payments', payment(1000))).status).toBe(201);
    expect((await fresh.get('/users')).status).toBe(403);
    expect((await fresh.post(`/rooms/${roomId}/rent`, { amount: 1, effectiveFrom: isoDate(today()), reason: 'x' })).status).toBe(403);

    expect((await s.admin.patch(`/users/${created.body.id}`, { roles: ['VIEWER'] })).status).toBe(200);
    expect((await fresh.post('/payments', payment(1000))).status).toBe(403);
    expect((await s.admin.patch(`/users/${created.body.id}`, { status: 'DISABLED' })).status).toBe(200);
    expect((await fresh.get('/dashboard')).status).toBe(401);
  });

  it('removing a user keeps the financial history they recorded', async () => {
    const created = await s.admin.post('/users', { email: 'temp@test.rw', fullName: 'Temp Cashier', password: 'Initial-Pass-2026', roles: ['CASHIER'] });
    const temp = await loginAs('temp@test.rw', 'Initial-Pass-2026');
    const paid = await temp.post('/payments', payment(2000));
    expect((await s.admin.del(`/users/${created.body.id}`)).status).toBe(200);
    expect((await temp.get('/auth/me')).status).toBe(401);
    const detail = await s.accountant.get(`/payments/${paid.body.id}`);
    expect(detail.body.recordedBy.fullName).toBe('Temp Cashier');
    // The database itself refuses to hard-delete a user who owns transactions.
    await expect(prisma.user.delete({ where: { id: created.body.id } })).rejects.toThrow();
  });

  it('protects administrators from locking the organization out', async () => {
    expect((await s.manager.get('/users')).status).toBe(403);
    expect((await s.admin.patch(`/users/${w.actors.SUPER_ADMIN.userId}`, { status: 'DISABLED' })).status).toBe(409);
    expect((await s.admin.del(`/users/${w.actors.SUPER_ADMIN.userId}`)).status).toBe(409);
    const superRole = (await s.admin.get('/roles')).body.roles.find((r: { key: string }) => r.key === 'SUPER_ADMIN');
    expect((await s.admin.put(`/roles/${superRole.id}/permissions`, { permissions: [] })).status).toBe(409);
  });

  it('applies a permission change to a role immediately and records it', async () => {
    const roles = (await s.admin.get('/roles')).body.roles as Array<{ id: string; key: string; permissions: string[] }>;
    const cashier = roles.find((r) => r.key === 'CASHIER')!;
    const without = cashier.permissions.filter((p) => p !== 'payment.create');
    expect((await s.admin.put(`/roles/${cashier.id}/permissions`, { permissions: without })).status).toBe(200);
    expect((await s.cashier.post('/payments', payment(1000))).status).toBe(403);
    expect((await s.admin.put(`/roles/${cashier.id}/permissions`, { permissions: cashier.permissions })).status).toBe(200);
    expect((await s.cashier.post('/payments', payment(1000))).status).toBe(201);
    expect(await prisma.auditLog.count({ where: { action: 'ROLE_PERMISSIONS_CHANGED' } })).toBe(2);
  });
});

describe('input handling', () => {
  it('returns clear validation errors instead of server errors', async () => {
    const res = await s.manager.post('/tenants', { fullName: '', idNumber: '!!', phone: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    // Field-level problems are reported together; the ID-number format is checked once those are fixed.
    expect(Object.keys(res.body.error.details.fields).sort()).toEqual(['fullName', 'phone']);
    expect((await s.manager.post('/payments', { ...payment(), amount: -50 })).status).toBe(400);
    expect((await s.manager.post('/payments', { ...payment(), amount: '1e9' })).status).toBe(400);
    expect((await s.manager.get('/rooms/not-a-uuid')).status).toBe(400);
    expect((await s.manager.get('/rooms/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('treats hostile strings as plain data (no SQL injection, stored verbatim)', async () => {
    const evil = `Robert'); DROP TABLE tenants;-- <script>alert(1)</script>`;
    const created = await s.manager.post('/tenants', { fullName: evil, idType: 'PASSPORT', idNumber: 'INJ0001', phone: '+250788000222', ...tenantDetails() });
    expect(created.status).toBe(201);
    const found = await s.manager.get(`/tenants?q=${encodeURIComponent(`' OR '1'='1`)}`);
    expect(found.status).toBe(200);
    expect(found.body.items).toHaveLength(0);
    const back = await s.manager.get(`/tenants/${created.body.id}`);
    expect(back.body.fullName).toBe(evil);
    expect(back.headers['content-type']).toMatch(/application\/json/);
    expect(await prisma.tenant.count()).toBeGreaterThan(1);
  });

  it('sends security headers and exposes a health endpoint', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'ok' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('accepts only genuine documents and serves them only to authorised users', async () => {
    const tenant = (await s.manager.get('/tenants?pageSize=1')).body.items[0];
    const upload = (name: string, content: Buffer, session = s.manager) =>
      request(app).post('/api/v1/documents').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
        .field('entityType', 'Tenant').field('entityId', tenant.id).field('category', 'ID_DOCUMENT').attach('file', content, name);
    expect((await upload('id.exe', Buffer.from('MZ...'))).status).toBe(400);
    expect((await upload('id.pdf', Buffer.from('<html>not a pdf</html>'))).body.error.code).toBe('FILE_TYPE');
    expect((await upload('../../etc/passwd.pdf', Buffer.from('%PDF-1.4 test'), s.viewer)).status).toBe(403);
    const ok = await upload('../../id card.pdf', Buffer.from('%PDF-1.4 genuine'));
    expect(ok.status).toBe(201);
    expect(ok.body.storedName).toMatch(/^[0-9a-f]{32}\.pdf$/);
    expect((await request(app).get(`/api/v1/documents/${ok.body.id}/download`)).status).toBe(401);
    const got = await s.viewer.get(`/documents/${ok.body.id}/download`);
    expect(got.status).toBe(200);
    expect(got.headers['content-disposition']).toMatch(/^attachment/);
    // Cashier role has no tenant.view? It does — but a role without access to the entity is refused:
    const roles = (await s.admin.get('/roles')).body.roles as Array<{ id: string; key: string; permissions: string[] }>;
    const viewer = roles.find((r) => r.key === 'VIEWER')!;
    await s.admin.put(`/roles/${viewer.id}/permissions`, { permissions: viewer.permissions.filter((p) => p !== 'tenant.view') });
    expect((await s.viewer.get(`/documents/${ok.body.id}/download`)).status).toBe(403);
    await s.admin.put(`/roles/${viewer.id}/permissions`, { permissions: viewer.permissions });
  });
});
