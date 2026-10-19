import { z } from 'zod';

/** Cloudflare bindings + vars + secrets. Secrets come from `wrangler secret put` / .dev.vars only. */
export interface Bindings {
  DB: D1Database;
  CAPTURES?: R2Bucket;
  ENVIRONMENT: string;
  APP_URL: string;
  APP_DOMAIN: string;
  SESSION_SECRET: string;
  IP_HASH_SALT: string;
  ENCRYPTION_KEY: string;
  EMAIL_PROVIDER: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM: string;
  BILLING_PROVIDER: string;
  BILLING_WEBHOOK_SECRET?: string;
  CHECKOUT_URL_STORE?: string;
  CHECKOUT_URL_AGENCY?: string;
  CHECKOUT_URL_VENDOR?: string;
  ADMIN_EMAILS?: string;
  MOCK_STORE_ORIGIN?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends Bindings {}
  }
}

const base64Key = z.string().refine((s) => {
  try {
    return atob(s).length === 32;
  } catch {
    return false;
  }
}, 'must be base64 of exactly 32 bytes (openssl rand -base64 32)');

export const envSchema = z
  .object({
    ENVIRONMENT: z.enum(['production', 'development', 'test']).default('production'),
    APP_URL: z.url(),
    APP_DOMAIN: z.string().min(3),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    IP_HASH_SALT: z.string().min(8),
    ENCRYPTION_KEY: base64Key,
    EMAIL_PROVIDER: z.enum(['console', 'resend']),
    EMAIL_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().min(3),
    BILLING_PROVIDER: z.enum(['manual', 'webhook']),
    BILLING_WEBHOOK_SECRET: z.string().optional(),
    CHECKOUT_URL_STORE: z.string().optional(),
    CHECKOUT_URL_AGENCY: z.string().optional(),
    CHECKOUT_URL_VENDOR: z.string().optional(),
    ADMIN_EMAILS: z.string().optional(),
    MOCK_STORE_ORIGIN: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.EMAIL_PROVIDER === 'resend' && !e.EMAIL_API_KEY) ctx.addIssue({ code: 'custom', path: ['EMAIL_API_KEY'], message: 'required when EMAIL_PROVIDER=resend' });
    if (e.BILLING_PROVIDER === 'webhook' && !e.BILLING_WEBHOOK_SECRET) ctx.addIssue({ code: 'custom', path: ['BILLING_WEBHOOK_SECRET'], message: 'required when BILLING_PROVIDER=webhook' });
    if (e.ENVIRONMENT === 'production' && !e.APP_URL.startsWith('https://')) ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'must be https in production' });
  });

export type AppEnv = z.infer<typeof envSchema>;

let cached: { key: unknown; value: AppEnv } | null = null;

/** Validate env once per isolate. Throws a readable error listing every problem. */
export function appEnv(bindings: Bindings): AppEnv {
  if (cached?.key === bindings) return cached.value;
  const r = envSchema.safeParse(bindings);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${msg}`);
  }
  cached = { key: bindings, value: r.data };
  return r.data;
}

export function adminEmails(env: AppEnv): string[] {
  return (env.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
