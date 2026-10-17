import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { createTenant, updateTenant } from '../src/services/tenants.js';
import { createWorld, failure, loginAs, tenantDetails, tinNumber, type Session, type World } from './helpers.js';

let w: World;
let staff: Session;
const base = { fullName: 'Uwase Aline', phone: '+250788123000' };

beforeAll(async () => {
  w = await createWorld();
  staff = await loginAs(w.emails.PROPERTY_STAFF);
});

describe('one ID number = one tenant', () => {
  it('registers a tenant with a valid Rwandan ID and stores it without spaces', async () => {
    const t = await createTenant(w.actors.PROPERTY_STAFF, { ...base, idNumber: '1 1995 7 0034567 1 23' });
    expect(t.idNumber).toBe('1199570034567123');
  });

  it('refuses the same ID number again, however it is typed, and names the existing tenant', async () => {
    for (const variant of ['1199570034567123', '1 1995 7 0034567 1 23', '1199-5700-3456-7123']) {
      const err = await failure(createTenant(w.actors.PROPERTY_STAFF, { ...base, fullName: 'Someone Else', idNumber: variant }));
      expect(err.code).toBe('DUPLICATE_TENANT');
      expect(err.message).toContain('Uwase Aline');
    }
    expect(await prisma.tenant.count({ where: { idNumber: '1199570034567123' } })).toBe(1);
    // …and the database itself refuses a second row with that number.
    await expect(prisma.tenant.create({ data: { orgId: w.orgId, ...base, idNumber: '1199570034567123' } })).rejects.toThrow();
  });

  it('refuses a number that is not a Rwandan national ID', async () => {
    for (const bad of ['123567890', '3456789', '1111111111', '519957003456712A']) {
      expect((await failure(createTenant(w.actors.PROPERTY_STAFF, { ...base, idNumber: bad }))).code).toBe('INVALID_ID_NUMBER');
    }
  });

  it('accepts a passport for foreign tenants, also only once', async () => {
    await createTenant(w.actors.PROPERTY_STAFF, { ...base, fullName: 'John Smith', idType: 'PASSPORT', idNumber: 'pc 1234567' });
    expect((await failure(createTenant(w.actors.PROPERTY_STAFF, { ...base, idType: 'PASSPORT', idNumber: 'PC1234567' }))).code).toBe('DUPLICATE_TENANT');
  });

  it('does not let an edit take another tenant\'s ID number, but other edits of older records still work', async () => {
    const other = await createTenant(w.actors.PROPERTY_STAFF, { ...base, fullName: 'Mugisha Eric', idNumber: '1198880012345601' });
    expect((await failure(updateTenant(w.actors.PROPERTY_STAFF, other.id, { idNumber: '1199570034567123' }))).code).toBe('DUPLICATE_TENANT');
    const legacy = await prisma.tenant.create({ data: { orgId: w.orgId, ...base, fullName: 'Old Record', idNumber: '3456789' } });
    await expect(updateTenant(w.actors.PROPERTY_STAFF, legacy.id, { phone: '+250788999000', idNumber: '3456789' })).resolves.toBeTruthy();
    expect((await failure(updateTenant(w.actors.PROPERTY_STAFF, legacy.id, { idNumber: '34567890' }))).code).toBe('INVALID_ID_NUMBER');
    await expect(updateTenant(w.actors.PROPERTY_STAFF, legacy.id, { idNumber: '1200180012345600' })).resolves.toMatchObject({ idNumber: '1200180012345600' });
  });

  it('lets the form check a number before anything is saved', async () => {
    const dup = await staff.get('/tenants/check-id?idType=NATIONAL_ID&idNumber=1%201995%207%200034567%201%2023');
    expect(dup.body).toMatchObject({ normalized: '1199570034567123', problem: null, existing: { fullName: 'Uwase Aline' } });
    const bad = await staff.get('/tenants/check-id?idType=NATIONAL_ID&idNumber=123');
    expect(bad.body.problem).toMatch(/16 digits/);
    const free = await staff.get('/tenants/check-id?idType=NATIONAL_ID&idNumber=1199080099999901');
    expect(free.body).toMatchObject({ problem: null, existing: null });
    const res = await staff.post('/tenants', { ...base, ...tenantDetails(), idNumber: '1199570034567123' });
    expect([res.status, res.body.error.code, res.body.error.details.fields.idNumber]).toEqual([409, 'DUPLICATE_TENANT', 'Already registered to Uwase Aline.']);
  });

  it('requires a valid 9-digit TIN, unique to one tenant, and the full address', async () => {
    const staff = await loginAs(w.emails.PROPERTY_STAFF);
    const noAddress = await staff.post('/tenants', { fullName: 'Kalisa Eric', phone: '+250788123001', idNumber: '1199680012345678' });
    expect(Object.keys(noAddress.body.error.details.fields).sort()).toEqual(['cell', 'district', 'sector', 'tin', 'village']);
    const badTin = await staff.post('/tenants', { fullName: 'Kalisa Eric', phone: '+250788123001', idNumber: '1199680012345678', ...tenantDetails(), tin: '12345' });
    expect(badTin.body.error.details.fields.tin).toBe('A TIN number has 9 digits; this one has 5.');
    const tin = tinNumber();
    const first = await staff.post('/tenants', { fullName: 'Kalisa Eric', phone: '+250788123001', idNumber: '1199680012345678', ...tenantDetails(), tin: `${tin.slice(0, 3)} ${tin.slice(3, 6)} ${tin.slice(6)}` });
    expect([first.status, first.body.tin]).toEqual([201, tin]);
    expect((await staff.get(`/tenants/check-tin?tin=${tin}`)).body.existing.fullName).toBe('Kalisa Eric');
    const dup = await staff.post('/tenants', { fullName: 'Other Person', phone: '+250788123002', idNumber: '1199680012345679', ...tenantDetails(), tin });
    expect([dup.status, dup.body.error.code, dup.body.error.details.fields.tin]).toEqual([409, 'DUPLICATE_TIN', 'Already registered to Kalisa Eric.']);
    const second = await staff.post('/tenants', { fullName: 'Other Person', phone: '+250788123002', idNumber: '1199680012345679', ...tenantDetails() });
    expect((await staff.patch(`/tenants/${second.body.id}`, { tin })).body.error.code).toBe('DUPLICATE_TIN');
  });
});

describe('e-mail verification', () => {
  it('lets an administrator confirm a user e-mail directly, and an opened link stays valid when reopened', async () => {
    const { issueVerification, verifyEmail } = await import('../src/services/auth.js');
    const admin = await loginAs(w.emails.SUPER_ADMIN);
    const user = await prisma.user.findFirstOrThrow({ where: { email: w.emails.VIEWER } });
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: null } });
    const { link } = await issueVerification(user.id);
    const token = new URL(link).searchParams.get('token')!;
    await verifyEmail(token);
    await expect(verifyEmail(token)).resolves.toBeUndefined(); // reopening the link is fine
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: null } });
    expect((await admin.post(`/users/${user.id}/mark-email-verified`, {})).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).not.toBeNull();
  });
});
