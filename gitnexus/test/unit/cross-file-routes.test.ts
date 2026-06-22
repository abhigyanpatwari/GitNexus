import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtractedRoute } from '../../src/core/ingestion/workers/parse-worker.js';

// Hoisted so the (also-hoisted) vi.mock factory below can reference it.
const { extractRoutesSpy } = vi.hoisted(() => ({
  extractRoutesSpy: vi.fn((): ExtractedRoute[] => {
    throw new Error('boom from a misbehaving provider');
  }),
}));

// Override only the route hooks on the real Python provider so the main-thread
// pass reaches extractRoutes and the throw exercises the in-loop guard. Every
// other dependency (parser, parse, fs reader) stays real.
vi.mock('../../src/core/ingestion/languages/index.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/ingestion/languages/index.js')>();
  return {
    ...actual,
    getProvider: (lang: Parameters<typeof actual.getProvider>[0]) => ({
      ...actual.getProvider(lang),
      discoverRootRouteFiles: () => ['proj/urls.py'],
      extractRoutes: extractRoutesSpy,
    }),
  };
});

import { extractCrossFileRoutes } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';

let repoDir: string;

beforeAll(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-xfr-'));
  fs.mkdirSync(path.join(repoDir, 'proj'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'proj/urls.py'), 'urlpatterns = []\n');
});

afterAll(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('extractCrossFileRoutes', () => {
  it('isolates a throwing provider.extractRoutes instead of aborting the run', async () => {
    const routes = await extractCrossFileRoutes(['proj/urls.py'], repoDir);
    // The guard caught the throw (provider was actually reached) and the run
    // produced no routes rather than propagating the error.
    expect(extractRoutesSpy).toHaveBeenCalledTimes(1);
    expect(routes).toEqual([]);
  });
});
