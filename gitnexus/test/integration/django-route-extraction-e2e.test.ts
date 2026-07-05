/**
 * End-to-end coverage of the main-thread Django cross-file route pass.
 *
 * Unit tests pin `extractDjangoRoutes` and `discoverDjangoRootUrls` in
 * isolation; this file runs the whole pipeline (`runPipelineFromRepo`) against
 * an on-disk fixture so the orchestration glue — discovery → parse →
 * `extractRoutes` → `allExtractedRoutes` → `Route` graph nodes — is actually
 * exercised. The fixture deliberately places the Django project under a
 * `backend/` subdirectory so this test also guards the subdir-discovery fix
 * (#1836 R1): if discovery resolved the settings module from the repo root
 * instead of the manage.py directory, no `Route` nodes would appear at all.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../types/pipeline.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'django-subdir-app');

describe('Django cross-file route extraction — ingestion pipeline', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(FIXTURE, () => {}, {});
  }, 60_000);

  const routeNames = (): string[] => {
    const nodes: Array<{ label: string; name: string }> = [];
    result.graph.forEachNode((n) => {
      nodes.push({ label: String(n.label), name: String(n.properties.name) });
    });
    return nodes
      .filter((n) => n.label === 'Route')
      .map((n) => n.name)
      .sort();
  };

  it('discovers the subdir project root and emits prefixed Route nodes across the include()', () => {
    const names = routeNames();
    // Root-level route — proves backend/manage.py → root urls.py discovery.
    expect(names).toContain('/health');
    // Included app routes inherit the parent `api/` prefix — proves the
    // cross-file include() walk and prefix accumulation end-to-end.
    expect(names).toContain('/api/items');
    expect(names).toContain('/api/items/<int:pk>');
  });
});
