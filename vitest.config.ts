import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,

    projects: [
      {
        test: {
          name: 'shared',
          environment: 'node',
          include: ['shared/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['server/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['client/test/**/*.test.ts'],
        },
      },
    ],

    coverage: {
      provider: 'v8',

      include: ['shared/src/**/*.ts'],

      reporter: ['text', 'html', 'json-summary'],

      reportsDirectory: './coverage',
    },
  },
});

