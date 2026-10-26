import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/motion-capabilities.ts', 'src/lib/search.ts', 'src/lib/storage.ts', 'src/lib/documents.ts', 'src/lib/commands.ts', 'src/lib/reading-preferences.ts', 'src/lib/writing-tools.ts', 'src/lib/content-blocks.ts'],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
      // Vitest's agent formatter otherwise hides fully covered modules in text output.
      reporter: [['text', { skipFull: false }], 'html', 'json-summary'],
    },
  },
});
