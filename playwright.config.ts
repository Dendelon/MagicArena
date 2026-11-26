import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testIgnore:
    process.env.VITE_PROFILE === '1'
      ? undefined
      : '**/worker-decoder.spec.ts',

  fullyParallel: false,
  workers: 1,

  forbidOnly: Boolean(process.env.CI),
  retries: 0,

  timeout: 60_000,

  expect: {
    timeout: 10_000,
  },

  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: 'http://127.0.0.1:3100',

    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',

      use: {
        ...devices['Desktop Chrome'],

        viewport: {
          width: 1280,
          height: 900,
        },
      },
    },
  ],

  webServer: {
    command: 'npm run build && node server/src/index.ts',

    url: 'http://127.0.0.1:3100/health',

    timeout: 120_000,

    reuseExistingServer: false,

    env: {
      HOST: '127.0.0.1',
      PORT: '3100',

      NET_CODEC: 'binary',
      NET_DELAY_MS: '0',
      NET_JITTER_MS: '0',
      NET_DROP_RATE: '0',

      RSS_PROFILE: '0',
      ENABLE_SLOW_DEMO: '0',

      LOG_DIR: 'server/logs/e2e',

      VITE_E2E: '1',
      VITE_PROFILE: process.env.VITE_PROFILE ?? '0',
    },

    stdout: 'pipe',
    stderr: 'pipe',
  },
});

