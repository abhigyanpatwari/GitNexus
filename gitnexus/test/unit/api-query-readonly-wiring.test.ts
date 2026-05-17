import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('api query read-only wiring', () => {
  it('uses withLbugDb readOnly mode for /api/query', async () => {
    const source = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'server', 'api.ts'),
      'utf-8',
    );
    expect(source).toMatch(/app\.post\('\/api\/query'[\s\S]*withLbugDb\([\s\S]*readOnly:\s*true/);
  });

  it('opens Ladybug connection with readOnly option when requested', async () => {
    const source = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'core', 'lbug', 'lbug-adapter.ts'),
      'utf-8',
    );
    expect(source).toMatch(/openLbugConnection\(lbug,\s*dbPath,\s*\{\s*readOnly:\s*true\s*\}\)/);
  });
});
