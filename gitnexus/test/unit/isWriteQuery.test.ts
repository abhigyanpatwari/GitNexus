// ...existing code...
import { describe, it, expect } from 'vitest';
import { isWriteQuery as isWriteQueryAdapter } from '../../src/mcp/core/lbug-adapter';
import { isWriteQuery as isWriteQueryBackend } from '../../src/mcp/local/local-backend';

describe('isWriteQuery regex tests', () => {
  const writeQueries = [
    'CREATE (n:Test {name: "x"})',
    'MATCH (n) SET n.x = 1',
    'MERGE (n:Foo {id: 1})',
    'DELETE n',
    'DROP INDEX ON :Foo(prop)',
    'ALTER TABLE Something',
    'COPY TO something',
    'DETACH DELETE n',
  ];

  const readQueries = [
    'MATCH (n:CreateHelpers) RETURN n',
    'MATCH (a)-[:CALLS]->(b) RETURN a, b',
    'MATCH (f:File)-[r:DEFINES]->(n) RETURN n',
    "MATCH (n) WHERE n.name = 'MERGEHelper' RETURN n", // word present as data
    'MATCH (n) RETURN n',
    'MATCH (n) WHERE n.content CONTAINS ":CREATE" RETURN n',
    'MATCH (n:SomethingWithSET) RETURN n',
  ];

  it('adapter isWriteQuery should detect real write queries', () => {
    for (const q of writeQueries) {
      expect(isWriteQueryAdapter(q), `adapter should detect write for: ${q}`).toBe(true);
    }
  });

  it('adapter isWriteQuery should not false-positive on label/rel or data', () => {
    for (const q of readQueries) {
      expect(isWriteQueryAdapter(q), `adapter false-positive on: ${q}`).toBe(false);
    }
  });

  it('backend isWriteQuery should detect real write queries', () => {
    for (const q of writeQueries) {
      expect(isWriteQueryBackend(q), `backend should detect write for: ${q}`).toBe(true);
    }
  });

  it('backend isWriteQuery should not false-positive on label/rel or data', () => {
    for (const q of readQueries) {
      expect(isWriteQueryBackend(q), `backend false-positive on: ${q}`).toBe(false);
    }
  });
});

