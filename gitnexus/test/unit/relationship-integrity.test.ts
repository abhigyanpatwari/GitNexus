import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Parser from 'tree-sitter';
import { createHash } from 'node:crypto';
import TypeScript from 'tree-sitter-typescript';
import type { GraphRelationship } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import {
  createRelationshipIntegrityCollector,
  relationshipIntegrityForCaller,
} from '../../src/core/graph/relationship-integrity.js';
import { GraphEmitSink } from '../../src/core/lbug/graph-emit-sink.js';
import { referenceEdgeKey } from '../../src/core/ingestion/scope-resolution/graph-bridge/edges.js';
import { _captureLogger, type LoggerCapture } from '../../src/core/logger.js';

const sourceId = 'Function:sample.ts:caller';
const targetId = 'Method:sample.ts:Service.ping';
let root: string;
let logs: LoggerCapture;
beforeEach(() => {
  logs = _captureLogger('debug');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-integrity-'));
  fs.writeFileSync(
    path.join(root, 'sample.ts'),
    'function caller(service) {\n  service.ping(); service.ping();\n}\n',
  );
});
afterEach(() => {
  logs.restore();
  fs.rmSync(root, { recursive: true, force: true });
});

function edge(startCol = 2, endCol = 16, kind = 'call', target = targetId): GraphRelationship {
  const type = kind === 'call' ? 'CALLS' : 'ACCESSES';
  return {
    id: `rel:${referenceEdgeKey(type, sourceId, target, { kind, atRange: { startLine: 2, startCol, endLine: 2, endCol } })}`,
    sourceId,
    targetId: target,
    type,
    confidence: 0.85,
    reason: 'resolved',
  };
}

