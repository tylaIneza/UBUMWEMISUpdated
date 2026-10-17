import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { app, createWorld, loginAs, PASSWORD, type Session, type World } from './helpers.js';

let w: World;
let admin: Session;

const signIn = (login: string, password = PASSWORD) => request(app).post('/api/v1/auth/login').send({ login, password });

beforeAll(async () => {
  w = await createWorld();
  admin = await loginAs(w.emails.SUPER_ADMIN);
  await prisma.user.update({ where: { id: w.actors.CASHIER.userId }, data: { phone: '+250788123456' } });
});

describe('signing in with a phone number', () => {
  it('accepts the phone number on the account, however it is typed', async () => {
    for (const typed of ['0788123456', '078 812 3456', '+250788123456', '250788123456']) {
      const res = await signIn(typed);
      expect(res.status, typed).toBe(200);
      const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
      const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);
      expect(me.body.user.email, typed).toBe(w.emails.CASHIER);
    }
  });

  it('still accepts the e-mail address, under the new and the old field name', async () => {
    expect((await signIn(w.emails.CASHIER)).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/login').send({ email: w.emails.CASHIER, password: PASSWORD })).status).toBe(200);
  });

  it('gives the same answer for a wrong password and an unknown number', async () => {
    const wrong = await signIn('0788123456', 'nope-nope-nope');
    const unknown = await signIn('0788999999', 'nope-nope-nope');
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('does not let two users share a phone number', async () => {
    const taken = await admin.patch(`/users/${w.actors.VIEWER.userId}`, { phone: '078 812 3456' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.message).toMatch(/already used by Test CASHIER/);
    const created = await admin.post('/users', { email: 'new@test.rw', fullName: 'New User', phone: '0788123456', password: 'Another@Pass2026', roles: ['VIEWER'] });
    expect(created.status).toBe(409);
  });

  it('stores an edited phone number in the standard form, so it works for signing in', async () => {
    expect((await admin.patch(`/users/${w.actors.VIEWER.userId}`, { phone: '079 111 2233' })).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: w.actors.VIEWER.userId } })).phone).toBe('+250791112233');
    expect((await signIn('0791112233')).status).toBe(200);
  });
});
