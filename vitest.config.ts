import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 30_000,
    // Automated tests only ever use synthetic fixture roots, never the real
    // Downloads directory (AGENTS.md rule 12).
    environment: 'node',
  },
});
