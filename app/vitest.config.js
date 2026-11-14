import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc', environment: 'test' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            DEV: 'true',
            TURNSTILE_SECRET: 'unused-in-dev',
            BREVO_API_KEY: 'unused-in-dev',
            CODE_PEPPER: 'test-pepper',
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/setup.js'] },
  };
});
