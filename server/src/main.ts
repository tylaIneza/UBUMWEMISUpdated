import { config } from './config.js';
import { prisma } from './db.js';
import { createApp } from './http/app.js';
import { logger } from './logger.js';
import { syncRbac } from './services/rbac.js';
import { startScheduler, stopScheduler } from './services/scheduler.js';

async function main() {
  await prisma.$queryRaw`SELECT 1`;
  await syncRbac();
  const app = createApp();
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, environment: config.NODE_ENV }, 'rental property management API listening');
  });
  if (config.DISABLE_SCHEDULER !== 'true') startScheduler();

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopScheduler();
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'server failed to start');
  process.exit(1);
});
