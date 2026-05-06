/**
 * Structural tests for the safeClose helper extracted in #1376.
 *
 * Verifies the consolidation contract: closeLbug delegates to
 * safeClose rather than inlining its own CHECKPOINT logic, and
 * safeClose is exported for callers like the /api/embed handler
 * that need a WAL flush without a full close.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('safeClose — consolidation guard (#1376)', () => {
  let adapterSource: string;

  beforeAll(async () => {
    adapterSource = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'core', 'lbug', 'lbug-adapter.ts'),
      'utf-8',
    );
  });

  it('exports safeClose', () => {
    expect(adapterSource).toMatch(/export const safeClose/);
  });

  it('closeLbug delegates to safeClose instead of inlining conn.query', () => {
    // closeLbug must call safeClose() — not duplicate the
    // try/catch conn.query('CHECKPOINT') pattern.
    const closeLbugBody = adapterSource.slice(adapterSource.indexOf('export const closeLbug'));
    expect(closeLbugBody).toMatch(/await safeClose\(\)/);
  });

  it('safeClose is the only place that issues conn.query(CHECKPOINT)', () => {
    // Every conn.query('CHECKPOINT') call should live inside
    // safeClose, not scattered across closeLbug or api.ts.
    const matches = adapterSource.match(/conn\.query\('CHECKPOINT'\)/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
