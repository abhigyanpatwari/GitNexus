import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('TypeScript 7 + React frontend toolchain', () => {
  it('keeps Vite and Vitest on the automatic JSX runtime that matches react-jsx', () => {
    for (const configFile of ['vite.config.ts', 'vitest.config.ts'] as const) {
      const source = readFileSync(path.join(webRoot, configFile), 'utf8');
      expect(source).toContain('@vitejs/plugin-react');
      expect(source).toContain("jsxRuntime: 'automatic'");
    }
  });
});
