import { describe, expect, it } from 'vitest';
import { NODE_TABLES, REL_TYPES } from 'gitnexus-shared';

// ---------------------------------------------------------------------------
// Recreate the security guards locally so we can test the exact logic used in
// production without exporting private helpers.
//
// Source locations:
//   validLabel / validRelType  -- gitnexus-web/src/core/llm/tools.ts
//   isSafeId                   -- gitnexus-web/src/components/ProcessesPanel.tsx
//   readOnly guard (regex)     -- gitnexus-web/src/core/lbug/lbug-adapter.ts
// ---------------------------------------------------------------------------

const validLabel = (label: string): boolean => (NODE_TABLES as readonly string[]).includes(label);

const validRelType = (t: string): boolean => (REL_TYPES as readonly string[]).includes(t);

const isSafeId = (id: string): boolean => /^[a-zA-Z0-9_:.\-/@]+$/.test(id);

const isWriteQuery = (cypher: string): boolean => {
  const stripped = cypher.replace(/'[^']*'|"[^"]*"/g, '').toUpperCase();
  return /\b(CREATE|DELETE|SET|MERGE|REMOVE|DROP|DETACH)\b/.test(stripped);
};

// ===========================================================================
// validLabel
// ===========================================================================
describe('validLabel – NODE_TABLES membership', () => {
  it.each(['Function', 'Class', 'File', 'Process', 'Community'])(
    'accepts known label "%s"',
    (label) => {
      expect(validLabel(label)).toBe(true);
    },
  );

  it.each([
    'Struct',
    'Enum',
    'Trait',
    'Impl',
    'Macro',
    'Typedef',
    'Union',
    'Namespace',
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
  ])('accepts multi-language label "%s"', (label) => {
    expect(validLabel(label)).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['SQL keyword', 'DROP'],
    ['random word', 'foo'],
    ['Cypher injection', '})-[:R]->(x)'],
    ['label with semicolon', 'Function;DELETE'],
    ['lowercase (case matters)', 'function'],
    ['lowercase class', 'class'],
    ['whitespace padded', ' File '],
    ['numeric', '123'],
  ])('rejects invalid label: %s', (_desc, label) => {
    expect(validLabel(label)).toBe(false);
  });

  it('NODE_TABLES contains all expected core labels', () => {
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
    for (const label of core) {
      expect((NODE_TABLES as readonly string[]).includes(label)).toBe(true);
    }
  });
});

// ===========================================================================
// validRelType
// ===========================================================================
describe('validRelType – REL_TYPES membership', () => {
  it.each([...REL_TYPES])('accepts known relation type "%s"', (relType) => {
    expect(validRelType(relType)).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['SQL keyword', 'DROP'],
    ['injection attempt', 'CALLS;DELETE'],
    ['lowercase', 'calls'],
    ['nonexistent type', 'FRIEND_OF'],
    ['padded', ' CALLS '],
  ])('rejects invalid relation type: %s', (_desc, relType) => {
    expect(validRelType(relType)).toBe(false);
  });

  it('REL_TYPES has at least the base types', () => {
    // Guard against accidental removal of relation types
    expect(REL_TYPES.length).toBeGreaterThanOrEqual(8);
  });
});

// ===========================================================================
// isSafeId
// ===========================================================================
describe('isSafeId – identifier allowlist regex', () => {
  it.each([
    ['namespaced id', 'Function:myFunc'],
    ['underscore id', 'proc_5'],
    ['class id', 'Class:MyClass'],
    ['dotted name', 'Module:path.to.thing'],
    ['with hyphen', 'File:my-file.ts'],
    ['community id', 'comm_5'],
    ['file path id', 'File:src/index.ts'],
    ['nested path id', 'Function:src/utils/helpers.ts:doStuff'],
    ['scoped npm package', 'Module:@scope/pkg'],
    ['angular-style id', 'Module:@angular/core'],
  ])('accepts valid ID: %s', (_desc, id) => {
    expect(isSafeId(id)).toBe(true);
  });

  it.each([['with spaces', 'Process:my process']])(
    'rejects ID with unsafe chars: %s',
    (_desc, id) => {
      expect(isSafeId(id)).toBe(false);
    },
  );

  it('rejects empty string', () => {
    expect(isSafeId('')).toBe(false);
  });

  it.each([
    ['SQL injection', "'; DROP TABLE"],
    ['command substitution', '$(command)'],
    ['XSS attempt', '<script>'],
    ['JSON injection', '{id: "x"}'],
  ])('rejects injection attempt: %s', (_desc, id) => {
    expect(isSafeId(id)).toBe(false);
  });

  it.each([
    ['open paren', '('],
    ['close paren', ')'],
    ['open bracket', '['],
    ['close bracket', ']'],
    ['open brace', '{'],
    ['close brace', '}'],
    ['backtick', '`'],
    ['double quote', '"'],
    ['single quote', "'"],
  ])('rejects Cypher metacharacter: %s', (_desc, ch) => {
    expect(isSafeId(ch)).toBe(false);
  });

  it.each([
    ['embedded paren', 'func(x)'],
    ['embedded bracket', 'arr[0]'],
    ['embedded brace', '{key}'],
    ['embedded backtick', 'id`inject'],
  ])('rejects id containing metacharacter: %s', (_desc, id) => {
    expect(isSafeId(id)).toBe(false);
  });
});

