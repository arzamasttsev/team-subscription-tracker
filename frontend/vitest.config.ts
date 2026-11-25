import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { TZ: 'Europe/Moscow' },
    include: ['src/**/*.test.ts'],
  },
});
