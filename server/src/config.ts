import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  APP_URL: z.string().url().default('http://localhost:5173'),
  STORAGE_DIR: z.string().default('./storage'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(10),
  LOG_LEVEL: z.string().default('info'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  /** Directory of the built web app to serve (production). Empty = API only. */
  WEB_DIST: z.string().default(''),
  // Optional real e-mail transport. When unset, e-mail is NOT sent (and never reported as sent).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMTP_SECURE: z.enum(['true', 'false']).optional(),
  // Optional real SMS delivery. When unset, SMS is never claimed as sent.
  SMS_PROVIDER: z.enum(['africastalking', 'pindo']).optional().or(z.literal('').transform(() => undefined)),
  SMS_API_KEY: z.string().optional(),
  SMS_USERNAME: z.string().optional(),
  SMS_SENDER_ID: z.string().optional(),
  DISABLE_SCHEDULER: z.enum(['true', 'false']).default('false'),
  DISABLE_RATE_LIMIT: z.enum(['true', 'false']).default('false'),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}\nSee .env.example.`);
  }
  return parsed.data;
}

export const config = load();
export const isProd = config.NODE_ENV === 'production' || config.NODE_ENV === 'staging';
export const isTest = config.NODE_ENV === 'test';