// ===========================================================================
// readOnly guard – write-operation regex
// ===========================================================================
describe('readOnly guard – write-operation detection', () => {
  describe('allows read-only queries (should NOT match)', () => {
    it.each([
      ['simple match', 'MATCH (n) RETURN n'],
      ['filtered match', 'MATCH (n:Function) WHERE n.name = "test" RETURN n'],
      ['with relationship', 'MATCH (a)-[r:CodeRelation]->(b) RETURN a, r, b'],
      ['with count', 'MATCH (n) RETURN count(n)'],
      ['with ordering', 'MATCH (n) RETURN n ORDER BY n.name LIMIT 10'],
      ['call procedure', 'CALL db.schema.nodeTypeProperties()'],
    ])('%s', (_desc, cypher) => {
      expect(isWriteQuery(cypher)).toBe(false);
    });
  });

  describe('blocks write operations (should match)', () => {
    it.each([
      ['DELETE node', 'MATCH (n) DELETE n'],
      ['CREATE node', 'CREATE (n:Test)'],
      ['SET property', 'MATCH (n) SET n.x = 1'],
      ['MERGE node', 'MERGE (n:Test {id: "1"})'],
      ['REMOVE property', 'MATCH (n) REMOVE n.x'],
      ['DETACH DELETE', 'MATCH (n) DETACH DELETE n'],
      ['DROP (DDL)', 'DROP TABLE x'],
    ])('%s', (_desc, cypher) => {
      expect(isWriteQuery(cypher)).toBe(true);
    });
  });

  describe('handles tricky cases', () => {
    it('detects write keyword even when embedded in longer query', () => {
      const cypher = 'MATCH (n:Function) WHERE n.name = "handler" DELETE n';
      expect(isWriteQuery(cypher)).toBe(true);
    });

    it('detects mixed-case write keywords via toUpperCase()', () => {
      expect(isWriteQuery('match (n) delete n')).toBe(true);
      expect(isWriteQuery('Match (n) Set n.x = 1')).toBe(true);
    });

    // Keywords inside quoted strings are stripped before checking,
    // so they don't trigger false positives.
    it('allows "delete" inside a quoted string value', () => {
      expect(isWriteQuery('MATCH (n) WHERE n.name CONTAINS "delete" RETURN n')).toBe(false);
    });

    it('allows "CREATE" inside single-quoted string', () => {
      expect(isWriteQuery("MATCH (n) WHERE n.name = 'CREATE_USER' RETURN n")).toBe(false);
    });

    it('still blocks DELETE outside quotes', () => {
      expect(isWriteQuery('MATCH (n) WHERE n.name = "foo" DELETE n')).toBe(true);
    });

    // Verify the word-boundary prevents false positives on substrings that
    // are NOT Cypher write keywords.
    it('does not match partial keywords like "CREATED" or "SETTING"', () => {
      expect(isWriteQuery('MATCH (n) WHERE n.status = "CREATED" RETURN n')).toBe(false);
      expect(isWriteQuery('MATCH (n) WHERE n.label = "SETTING" RETURN n')).toBe(false);
    });

    it('does not flag the word "create" inside a property name like "createdAt"', () => {
      expect(isWriteQuery('MATCH (n) RETURN n.createdAt')).toBe(false);
    });
  });
});