describe.each(['memory', 'streaming'] as const)('ingestion relationship integrity: %s', (mode) => {
  function fixture(
    referenceSourceText?: (filePath: string, text: string) => string | null | undefined,
  ) {
    const collector = createRelationshipIntegrityCollector(
      root,
      (id) => graph.getNode(id),
      referenceSourceText,
    );
    const graph = createKnowledgeGraph(collector.inspect);
    collector.recordSourceHash(
      'sample.ts',
      createHash('sha256')
        .update(fs.readFileSync(path.join(root, 'sample.ts'), 'utf8'))
        .digest('hex'),
    );
    for (const id of [sourceId, targetId, `${targetId}Other`]) {
      graph.addNode({
        id,
        label: 'Function',
        properties: { name: id, filePath: 'sample.ts', startLine: 0, endLine: 2 },
      });
    }
    const sink =
      mode === 'streaming' ? new GraphEmitSink(graph, path.join(root, 'csv')) : undefined;
    sink?.beginStreaming();
    return { collector, writer: sink ?? graph, close: () => sink?.finalize() };
  }

  it('stores an identical site once and preserves different columns and complete spans', () => {
    const { collector, writer, close } = fixture();
    try {
      writer.addRelationship(edge());
      writer.addRelationship({ ...edge(), confidence: 0.9, reason: 'additional evidence' });
      writer.addRelationship(edge(18, 32));
      writer.addRelationship(edge(2, 32)); // same start, different AST span
      expect(writer.relationshipCount).toBe(3);
      expect(writer.iterRelationships().next().value?.confidence).toBe(0.85);
      expect(collector.snapshot()).toEqual({
        version: 1,
        checkedSites: 3,
        unverifiedEdges: 0,
        duplicatesSuppressed: 1,
      });
    } finally {
      close();
    }
  });

  it.each(['truncate', 'lengthen', 'rename', 'delete'] as const)(
    'does not validate a parsed span against a later source %s',
    (change) => {
      const { collector, writer, close } = fixture();
      const file = path.join(root, 'sample.ts');
      const changes = {
        truncate: () => fs.writeFileSync(file, ''),
        lengthen: () => fs.appendFileSync(file, '// newer source\n'),
        rename: () => fs.renameSync(file, `${file}.old`),
        delete: () => fs.unlinkSync(file),
      };
      changes[change]();
      try {
        writer.addRelationship(edge());
        expect(collector.snapshot()).toMatchObject({ checkedSites: 0, unverifiedEdges: 1 });
        expect(logs.records()[0]).toMatchObject({
          event: 'graph_reference_unverified',
          reason:
            change === 'delete' || change === 'rename' ? 'sourceUnavailable' : 'sourceChanged',
        });
        expect(() => writer.addRelationship({ ...edge(), targetId: 'wrong' })).toThrow(
          /contradicts an existing record/,
        );
      } finally {
        close();
      }
    },
  );

  it('rejects sources outside the repository before attempting to read them', () => {
    const { collector, writer, close } = fixture();
    writer.getNode(sourceId)!.properties.filePath = '../outside.ts';
    try {
      expect(() => writer.addRelationship(edge())).toThrow(/outside the indexed repository/);
      expect(() => collector.snapshot()).toThrow(/outside the indexed repository/);
    } finally {
      close();
    }
  });

  it('preserves dispatch targets and read/write distinctions at the same location', () => {
    const { writer, close } = fixture();
    try {
      writer.addRelationship(edge());
      writer.addRelationship(edge(2, 16, 'call', `${targetId}Other`));
      writer.addRelationship(edge(2, 16, 'read'));
      writer.addRelationship(edge(2, 16, 'write'));
      expect(writer.relationshipCount).toBe(4);
    } finally {
      close();
    }
  });

  it.each(['readX2', 'writeX2', 'reader2', 'writer2'])(
    'rejects malformed access kind %s before recording it',
    (kind) => {
      const { writer, collector, close } = fixture();
      try {
        writer.addRelationship(edge(2, 16, 'read'));
        const invalid = {
          ...edge(2, 16, 'read'),
          id: `rel:ACCESSES:${sourceId}->${targetId}:${kind}:2:2:16`,
        };
        expect(() => writer.addRelationship(invalid)).toThrow(/read\/write kind/);
        expect(writer.relationshipCount).toBe(1);
        expect(() => collector.snapshot()).toThrow(/read\/write kind/);
      } finally {
        close();
      }
    },
  );

  it.each(['\u00e9()', '"\ud83d\ude00"; \u00e9()'])(
    'uses parser column units for non-ASCII source %s',
    (source) => {
      fs.writeFileSync(path.join(root, 'sample.ts'), `\n${source}`);
      const parser = new Parser();
      parser.setLanguage(TypeScript.typescript);
      const call = parser.parse(`\n${source}`).rootNode.lastNamedChild!.firstNamedChild!;
      expect(call.type).toBe('call_expression');
      expect(call.endPosition.column).toBe(source.length);
      const { writer, collector, close } = fixture();
      try {
        writer.addRelationship(edge(call.startPosition.column, call.endPosition.column));
        expect(collector.snapshot()).toMatchObject({ checkedSites: 1, unverifiedEdges: 0 });
        expect(() => writer.addRelationship(edge(0, source.length + 1))).toThrow(/outside/);
        expect(writer.relationshipCount).toBe(1);
        expect(() => collector.snapshot()).toThrow(/outside/);
      } finally {
        close();
      }
    },
  );

  it('summarizes counts and bounds debug examples instead of logging every unknown edge', () => {
    const { writer, collector, close } = fixture();
    try {
      for (let i = 0; i < 100; i++) writer.addRelationship({ ...edge(), id: `opaque-${i}` });
      writer.addRelationship({ ...edge(), id: 'opaque-0' });
      collector.logSummary();
      const records = logs.records();
      expect(records.filter((r) => r.event === 'graph_reference_unverified')).toHaveLength(1);
      expect(records.find((r) => r.event === 'graph_reference_integrity')).toMatchObject({
        level: 30,
        repoPath: root,
        status: 'unverified',
        checkedSites: 0,
        unverifiedEdges: 100,
        duplicatesSuppressed: 1,
        unverifiedByReason: { opaqueIdentity: 100 },
      });
    } finally {
      close();
    }
  });

  it('logs one actionable rejection with the emitting stack and no success summary', () => {
    const { writer, collector, close } = fixture();
    try {
      expect(() => writer.addRelationship(edge(2, 999))).toThrow(/outside/);
      expect(() => writer.addRelationship(edge())).toThrow(/outside/);
      expect(() => collector.logSummary()).toThrow(/outside/);
      expect(logs.records()).toHaveLength(1);
      expect(logs.records()[0]).toMatchObject({
        level: 50,
        event: 'graph_reference_rejected',
        sourceId,
        targetId,
        sourceFile: 'sample.ts',
        emissionReason: 'resolved',
        reason: expect.stringContaining('outside'),
        err: { stack: expect.stringContaining('relationship-integrity') },
      });
    } finally {
      close();
    }
  });

  it('checks extracted buffers without certifying original-file coordinates', () => {
    const { writer, collector, close } = fixture(() => '\n  service.ping();');
    try {
      writer.addRelationship(edge());
      expect(collector.snapshot()).toMatchObject({ checkedSites: 0, unverifiedEdges: 1 });
      // This span fits the original file, but not the actual reference buffer.
      expect(() => writer.addRelationship(edge(18, 32))).toThrow(/outside/);
      expect(writer.relationshipCount).toBe(1);
    } finally {
      close();
    }
  });

  it('does not certify a span whose rows and columns have only been partly mapped', () => {
    const { writer, collector, close } = fixture(() => null);
    try {
      writer.addRelationship(edge(18, 2));
      expect(collector.snapshot()).toMatchObject({ checkedSites: 0, unverifiedEdges: 1 });
      expect(relationshipIntegrityForCaller(collector.snapshot()).status).toBe('unverified');
    } finally {
      close();
    }
  });

  it('rejects reversed mapped lines and latches the failure', () => {
    const { writer, collector, close } = fixture(() => null);
    try {
      const invalid = { ...edge(), id: `rel:CALLS:${sourceId}->${targetId}:3:2:2:16` };
      expect(() => writer.addRelationship(invalid)).toThrow(/invalid source coordinate ordering/);
      expect(writer.relationshipCount).toBe(0);
      expect(() => collector.snapshot()).toThrow(/invalid source coordinate ordering/);
    } finally {
      close();
    }
  });

  it('escapes controls in rejection messages while preserving structured diagnostic fields', () => {
    const { writer, collector, close } = fixture();
    try {
      const unsafeSource = 'Function:unsafe\n\x1b[31m\u202e.ts:caller';
      const id = `rel:CALLS:${unsafeSource}->${targetId}:2:2:2:16`;
      const invalid = { ...edge(), id, sourceId: unsafeSource };
      let message = '';
      try {
        writer.addRelationship(invalid);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('unsafe\\u000a\\u001b[31m\\u202e.ts');
      expect(message).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
      expect(writer.relationshipCount).toBe(0);
      expect(() => collector.snapshot()).toThrow(message);
      expect(logs.records()[0]).toMatchObject({ relationshipId: id, sourceId: unsafeSource });
    } finally {
      close();
    }
  });

  it.each([
    ':0:2:2:16',
    ':2:-1:2:16',
    ':2:2:1:16',
    ':2:16:2:2',
    ':2:2:99:16',
    ':2:2:2:999',
    ':2:NaN:2:16',
    ':2:2.5:2:16',
    ':2:2:2:undefined',
    ':02:2:2:16',
  ])('rejects invalid span %s before recording it', (span) => {
    const { writer, collector, close } = fixture();
    try {
      expect(() =>
        writer.addRelationship({ ...edge(), id: `rel:CALLS:${sourceId}->${targetId}${span}` }),
      ).toThrow(/Invalid graph reference.*source=.*target=/);
      expect(writer.relationshipCount).toBe(0);
      expect(() => collector.snapshot()).toThrow(/Invalid graph reference/);
    } finally {
      close();
    }
  });

  it('rejects identity/endpoint contradictions', () => {
    const { writer, close } = fixture();
    try {
      expect(() => writer.addRelationship({ ...edge(), targetId: `${targetId}Other` })).toThrow(
        /contradicts/,
      );
      expect(writer.relationshipCount).toBe(0);
    } finally {
      close();
    }
  });

  it('latches conflicting opaque identities even when the emitter catches the rejection', () => {
    const { writer, collector, close } = fixture();
    try {
      writer.addRelationship({ ...edge(), id: 'opaque-site' });
      expect(() =>
        writer.addRelationship({ ...edge(), id: 'opaque-site', targetId: `${targetId}Other` }),
      ).toThrow(/contradicts/);
      expect(writer.relationshipCount).toBe(1);
      expect(() => collector.snapshot()).toThrow(/contradicts/);
    } finally {
      close();
    }
  });

  it('does not compact unrelated opaque identities that happen to end with the same target', () => {
    const { writer, collector, close } = fixture();
    try {
      writer.addRelationship({ ...edge(), id: `legacy-first:${targetId}:2:2` });
      writer.addRelationship({ ...edge(), id: `legacy-second:${targetId}:2:2` });
      expect(writer.relationshipCount).toBe(2);
      expect(collector.snapshot()).toMatchObject({ unverifiedEdges: 2, duplicatesSuppressed: 0 });
    } finally {
      close();
    }
  });

  it('rejects a source-backed edge to a missing target', () => {
    const { writer, close } = fixture();
    try {
      expect(() => writer.addRelationship(edge(2, 16, 'call', 'Method:sample.ts:missing'))).toThrow(
        /node is missing/,
      );
      expect(writer.relationshipCount).toBe(0);
    } finally {
      close();
    }
  });

  it('leaves pair-only, point-only and legacy identities unverified', () => {
    const { collector, writer, close } = fixture();
    try {
      for (const id of [
        `rel:CALLS:${sourceId}->${targetId}`,
        `rel:CALLS:${sourceId}->${targetId}:2:2`,
        'legacy-id',
      ]) {
        writer.addRelationship({ ...edge(), id });
      }
      expect(collector.snapshot()).toMatchObject({ checkedSites: 0, unverifiedEdges: 3 });
      expect(relationshipIntegrityForCaller(collector.snapshot()).status).toBe('unverified');
    } finally {
      close();
    }
  });
});

describe('caller integrity signal', () => {
  it.each([
    undefined,
    null,
    {},
    { version: 1 },
    { version: 2, checkedSites: 2, unverifiedEdges: 0, duplicatesSuppressed: 0 },
    { version: 1, checkedSites: -1, unverifiedEdges: 0, duplicatesSuppressed: 0 },
  ])('does not certify missing or invalid receipt %j', (receipt) => {
    expect(relationshipIntegrityForCaller(receipt)).toMatchObject({ status: 'unverified' });
  });
  it('reports verified scope without claiming resolution accuracy', () => {
    expect(
      relationshipIntegrityForCaller({
        version: 1,
        checkedSites: 2,
        unverifiedEdges: 0,
        duplicatesSuppressed: 1,
      }),
    ).toMatchObject({
      status: 'verified',
      checkedSites: 2,
      duplicatesSuppressed: 1,
      note: expect.stringContaining('not resolution accuracy'),
    });
  });
});
