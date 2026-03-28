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
} from '../../src/core/lbug/schema.js';

describe('LadybugDB Schema', () => {
  describe('NODE_TABLES', () => {
    it('includes all core node types', () => {
      const core = [
        'File',
        'Folder',
        'Function',
        'Class',
        'Interface',
        'Method',
        'CodeElement',
        'Community',
        'Process',
      ];
      for (const t of core) {
        expect(NODE_TABLES).toContain(t);
      }
    });

    it('includes multi-language node types', () => {
      const multiLang = [
        'Struct',
        'Enum',
        'Macro',
        'Typedef',
        'Union',
        'Namespace',
        'Trait',
        'Impl',
        'TypeAlias',
        'Const',
        'Static',
        'Property',
        'Record',
        'Delegate',
        'Annotation',
        'Constructor',
        'Template',
        'Module',
      ];
      for (const t of multiLang) {
        expect(NODE_TABLES).toContain(t);
      }
    });

    it('has expected total count', () => {
      // 9 core + 18 multi-language + Route + Tool = 30
      expect(NODE_TABLES).toHaveLength(30);
    });
  });

  describe('REL_TYPES', () => {
    it('includes all expected relationship types', () => {
      const expected = [
        'CONTAINS',
        'DEFINES',
        'IMPORTS',
        'CALLS',
        'EXTENDS',
        'IMPLEMENTS',
        'MEMBER_OF',
        'STEP_IN_PROCESS',
      ];
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
      // HAS_METHOD targets: Method, Constructor (Property is now HAS_PROPERTY)
      const sources = ['Class', 'Interface'];
      const backtickSources = ['Struct', 'Trait', 'Impl', 'Record'];
      const targets = ['Method'];
      const backtickTargets = ['Constructor'];

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
      expect(NODE_SCHEMA_QUERIES).toHaveLength(30);
    });

    it('REL_SCHEMA_QUERIES has one relation table', () => {
      expect(REL_SCHEMA_QUERIES).toHaveLength(1);
    });

    it('SCHEMA_QUERIES includes all node + rel + embedding schemas', () => {
      // 30 node + 1 rel + 1 embedding = 32
      expect(SCHEMA_QUERIES).toHaveLength(32);
    });

    it('node schemas come before relation schemas in SCHEMA_QUERIES', () => {
      const relIndex = SCHEMA_QUERIES.indexOf(RELATION_SCHEMA);
      const lastNodeIndex = SCHEMA_QUERIES.indexOf(
        NODE_SCHEMA_QUERIES[NODE_SCHEMA_QUERIES.length - 1],
      );
      expect(relIndex).toBeGreaterThan(lastNodeIndex);
    });
  });
});
