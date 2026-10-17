import { inTransaction, prisma, type Tx } from '../db.js';
import { hashPassword, passwordProblem } from '../auth/passwords.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { Actor } from '../http/context.js';
import { audit } from './audit.js';
import { issueVerification } from './auth.js';
import { assertCanAssign } from './rbac.js';

const publicUser = {
  id: true, email: true, fullName: true, phone: true, status: true, emailVerifiedAt: true, mustChangePassword: true,
  lastLoginAt: true, lockedUntil: true, deletedAt: true, createdAt: true,
  roles: { select: { role: { select: { id: true, key: true, name: true } } } },
} as const;

export async function listUsers(orgId: string, includeDeleted = false) {
  const users = await prisma.user.findMany({ where: { orgId, ...(includeDeleted ? {} : { deletedAt: null }) }, select: publicUser, orderBy: { fullName: 'asc' } });
  return users.map(({ roles, ...u }) => ({ ...u, roles: roles.map((r) => r.role) }));
}

/** Minimal list for "assigned to" pickers — available to anyone who can manage maintenance. */
export async function staffDirectory(orgId: string) {
  return prisma.user.findMany({ where: { orgId, deletedAt: null, status: 'ACTIVE' }, select: { id: true, fullName: true }, orderBy: { fullName: 'asc' } });
}

async function rolesByKey(tx: Tx, keys: string[]) {
  const roles = await tx.role.findMany({ where: { key: { in: keys } } });
  if (roles.length !== new Set(keys).size) throw badRequest('One or more selected roles do not exist.');
  return roles;
}

async function assertNotLastSuperAdmin(tx: Tx, orgId: string, userId: string): Promise<void> {
  const others = await tx.user.count({ where: { orgId, id: { not: userId }, deletedAt: null, status: 'ACTIVE', roles: { some: { role: { key: 'SUPER_ADMIN' } } } } });
  if (others === 0) throw conflict('This is the only active Super Admin. Create another Super Admin first.', 'LAST_ADMIN');
}

/** Users can sign in with their phone number, so two users may not share one. */
async function assertPhoneFree(tx: Tx, phone: string | null | undefined, exceptUserId?: string) {
  if (!phone) return;
  const other = await tx.user.findFirst({ where: { phone, deletedAt: null, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) } });
  if (other) throw conflict(`This phone number is already used by ${other.fullName}. Each user needs their own number, because it can be used to sign in.`);
}

export async function createUser(actor: Actor, input: { email: string; fullName: string; phone?: string; password: string; roles: string[] }) {
  const problem = passwordProblem(input.password);
  if (problem) throw badRequest(problem, 'WEAK_PASSWORD');
  if (!input.roles.length) throw badRequest('Select at least one role.');
  assertCanAssign(actor, input.roles);
  const passwordHash = await hashPassword(input.password);
  const user = await inTransaction(async (tx) => {
    const roles = await rolesByKey(tx, input.roles);
    await assertPhoneFree(tx, input.phone);
    const created = await tx.user.create({
      // The administrator chose this password, so the user must replace it at first sign-in.
      data: { orgId: actor.orgId, email: input.email.toLowerCase(), fullName: input.fullName, phone: input.phone ?? null, passwordHash, mustChangePassword: true },
    });
    await tx.userRole.createMany({ data: roles.map((r) => ({ userId: created.id, roleId: r.id })) });
    await audit(tx, actor, { action: 'USER_CREATED', entityType: 'User', entityId: created.id, summary: `User ${created.fullName} <${created.email}> created with role(s) ${input.roles.join(', ')}`, newValue: { email: created.email, fullName: created.fullName, roles: input.roles } });
    return created;
  });
  const verification = await issueVerification(user.id);
  return { id: user.id, verification };
}

export async function updateUser(actor: Actor, id: string, input: { fullName?: string; phone?: string | null; status?: 'ACTIVE' | 'DISABLED'; roles?: string[] }) {
  return inTransaction(async (tx) => {
    const before = await tx.user.findFirst({ where: { id, orgId: actor.orgId, deletedAt: null }, include: { roles: { include: { role: true } } } });
    if (!before) throw notFound('User');
    const beforeRoles = before.roles.map((r) => r.role.key).sort();
    const isSelf = id === actor.userId;
    if (isSelf && input.status === 'DISABLED') throw conflict('You cannot disable your own account.');
    if (isSelf && input.roles && input.roles.slice().sort().join() !== beforeRoles.join()) throw conflict('You cannot change your own roles. Ask another administrator.');
    const losingAdmin = beforeRoles.includes('SUPER_ADMIN') && ((input.roles && !input.roles.includes('SUPER_ADMIN')) || input.status === 'DISABLED');
    if (losingAdmin) await assertNotLastSuperAdmin(tx, actor.orgId, id);
    if (input.roles) {
      if (!input.roles.length) throw badRequest('Select at least one role.');
      assertCanAssign(actor, [...input.roles, ...beforeRoles]);
      const roles = await rolesByKey(tx, input.roles);
      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.userRole.createMany({ data: roles.map((r) => ({ userId: id, roleId: r.id })) });
    }
    await assertPhoneFree(tx, input.phone, id);
    const user = await tx.user.update({ where: { id }, data: { fullName: input.fullName, phone: input.phone, status: input.status, ...(input.status === 'ACTIVE' ? { failedLogins: 0, lockedUntil: null } : {}) } });
    if (input.status === 'DISABLED') await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    const rolesChanged = input.roles && input.roles.slice().sort().join() !== beforeRoles.join();
    await audit(tx, actor, {
      action: rolesChanged ? 'USER_ROLES_CHANGED' : 'USER_UPDATED', entityType: 'User', entityId: id, summary: `User ${user.fullName} updated${rolesChanged ? ` — roles: ${input.roles!.join(', ')}` : ''}`,
      oldValue: { fullName: before.fullName, phone: before.phone, status: before.status, roles: beforeRoles }, newValue: { fullName: user.fullName, phone: user.phone, status: user.status, roles: input.roles ?? beforeRoles },
    });
    return user.id;
  });
}

/**
 * "Deleting" a user is a soft delete: the account can no longer sign in, but the row
 * stays so every payment, expense and audit entry keeps its owner.
 */
export async function removeUser(actor: Actor, id: string) {
  if (id === actor.userId) throw conflict('You cannot remove your own account.');
  return inTransaction(async (tx) => {
    const user = await tx.user.findFirst({ where: { id, orgId: actor.orgId, deletedAt: null }, include: { roles: { include: { role: true } } } });
    if (!user) throw notFound('User');
    if (user.roles.some((r) => r.role.key === 'SUPER_ADMIN')) {
      assertCanAssign(actor, ['SUPER_ADMIN']);
      await assertNotLastSuperAdmin(tx, actor.orgId, id);
    }
    await tx.user.update({ where: { id }, data: { deletedAt: new Date(), status: 'DISABLED' } });
    await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(tx, actor, { action: 'USER_REMOVED', entityType: 'User', entityId: id, summary: `User ${user.fullName} <${user.email}> removed (account deactivated; history kept)` });
  });
}
