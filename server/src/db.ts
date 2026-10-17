import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { config } from './config.js';
import { Prisma, PrismaClient } from './generated/prisma/client.js';

function adapterFromUrl(url: string) {
  const u = new URL(url);
  return new PrismaMariaDb({
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    connectionLimit: 10,
    // Dates are stored and read as UTC regardless of the server's time zone.
    timezone: 'Z',
  });
}

/** SLOW_QUERY_MS=300 logs every database query slower than 300 ms (off by default). */
const slowQueryMs = Number(process.env.SLOW_QUERY_MS ?? 0);

export const prisma = new PrismaClient({
  adapter: adapterFromUrl(config.DATABASE_URL),
  ...(slowQueryMs > 0 ? { log: [{ emit: 'event' as const, level: 'query' as const }] } : {}),
});
if (slowQueryMs > 0) {
  (prisma as unknown as { $on: (e: 'query', cb: (q: { duration: number; query: string }) => void) => void }).$on('query', (q) => {
    if (q.duration >= slowQueryMs) console.warn(`[slow query ${q.duration} ms] ${q.query.slice(0, 600)}`);
  });
}

export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient | Tx;

/**
 * Runs `fn` in one database transaction. READ COMMITTED is used so that, once a row
 * lock (SELECT … FOR UPDATE) has been obtained, subsequent reads see the latest
 * committed data rather than a stale snapshot.
 */
export function inTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 10_000,
    timeout: 30_000,
  });
}

/** Serialises concurrent financial operations on one contract. */
export async function lockContract(tx: Tx, contractId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM contracts WHERE id = ${contractId} FOR UPDATE`;
}

/** Serialises concurrent occupancy changes on one room. */
export async function lockRoom(tx: Tx, roomId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM rooms WHERE id = ${roomId} FOR UPDATE`;
}

export { Prisma };
