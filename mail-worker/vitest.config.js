import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 15000,
  },
});
