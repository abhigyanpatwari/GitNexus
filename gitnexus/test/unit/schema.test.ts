import { describe, it, expect } from 'vitest';
import {
  NODE_TABLES,
  REL_TABLE_NAME,
  REL_TYPES,
  EMBEDDING_TABLE_NAME,
  NODE_SCHEMA_QUERIES,
  REL_SCHEMA_QUERIES,
  SCHEMA_QUERIES,
  FILE_SCHEMA,
  FOLDER_SCHEMA,
  FUNCTION_SCHEMA,
  CLASS_SCHEMA,
  INTERFACE_SCHEMA,
  METHOD_SCHEMA,
  CODE_ELEMENT_SCHEMA,
  COMMUNITY_SCHEMA,
  PROCESS_SCHEMA,
  RELATION_SCHEMA,
  EMBEDDING_SCHEMA,
  CREATE_VECTOR_INDEX_QUERY,
  // WI-1: Migration constants for backward compatibility
  FILE_SCHEMA_MIGRATION,
  FOLDER_SCHEMA_MIGRATION,
  FUNCTION_SCHEMA_MIGRATION,
  FUNCTION_SCHEMA_MIGRATION_2,
  CLASS_SCHEMA_MIGRATION,
  INTERFACE_SCHEMA_MIGRATION,
  METHOD_SCHEMA_MIGRATION,
  METHOD_SCHEMA_MIGRATION_2,
  CODE_ELEMENT_SCHEMA_MIGRATION,
  COMMUNITY_SCHEMA_MIGRATION,
  PROCESS_SCHEMA_MIGRATION,
  ROUTE_SCHEMA_MIGRATION,
} from '../../src/core/lbug/schema.js';
import { NodeProperties, RelationshipType } from '../../src/core/graph/types.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

