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
  PROPERTY_SCHEMA,
  CODE_ELEMENT_SCHEMA,
  COMMUNITY_SCHEMA,
  PROCESS_SCHEMA,
  BASICBLOCK_SCHEMA,
  RELATION_SCHEMA,
  EMBEDDING_SCHEMA,
  CREATE_VECTOR_INDEX_QUERY,
} from '../../src/core/lbug/schema.js';
import { parseRelationSchemaPairs } from '../../src/core/lbug/rel-pair-routing.js';

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
        'Variable',
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

    it('includes the BasicBlock taint/PDG substrate node (issue #2080)', () => {
      expect(NODE_TABLES).toContain('BasicBlock');
    });

    it('has expected total count', () => {
      // 9 core + 21 multi-language + Route + Tool + Destination + BasicBlock = 35
      expect(NODE_TABLES).toHaveLength(35);
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

    it('includes the taint/PDG substrate edge types (issue #2080)', () => {
      for (const t of ['CFG', 'REACHING_DEF', 'TAINTED', 'SANITIZES', 'TAINT_PATH']) {
        expect(REL_TYPES).toContain(t);
      }
    });

    it('includes the control-dependence edge types (issue #2085 M5)', () => {
      for (const t of ['CDG', 'POST_DOMINATE']) {
        expect(REL_TYPES).toContain(t);
      }
    });

    it('includes the DI collection-injection edge type (#2200)', () => {
      expect(REL_TYPES).toContain('INJECTS');
    });

    it('includes Spring condition and auto-configuration edge types (#2415)', () => {
      expect(REL_TYPES).toContain('CONDITIONAL_ON');
      expect(REL_TYPES).toContain('DECLARES');
      expect(REL_TYPES).toContain('ADVISED_BY');
      expect(REL_TYPES).not.toContain('AUTO_REGISTERS');
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

    it('Property schema preserves declaredType', () => {
      expect(SCHEMA_QUERIES).toContain(PROPERTY_SCHEMA);
      expect(PROPERTY_SCHEMA).toContain('declaredType STRING');
    });

    it('BasicBlock schema is wired into SCHEMA_QUERIES (issue #2080, F1 guard)', () => {
      // Defining BASICBLOCK_SCHEMA is not enough — it must be appended to
      // NODE_SCHEMA_QUERIES (→ SCHEMA_QUERIES) or initLbug never creates the
      // table and the bulk-COPY round-trip fails with "table does not exist".
      expect(SCHEMA_QUERIES).toContain(BASICBLOCK_SCHEMA);
      expect(BASICBLOCK_SCHEMA).toContain('CREATE NODE TABLE BasicBlock');
      expect(BASICBLOCK_SCHEMA).toContain('filePath STRING');
      expect(BASICBLOCK_SCHEMA).toContain('startLine INT64');
      expect(BASICBLOCK_SCHEMA).toContain('endLine INT64');
      expect(BASICBLOCK_SCHEMA).toContain('text STRING');
      expect(BASICBLOCK_SCHEMA).toContain('PRIMARY KEY (id)');
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

    // These four go through `parseRelationSchemaPairs`, not a raw substring:
    // each of their pairs is now emitted by a cross product rather than
    // hand-written, and the generated half backticks EVERY label
    // (`FROM \`Function\` TO \`Function\``) while the hand-written half
    // backticks only multi-language names. Asserting the runtime's own parse
    // keeps them about the pair being declared, which is what LadybugDB
    // enforces — a cosmetic DDL formatting change cannot fail them.
    it('connects Function to Function (CALLS)', () => {
      expect(parseRelationSchemaPairs(RELATION_SCHEMA).has('Function|Function')).toBe(true);
    });

    it('connects File to Function (CONTAINS/DEFINES)', () => {
      expect(parseRelationSchemaPairs(RELATION_SCHEMA).has('File|Function')).toBe(true);
    });

    it('connects symbols to Community (MEMBER_OF)', () => {
      const declaredPairs = parseRelationSchemaPairs(RELATION_SCHEMA);
      expect(declaredPairs.has('Function|Community')).toBe(true);
      expect(declaredPairs.has('Class|Community')).toBe(true);
    });

    it('connects symbols to Process (STEP_IN_PROCESS)', () => {
      const declaredPairs = parseRelationSchemaPairs(RELATION_SCHEMA);
      expect(declaredPairs.has('Function|Process')).toBe(true);
      expect(declaredPairs.has('Method|Process')).toBe(true);
    });

    it('connects BasicBlock to BasicBlock (taint/PDG substrate edges, #2080)', () => {
      expect(RELATION_SCHEMA).toContain('FROM BasicBlock TO BasicBlock');
    });

    it('persists class-like framework edges to synthetic declarations (#2416)', () => {
      expect(RELATION_SCHEMA).toContain('FROM Class TO CodeElement');
      expect(RELATION_SCHEMA).toContain('FROM Interface TO CodeElement');
    });

    it('declares the Swift enum/property member-containment pairs (#2769)', () => {
      // Asserted through the runtime's own parser, not raw strings, so a
      // cosmetic DDL formatting change cannot fail this without a semantic
      // change (see PR #2769 review Finding 7). The Rust impl/trait and JS/TS
      // object-literal pairs get their own tests below — narrower and named
      // for the specific abort each one fixes.
      const declaredPairs = parseRelationSchemaPairs(RELATION_SCHEMA);
      const memberPairs = [
        // Swift enum members (also reached by Java/PHP enum methods)
        'Enum|Function',
        'Enum|Method',
        'Enum|Struct',
        'Enum|Constructor',
        'Enum|Property',
        'Enum|TypeAlias',
        'Property|Class',
        'Property|Enum',
        'Property|Function',
        'Property|Struct',
        'Method|Variable',
        'Method|Const',
        // #2801 moves this pair from structural DDL into the generated bridge.
        'Record|Property',
      ];

      for (const pair of memberPairs) {
        expect(declaredPairs.has(pair)).toBe(true);
      }
    });

    it('has all FROM/TO pairs needed for HAS_METHOD edges', () => {
      // HAS_METHOD sources: Class, Interface, Struct, Trait, Impl, Record
      // HAS_METHOD targets: Method, Constructor (Property is now HAS_PROPERTY)
      const declaredPairs = parseRelationSchemaPairs(RELATION_SCHEMA);
      const sources = ['Class', 'Interface'];
      const backtickSources = ['Struct', 'Trait', 'Impl', 'Record'];
      const targets = ['Method'];
      const backtickTargets = ['Constructor'];

      for (const src of [...sources, ...backtickSources]) {
        for (const tgt of [...targets, ...backtickTargets]) {
          expect(declaredPairs.has(`${src}|${tgt}`)).toBe(true);
        }
      }
    });

    it('has FROM/TO pairs for HAS_METHOD edges whose member is minted as Function, not Method (#2769)', () => {
      // A Rust `impl`/`trait` method is minted as a `Function` node, not
      // `Method` (tree-sitter-queries.ts), so `Impl|Method`/`Trait|Method`
      // never fire for it — this was the reproduced abort on any Rust repo
      // with an `impl` or `trait` block (PR #2769 review Finding 1).
      const declaredPairs = parseRelationSchemaPairs(RELATION_SCHEMA);
      for (const pair of ['Trait|Function', 'Impl|Function']) {
        expect(declaredPairs.has(pair)).toBe(true);
      }
    });

    it('has FROM/TO pairs for HAS_METHOD edges owned by a JS/TS object-literal binding (#2769)', () => {
      // A `const x = { m() {} }` / `var x = { m() {} }` owner is labelled
      // verbatim `Const`/`Variable` (ast-helpers.ts), and its shorthand
      // method is a `Method` node — this was the second reproduced abort,
      // hit on ordinary TS/JS code including GitNexus's own source tree
      // (PR #2769 review Finding 1).
      const declaredPairs = parseRelationSchemaPairs(RELATION_SCHEMA);
      for (const pair of ['Const|Method', 'Variable|Method']) {
        expect(declaredPairs.has(pair)).toBe(true);
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
      // 33 + Protocol + Category = 35
      expect(NODE_SCHEMA_QUERIES).toHaveLength(35);
    });

    it('REL_SCHEMA_QUERIES has one relation table', () => {
      expect(REL_SCHEMA_QUERIES).toHaveLength(1);
    });

    it('SCHEMA_QUERIES includes all node + rel + embedding schemas', () => {
      // 35 node + 1 rel + 1 embedding = 37
      expect(SCHEMA_QUERIES).toHaveLength(37);
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
