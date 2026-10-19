import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // Test-only bindings. Values here are fixtures, not secrets.
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENVIRONMENT: 'test',
            APP_URL: 'https://cartprobe.test',
            APP_DOMAIN: 'cartprobe.test',
            SESSION_SECRET: 'test-session-secret-0123456789abcdef',
            IP_HASH_SALT: 'test-ip-salt',
            ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
            EMAIL_PROVIDER: 'console',
            EMAIL_FROM: 'CartProbe <test@cartprobe.test>',
            BILLING_PROVIDER: 'webhook',
            BILLING_WEBHOOK_SECRET: 'whsec_test_secret',
            ADMIN_EMAILS: 'admin@cartprobe.test',
            MOCK_STORE_ORIGIN: '',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
      testTimeout: 30_000,
    },
  };
});