describe('LadybugDB Schema', () => {
  describe('NODE_TABLES', () => {
    it('includes all core node types', () => {
      const core = ['File', 'Folder', 'Function', 'Class', 'Interface', 'Method', 'CodeElement', 'Community', 'Process'];
      for (const t of core) {
        expect(NODE_TABLES).toContain(t);
      }
    });

    it('includes multi-language node types', () => {
      const multiLang = ['Struct', 'Enum', 'Macro', 'Typedef', 'Union', 'Namespace', 'Trait', 'Impl',
        'TypeAlias', 'Const', 'Static', 'Property', 'Record', 'Delegate', 'Annotation', 'Constructor', 'Template', 'Module'];
      for (const t of multiLang) {
        expect(NODE_TABLES).toContain(t);
      }
    });

    it('has expected total count', () => {
      // 9 core + 1 Route + 18 multi-language = 28
      expect(NODE_TABLES).toHaveLength(28);
    });
  });

  describe('REL_TYPES', () => {
    it('includes all expected relationship types', () => {
      const expected = ['CONTAINS', 'DEFINES', 'IMPORTS', 'CALLS', 'EXTENDS', 'IMPLEMENTS', 'MEMBER_OF', 'STEP_IN_PROCESS'];
      for (const t of expected) {
        expect(REL_TYPES).toContain(t);
      }
    });
  });

  describe('node schema DDL', () => {
    it.each([
      ['FILE_SCHEMA', FILE_SCHEMA, 'File'],
      ['FOLDER_SCHEMA', FOLDER_SCHEMA, 'Folder'],
      ['FUNCTION_SCHEMA', FUNCTION_SCHEMA, 'Function'],
      ['CLASS_SCHEMA', CLASS_SCHEMA, 'Class'],
      ['INTERFACE_SCHEMA', INTERFACE_SCHEMA, 'Interface'],
      ['METHOD_SCHEMA', METHOD_SCHEMA, 'Method'],
      ['CODE_ELEMENT_SCHEMA', CODE_ELEMENT_SCHEMA, 'CodeElement'],
      ['COMMUNITY_SCHEMA', COMMUNITY_SCHEMA, 'Community'],
      ['PROCESS_SCHEMA', PROCESS_SCHEMA, 'Process'],
    ])('%s contains CREATE NODE TABLE for %s', (_, schema, tableName) => {
      expect(schema).toContain('CREATE NODE TABLE');
      expect(schema).toContain(tableName);
      expect(schema).toContain('PRIMARY KEY');
    });

    it('Function schema has startLine and endLine', () => {
      expect(FUNCTION_SCHEMA).toContain('startLine INT64');
      expect(FUNCTION_SCHEMA).toContain('endLine INT64');
    });

    it('Function schema has isExported', () => {
      expect(FUNCTION_SCHEMA).toContain('isExported BOOLEAN');
    });

    it('Community schema has heuristicLabel and cohesion', () => {
      expect(COMMUNITY_SCHEMA).toContain('heuristicLabel STRING');
      expect(COMMUNITY_SCHEMA).toContain('cohesion DOUBLE');
    });

    it('Process schema has processType and stepCount', () => {
      expect(PROCESS_SCHEMA).toContain('processType STRING');
      expect(PROCESS_SCHEMA).toContain('stepCount INT32');
    });
  });

  describe('relation schema', () => {
    it('creates a single REL TABLE named CodeRelation', () => {
      expect(RELATION_SCHEMA).toContain(`CREATE REL TABLE ${REL_TABLE_NAME}`);
    });

    it('has type, confidence, reason, step properties', () => {
      expect(RELATION_SCHEMA).toContain('type STRING');
      expect(RELATION_SCHEMA).toContain('confidence DOUBLE');
      expect(RELATION_SCHEMA).toContain('reason STRING');
      expect(RELATION_SCHEMA).toContain('step INT32');
    });

    it('connects Function to Function (CALLS)', () => {
      expect(RELATION_SCHEMA).toContain('FROM Function TO Function');
    });

    it('connects File to Function (CONTAINS/DEFINES)', () => {
      expect(RELATION_SCHEMA).toContain('FROM File TO Function');
    });

    it('connects symbols to Community (MEMBER_OF)', () => {
      expect(RELATION_SCHEMA).toContain('FROM Function TO Community');
      expect(RELATION_SCHEMA).toContain('FROM Class TO Community');
    });

    it('connects symbols to Process (STEP_IN_PROCESS)', () => {
      expect(RELATION_SCHEMA).toContain('FROM Function TO Process');
      expect(RELATION_SCHEMA).toContain('FROM Method TO Process');
    });

    it('has all FROM/TO pairs needed for HAS_METHOD edges', () => {
      // HAS_METHOD sources: Class, Interface, Struct, Trait, Impl, Record
      // HAS_METHOD targets: Method, Constructor, Property
      const sources = ['Class', 'Interface'];
      const backtickSources = ['Struct', 'Trait', 'Impl', 'Record'];
      const targets = ['Method'];
      const backtickTargets = ['Constructor', 'Property'];

      // Non-backtick source → non-backtick target
      for (const src of sources) {
        for (const tgt of targets) {
          expect(RELATION_SCHEMA).toContain(`FROM ${src} TO ${tgt}`);
        }
        for (const tgt of backtickTargets) {
          expect(RELATION_SCHEMA).toContain(`FROM ${src} TO \`${tgt}\``);
        }
      }

      // Backtick source → all targets
      for (const src of backtickSources) {
        for (const tgt of targets) {
          expect(RELATION_SCHEMA).toContain(`FROM \`${src}\` TO ${tgt}`);
        }
        for (const tgt of backtickTargets) {
          expect(RELATION_SCHEMA).toContain(`FROM \`${src}\` TO \`${tgt}\``);
        }
      }
    });
  });

  describe('embedding schema', () => {
    it('creates CodeEmbedding table', () => {
      expect(EMBEDDING_SCHEMA).toContain(`CREATE NODE TABLE ${EMBEDDING_TABLE_NAME}`);
      expect(EMBEDDING_SCHEMA).toContain('embedding FLOAT[384]');
    });

    it('has vector index query', () => {
      expect(CREATE_VECTOR_INDEX_QUERY).toContain('CREATE_VECTOR_INDEX');
      expect(CREATE_VECTOR_INDEX_QUERY).toContain('cosine');
    });
  });

  describe('schema query ordering', () => {
    it('NODE_SCHEMA_QUERIES has correct count', () => {
      expect(NODE_SCHEMA_QUERIES).toHaveLength(28);
    });

    it('REL_SCHEMA_QUERIES has one relation table', () => {
      expect(REL_SCHEMA_QUERIES).toHaveLength(1);
    });

    it('SCHEMA_QUERIES includes all node + rel + embedding schemas', () => {
      // 28 node + 1 rel + 1 embedding = 30
      expect(SCHEMA_QUERIES).toHaveLength(30);
    });

    it('node schemas come before relation schemas in SCHEMA_QUERIES', () => {
      const relIndex = SCHEMA_QUERIES.indexOf(RELATION_SCHEMA);
      const lastNodeIndex = SCHEMA_QUERIES.indexOf(NODE_SCHEMA_QUERIES[NODE_SCHEMA_QUERIES.length - 1]);
      expect(relIndex).toBeGreaterThan(lastNodeIndex);
    });
  });

  // ─── WI-1: Cross-Repo Schema Extensions ─────────────────────────────────────

  describe('NodeProperties type extension (WI-1)', () => {
    it('accepts repoId as optional string field', () => {
      // WI-1: NodeProperties must support repoId for cross-repo resolution
      const nodeWithRepoId: NodeProperties = {
        name: 'UserService',
        filePath: '/src/services/UserService.ts',
        repoId: 'repo-123',
      };
      expect(nodeWithRepoId.repoId).toBe('repo-123');
    });

    it('allows nodes without repoId (backward compatibility)', () => {
      // WI-1: Nodes without repoId must remain valid for single-repo scenarios
      const nodeWithoutRepoId: NodeProperties = {
        name: 'AuthService',
        filePath: '/src/services/AuthService.ts',
      };
      expect(nodeWithoutRepoId.repoId).toBeUndefined();
    });

    it('repoId is optional in type signature', () => {
      // Type-level test: TypeScript should accept both forms
      // This test verifies runtime behavior matches the type
      const minimalNode: NodeProperties = {
        name: 'MinimalService',
        filePath: '/src/MinimalService.ts',
      };
      const fullNode: NodeProperties = {
        name: 'FullService',
        filePath: '/src/FullService.ts',
        repoId: 'repo-456',
        startLine: 1,
        endLine: 100,
        language: SupportedLanguages.TypeScript,
      };
      expect(minimalNode).toBeDefined();
      expect(fullNode).toBeDefined();
    });
  });

  describe('RelationshipType extension (WI-1)', () => {
    it('includes CROSS_IMPORTS relationship type', () => {
      // WI-1: CROSS_IMPORTS is needed for cross-repo dependency tracking
      const crossImportsRel: RelationshipType = 'CROSS_IMPORTS';
      expect(crossImportsRel).toBe('CROSS_IMPORTS');
    });

    it('CROSS_IMPORTS is a valid RelationshipType value', () => {
      // WI-1: Type-level validation that CROSS_IMPORTS is in the union type
      // This will fail at compile time if CROSS_IMPORTS is not in the type
      const allTypes: RelationshipType[] = [
        'CONTAINS',
        'CALLS',
        'INHERITS',
        'OVERRIDES',
        'IMPORTS',
        'USES',
        'DEFINES',
        'DECORATES',
        'IMPLEMENTS',
        'EXTENDS',
        'HAS_METHOD',
        'MEMBER_OF',
        'STEP_IN_PROCESS',
        'CROSS_IMPORTS', // WI-1: This must be valid
      ];
      expect(allTypes).toContain('CROSS_IMPORTS');
    });
  });

  describe('Node schema DDL for cross-repo (WI-1)', () => {
    // WI-1: All node tables must include repoId column for cross-repo resolution

    it('FILE_SCHEMA includes repoId column', () => {
      expect(FILE_SCHEMA).toContain('repoId STRING');
    });

    it('FOLDER_SCHEMA includes repoId column', () => {
      expect(FOLDER_SCHEMA).toContain('repoId STRING');
    });

    it('FUNCTION_SCHEMA includes repoId column', () => {
      expect(FUNCTION_SCHEMA).toContain('repoId STRING');
    });

    it('CLASS_SCHEMA includes repoId column', () => {
      expect(CLASS_SCHEMA).toContain('repoId STRING');
    });

    it('INTERFACE_SCHEMA includes repoId column', () => {
      expect(INTERFACE_SCHEMA).toContain('repoId STRING');
    });

    it('METHOD_SCHEMA includes repoId column', () => {
      expect(METHOD_SCHEMA).toContain('repoId STRING');
    });

    it('CODE_ELEMENT_SCHEMA includes repoId column', () => {
      expect(CODE_ELEMENT_SCHEMA).toContain('repoId STRING');
    });

    it('COMMUNITY_SCHEMA includes repoId column', () => {
      expect(COMMUNITY_SCHEMA).toContain('repoId STRING');
    });

    it('PROCESS_SCHEMA includes repoId column', () => {
      expect(PROCESS_SCHEMA).toContain('repoId STRING');
    });

    it('uses ADD COLUMN-free ALTER for Kùzu (WI-160 runner is the idempotency guard)', () => {
      // WI-1 originally asserted the migrations used `IF NOT EXISTS` for
      // backward compatibility. Kùzu's ALTER TABLE does NOT support that
      // clause (it throws "Invalid input <ADD COLUMN>: expected rule
      // iC_AlterOptions" at parse time). WI-160 moves idempotency to the
      // migration runner in lbug-adapter.doInitLbug, which suppresses the
      // "already has property" error Kùzu throws on a re-ADD.
      // This test pins the Kùzu-compatible syntax so a future refactor
      // doesn't reintroduce `IF NOT EXISTS` (or `ADD COLUMN`) into the
      // migration strings and brick the DB open.
      const migrationWithAlter = [
        FILE_SCHEMA_MIGRATION,
        FOLDER_SCHEMA_MIGRATION,
        FUNCTION_SCHEMA_MIGRATION,
      ].find(migration => migration.includes('ALTER TABLE') && migration.includes('ADD '));

      expect(migrationWithAlter).toBeDefined();

      // None of the migration constants should use the invalid `ADD COLUMN
      // IF NOT EXISTS` pattern — both clauses are unsupported by Kùzu.
      for (const migration of [
        FILE_SCHEMA_MIGRATION,
        FOLDER_SCHEMA_MIGRATION,
        FUNCTION_SCHEMA_MIGRATION,
        FUNCTION_SCHEMA_MIGRATION_2,
        CLASS_SCHEMA_MIGRATION,
        INTERFACE_SCHEMA_MIGRATION,
        METHOD_SCHEMA_MIGRATION,
        METHOD_SCHEMA_MIGRATION_2,
        CODE_ELEMENT_SCHEMA_MIGRATION,
        COMMUNITY_SCHEMA_MIGRATION,
        PROCESS_SCHEMA_MIGRATION,
        ROUTE_SCHEMA_MIGRATION,
      ]) {
        expect(migration).not.toContain('ADD COLUMN');
        expect(migration).not.toContain('IF NOT EXISTS');
      }
    });
  });

  describe('REL_TYPES extension (WI-1)', () => {
    it('includes CROSS_IMPORTS in REL_TYPES array', () => {
      // WI-1: REL_TYPES must include CROSS_IMPORTS for edge creation
      expect(REL_TYPES).toContain('CROSS_IMPORTS');
    });
  });
});
