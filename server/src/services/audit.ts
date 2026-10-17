import type { Db } from '../db.js';
import { Prisma } from '../db.js';
import type { Actor } from '../http/context.js';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string;
  oldValue?: unknown;
  newValue?: unknown;
}

const SENSITIVE = new Set(['passwordHash', 'password', 'tokenHash', 'csrfToken', 'token']);

/** Converts a value to plain JSON (Decimals → strings, Dates → ISO) and strips secrets. */
function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  return JSON.parse(
    JSON.stringify(value, (key, v) => (SENSITIVE.has(key) ? undefined : typeof v === 'bigint' ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

/**
 * Writes one audit row. Always call with the same transaction client as the change it
 * describes, so the change and its audit record commit or roll back together.
 */
export async function audit(db: Db, actor: Actor | null, entry: AuditEntry, orgId?: string): Promise<void> {
  await db.auditLog.create({
    data: {
      orgId: actor?.orgId ?? orgId ?? null,
      userId: actor?.userId ?? null,
      userLabel: actor ? `${actor.name} <${actor.email}>` : null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      summary: entry.summary?.slice(0, 500) ?? null,
      oldValue: toJson(entry.oldValue),
      newValue: toJson(entry.newValue),
      ip: actor?.ip?.slice(0, 64) ?? null,
      userAgent: actor?.userAgent?.slice(0, 255) ?? null,
    },
  });
}

/** Returns only the keys of `after` whose value differs from `before` (for compact old/new audit values). */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>): { old: Partial<T>; new: Partial<T> } | null {
  const o: Partial<T> = {};
  const n: Partial<T> = {};
  for (const key of Object.keys(after) as Array<keyof T>) {
    const a = before[key];
    const b = after[key];
    if (b === undefined) continue;
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      o[key] = a;
      n[key] = b;
    }
  }
  return Object.keys(n).length ? { old: o, new: n } : null;
}
