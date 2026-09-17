import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('TypeScript 7 + React frontend toolchain', () => {
  it('keeps Vite and Vitest on the automatic JSX runtime that matches react-jsx', () => {
    const vite = readFileSync(path.join(webRoot, 'vite.config.ts'), 'utf8');
    const vitest = readFileSync(path.join(webRoot, 'vitest.config.ts'), 'utf8');
    expect(vite).toContain('@vitejs/plugin-react');
    expect(vite).toContain("jsxRuntime: 'automatic'");
    expect(vitest).toContain('@vitejs/plugin-react');
    expect(vitest).toContain("jsxRuntime: 'automatic'");
  });
});
