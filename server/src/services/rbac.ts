import { inTransaction, prisma, type Db } from '../db.js';
import { ALL_PERMISSIONS, PERMISSIONS, SYSTEM_ROLES, type PermissionKey } from '../auth/permissions.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { Actor } from '../http/context.js';
import { audit } from './audit.js';

/**
 * Writes the permission catalog and system roles to the database. Safe to run on every
 * deploy: existing roles keep any customised permissions; only brand-new permissions
 * are granted to the roles that should have them by default. SUPER_ADMIN always has all.
 */
export async function syncRbac(db: Db = prisma): Promise<void> {
  const existing = new Set((await db.permission.findMany({ select: { key: true } })).map((p) => p.key));
  const fresh: PermissionKey[] = [];
  for (const key of ALL_PERMISSIONS) {
    const [category, description] = PERMISSIONS[key];
    await db.permission.upsert({ where: { key }, create: { key, category, description }, update: { category, description } });
    if (!existing.has(key)) fresh.push(key);
  }
  const permissions = await db.permission.findMany();
  const idOf = new Map(permissions.map((p) => [p.key, p.id]));
  for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
    const before = await db.role.findUnique({ where: { key } });
    const role = await db.role.upsert({ where: { key }, create: { key, name: def.name, description: def.description, isSystem: true }, update: { isSystem: true } });
    const grant = !before || key === 'SUPER_ADMIN' ? def.permissions : def.permissions.filter((p) => fresh.includes(p));
    if (grant.length) {
      await db.rolePermission.createMany({ data: grant.map((p) => ({ roleId: role.id, permissionId: idOf.get(p)! })), skipDuplicates: true });
    }
  }
}

export async function listRoles() {
  const roles = await prisma.role.findMany({ include: { permissions: { include: { permission: { select: { key: true } } } }, _count: { select: { users: true } } }, orderBy: { name: 'asc' } });
  return roles.map(({ permissions, _count, ...r }) => ({ ...r, userCount: _count.users, permissions: permissions.map((p) => p.permission.key).sort() }));
}

export function permissionCatalog() {
  return ALL_PERMISSIONS.map((key) => ({ key, category: PERMISSIONS[key][0], description: PERMISSIONS[key][1] }));
}

export async function setRolePermissions(actor: Actor, roleId: string, keys: string[]) {
  const unknown = keys.filter((k) => !(k in PERMISSIONS));
  if (unknown.length) throw badRequest(`Unknown permission(s): ${unknown.join(', ')}`);
  return inTransaction(async (tx) => {
    const role = await tx.role.findUnique({ where: { id: roleId }, include: { permissions: { include: { permission: true } } } });
    if (!role) throw notFound('Role');
    if (role.key === 'SUPER_ADMIN') throw conflict('The Super Admin role always has every permission and cannot be changed.');
    const before = role.permissions.map((p) => p.permission.key).sort();
    const wanted = await tx.permission.findMany({ where: { key: { in: keys } } });
    await tx.rolePermission.deleteMany({ where: { roleId } });
    if (wanted.length) await tx.rolePermission.createMany({ data: wanted.map((p) => ({ roleId, permissionId: p.id })) });
    const after = wanted.map((p) => p.key).sort();
    await audit(tx, actor, {
      action: 'ROLE_PERMISSIONS_CHANGED', entityType: 'Role', entityId: roleId, summary: `Permissions of role ${role.name} changed`,
      oldValue: { removed: before.filter((k) => !after.includes(k)) }, newValue: { added: after.filter((k) => !before.includes(k)) },
    });
    return after;
  });
}

export async function createRole(actor: Actor, input: { name: string; description?: string; permissions: string[] }) {
  const key = input.name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!key) throw badRequest('Enter a role name.');
  if (await prisma.role.findUnique({ where: { key } })) throw conflict('A role with this name already exists.');
  const role = await prisma.role.create({ data: { key, name: input.name.trim(), description: input.description ?? null } });
  await audit(prisma, actor, { action: 'ROLE_CREATED', entityType: 'Role', entityId: role.id, summary: `Role ${role.name} created` });
  await setRolePermissions(actor, role.id, input.permissions);
  return role;
}

/** Only someone who can manage roles may hand out the Super Admin role. */
export function assertCanAssign(actor: Actor, roleKeys: string[]): void {
  if (roleKeys.includes('SUPER_ADMIN') && !actor.roles.includes('SUPER_ADMIN')) throw forbidden('Only a Super Admin can grant the Super Admin role.');
}
