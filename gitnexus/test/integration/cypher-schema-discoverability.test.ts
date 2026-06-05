/**
 * Integration Test: Issue #110 — Schema discoverability for agents
 *
 * Regression test for #110: agents must not guess non-existent properties
 * (e.g. `fqn`, `PROPERTIES()`) and must have a discoverable schema source.
 *
 * The fix adds:
 *   1. A top-level static MCP resource `gitnexus://schema` (no repo context).
 *   2. The cypher tool description references this resource and lists the
 *      canonical node labels + relationship types.
 *   3. The schema content includes Route node properties, COMPOSITION
 *      (added in Batch H), and the other edge types that the static
 *      description was missing.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  getResourceDefinitions,
  getResourceTemplates,
  readResource,
} from '../../src/mcp/resources.js';
import { GITNEXUS_TOOLS } from '../../src/mcp/tools.js';

// Minimal mock backend — schema resource is static so only repos is invoked.
function createMockBackend(): any {
  return {
    listRepos: vi.fn().mockResolvedValue([]),
    resolveRepo: vi.fn(),
    getContext: vi.fn(),
    queryClusters: vi.fn(),
    queryProcesses: vi.fn(),
    queryClusterDetail: vi.fn(),
    queryProcessDetail: vi.fn(),
  };
}

describe('cypher-schema-discoverability (#110)', () => {
  describe('top-level gitnexus://schema resource', () => {
    it('exposes gitnexus://schema as a static resource definition', () => {
      const defs = getResourceDefinitions();
      const schema = defs.find(d => d.uri === 'gitnexus://schema');
      expect(schema).toBeDefined();
      expect(schema!.mimeType).toBe('text/yaml');
      expect(schema!.description).toMatch(/cypher|schema/i);
    });

    it('readResource("gitnexus://schema", ...) returns the schema content', async () => {
      const backend = createMockBackend();
      const result = await readResource('gitnexus://schema', backend);
      expect(result).toContain('GitNexus Graph Schema');
    });
  });

  describe('schema content covers all node labels', () => {
    let content: string;

    // Read once — schema is static.
    it('contains the standard node labels', async () => {
      const backend = createMockBackend();
      content = await readResource('gitnexus://schema', backend);

      // Required node labels.
      const requiredNodes = [
        'File', 'Folder', 'Function', 'Class', 'Interface', 'Method',
        'CodeElement', 'Route', 'Community', 'Process',
      ];
      for (const label of requiredNodes) {
        // Match `label:` in the nodes: list. Multi-language labels
        // are wrapped in backticks — we check the canonical ones.
        const regex = new RegExp(`-\\s+${label}\\s*:`, 'i');
        expect(regex.test(content), `schema should list node: ${label}`).toBe(true);
      }
    });

    it('lists the multi-language node types (Struct, Enum, Trait, Impl)', async () => {
      const backend = createMockBackend();
      content = await readResource('gitnexus://schema', backend);
      for (const label of ['Struct', 'Enum', 'Trait', 'Impl', 'Macro', 'Namespace']) {
        expect(content).toContain(label);
      }
    });
  });

  describe('schema content covers all relationship types', () => {
    let content: string;

    it('lists the core relationship types', async () => {
      const backend = createMockBackend();
      content = await readResource('gitnexus://schema', backend);

      const required = [
        'CONTAINS', 'DEFINES', 'CALLS', 'IMPORTS', 'EXTENDS', 'COMPOSITION',
        'IMPLEMENTS', 'HAS_METHOD', 'HAS_PROPERTY', 'ACCESSES', 'OVERRIDES',
        'MEMBER_OF', 'STEP_IN_PROCESS',
      ];
      for (const rel of required) {
        expect(content).toContain(`${rel}:`);
      }
    });

    it('lists the additional relationship types used by ingesters', async () => {
      const backend = createMockBackend();
      content = await readResource('gitnexus://schema', backend);
      for (const rel of [
        'CROSS_IMPORTS', 'HANDLES_ROUTE', 'FETCHES', 'HANDLES_TOOL',
        'ENTRY_POINT_OF', 'WRAPS', 'QUERIES',
      ]) {
        expect(content).toContain(`${rel}:`);
      }
    });

    it('includes COMPOSITION (added in Batch H)', async () => {
      const backend = createMockBackend();
      content = await readResource('gitnexus://schema', backend);
      // COMPOSITION is the new rel type from Batch H — make sure it's
      // documented so agents can query anonymous-field composition edges.
      // The relationships list is indented (e.g. `  - COMPOSITION: ...`).
      expect(content).toMatch(/-\s+COMPOSITION\s*:/);
    });
  });

  describe('Route node properties are documented', () => {
    it('documents httpMethod, routePath, controllerClass, handlerMethod', async () => {
      const backend = createMockBackend();
      const content = await readResource('gitnexus://schema', backend);

      // The issue's failing query used these names. They must appear
      // in the schema content so agents know they're queryable.
      expect(content).toContain('httpMethod');
      expect(content).toContain('routePath');
      expect(content).toContain('controllerClass');
      expect(content).toContain('handlerMethod');
    });

    it('notes the legacy controllerName / methodName aliases', async () => {
      const backend = createMockBackend();
      const content = await readResource('gitnexus://schema', backend);
      // Backwards-compat aliases must be mentioned to prevent agents
      // from assuming the names are wrong.
      expect(content).toContain('controllerName');
      expect(content).toContain('methodName');
      expect(content).toMatch(/alias/i);
    });
  });

  describe('cypher tool description points at the schema resource', () => {
    it('mentions the canonical node labels', () => {
      const cypher = GITNEXUS_TOOLS.find(t => t.name === 'cypher');
      expect(cypher).toBeDefined();
      const desc = cypher!.description;
      for (const label of ['Function', 'Class', 'Interface', 'Method', 'Route']) {
        expect(desc).toContain(label);
      }
    });

    it('mentions COMPOSITION, HANDLES_ROUTE, FETCHES, HAS_PROPERTY', () => {
      const cypher = GITNEXUS_TOOLS.find(t => t.name === 'cypher');
      const desc = cypher!.description;
      for (const rel of ['COMPOSITION', 'HANDLES_ROUTE', 'FETCHES', 'HAS_PROPERTY']) {
        expect(desc).toContain(rel);
      }
    });

    it('directs agents to the gitnexus://schema resource', () => {
      const cypher = GITNEXUS_TOOLS.find(t => t.name === 'cypher');
      expect(cypher!.description).toMatch(/gitnexus:\/\/schema/);
    });
  });

  describe('per-repo schema template still works', () => {
    it('readResource("gitnexus://repo/any/schema", ...) still returns schema', async () => {
      const backend = createMockBackend();
      const result = await readResource('gitnexus://repo/any/schema', backend);
      expect(result).toContain('GitNexus Graph Schema');
    });

    it('schema is still listed in the per-repo templates', () => {
      const templates = getResourceTemplates();
      const schema = templates.find(t => t.uriTemplate === 'gitnexus://repo/{name}/schema');
      expect(schema).toBeDefined();
    });
  });
});
