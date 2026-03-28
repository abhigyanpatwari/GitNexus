/**
 * Integration Tests: ORM Dataflow Detection (Prisma + Supabase)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const ORM_REPO = path.resolve(__dirname, '..', 'fixtures', 'orm-repo');

describe('ORM dataflow detection', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(ORM_REPO, () => {});
  }, 60000);

  it('creates QUERIES edges for Prisma calls', () => {
    const queryEdges: { source: string; target: string; reason: string }[] = [];
    for (const rel of result.graph.iterRelationships()) {
      if (rel.type === 'QUERIES') {
        const source = result.graph.getNode(rel.sourceId);
        const target = result.graph.getNode(rel.targetId);
        if (source && target) {
          queryEdges.push({
            source: source.properties.filePath || source.properties.name,
            target: target.properties.name,
            reason: rel.reason ?? '',
          });
        }
      }
    }
    const prismaEdges = queryEdges.filter((e) => e.source.includes('prisma-service'));
    const prismaModels = [...new Set(prismaEdges.map((e) => e.target))];
    expect(prismaModels).toContain('user');
    expect(prismaModels).toContain('post');
    const reasons = prismaEdges.map((e) => e.reason);
    expect(reasons.some((r) => r.includes('prisma-findMany'))).toBe(true);
    expect(reasons.some((r) => r.includes('prisma-create'))).toBe(true);
  });

  it('creates QUERIES edges for Supabase calls', () => {
    const queryEdges: { source: string; target: string; reason: string }[] = [];
    for (const rel of result.graph.iterRelationships()) {
      if (rel.type === 'QUERIES') {
        const source = result.graph.getNode(rel.sourceId);
        const target = result.graph.getNode(rel.targetId);
        if (source && target) {
          queryEdges.push({
            source: source.properties.filePath || source.properties.name,
            target: target.properties.name,
            reason: rel.reason ?? '',
          });
        }
      }
    }
    const supabaseEdges = queryEdges.filter((e) => e.source.includes('supabase-service'));
    const supabaseModels = [...new Set(supabaseEdges.map((e) => e.target))];
    expect(supabaseModels).toContain('bookings');
    expect(supabaseModels).toContain('interpreters');
    expect(supabaseModels).toContain('sessions');
    const reasons = supabaseEdges.map((e) => e.reason);
    expect(reasons.some((r) => r.includes('supabase-select'))).toBe(true);
    expect(reasons.some((r) => r.includes('supabase-insert'))).toBe(true);
  });

  it('creates CodeElement nodes for ORM models', () => {
    const codeElements: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'CodeElement' && n.properties.description?.includes('model/table')) {
        codeElements.push(n.properties.name);
      }
    });
    expect(codeElements).toContain('user');
    expect(codeElements).toContain('post');
    expect(codeElements).toContain('bookings');
    expect(codeElements).toContain('interpreters');
    expect(codeElements).toContain('sessions');
  });
});
