import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/search.ts', 'src/lib/storage.ts', 'src/lib/documents.ts'],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
      reporter: ['text', 'html'],
    },
  },
});
