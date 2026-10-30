import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import { processPlSql } from '../../src/core/ingestion/plsql-processor.js';
import {
  plsqlFactsForFile,
  resetPlSqlFactsStore,
} from '../../src/core/ingestion/plsql/facts-store.js';
import {
  segmentDeadlineMs,
  SEGMENT_DEADLINE_FLOOR_MS,
} from '../../src/core/ingestion/plsql/parse.js';

const run = (files: Record<string, string>) => {
  const graph = createKnowledgeGraph();
  const result = processPlSql(
    graph,
    Object.entries(files).map(([path, content]) => ({ path, content })),
  );
  return { graph, result };
};

/** `TYPE source@line -> target@file` for every edge of `type`, sorted. */
const edges = (graph: KnowledgeGraph, type: string) => {
  const out: string[] = [];
  for (const r of graph.iterRelationships()) {
    if (r.type !== type) continue;
    const s = graph.getNode(r.sourceId)!;
    const t = graph.getNode(r.targetId)!;
    out.push(
      `${s.properties.name}@L${s.properties.startLine! + 1} -> ${t.properties.name}@${t.properties.filePath}`,
    );
  }
  return out.sort();
};

describe('processPlSql', () => {
  it('attributes calls and accesses to the overload that contains them', () => {
    const { graph } = run({
      'db/pkg_log.pkb': `CREATE OR REPLACE PACKAGE BODY pkg_log AS
  PROCEDURE log_msg(p_msg IN VARCHAR2) IS
  BEGIN
    log_msg(p_msg, 1);
  END log_msg;
  PROCEDURE log_msg(p_msg IN VARCHAR2, p_level IN NUMBER) IS
  BEGIN
    INSERT INTO t_app_log (lvl, msg) VALUES (p_level, p_msg);
  END log_msg;
END pkg_log;
/
`,
    });
    expect(edges(graph, 'ACCESSES')).toEqual(['LOG_MSG@L6 -> T_APP_LOG@db/pkg_log.pkb']);
    expect(edges(graph, 'CALLS')).toEqual(['LOG_MSG@L2 -> LOG_MSG@db/pkg_log.pkb']);
  });

  it('keeps forward-declared private subprograms private', () => {
    const { graph } = run({
      'p.pkb': `CREATE OR REPLACE PACKAGE BODY p AS
  PROCEDURE helper;
  PROCEDURE run IS BEGIN helper; END run;
  PROCEDURE helper IS BEGIN NULL; END helper;
END p;
/
`,
      'p.pks': 'CREATE OR REPLACE PACKAGE p AS\n  PROCEDURE run;\nEND p;\n/\n',
    });
    const exported: Record<string, boolean | undefined> = {};
    graph.forEachNode((n) => {
      if (n.label === 'Function') exported[n.properties.name] = n.properties.isExported;
    });
    expect(exported).toEqual({ RUN: true, HELPER: false });
    expect(edges(graph, 'CALLS')).toEqual(['RUN@L3 -> HELPER@p.pkb']);
  });

  it('keeps same-named packages in different folders apart and calls the nearest copy', () => {
    const spec =
      'CREATE OR REPLACE PACKAGE pkg_fee AS\n  FUNCTION fee RETURN NUMBER;\nEND pkg_fee;\n/\n';
    const body =
      'CREATE OR REPLACE PACKAGE BODY pkg_fee AS\n  FUNCTION fee RETURN NUMBER IS BEGIN RETURN 1; END fee;\nEND pkg_fee;\n/\n';
    const caller =
      'CREATE OR REPLACE PROCEDURE settle IS\n  x NUMBER;\nBEGIN\n  x := pkg_fee.fee();\nEND settle;\n/\n';
    const { graph } = run({
      'release/v1/pkg_fee.pks': spec,
      'release/v1/pkg_fee.pkb': body,
      'release/v1/settle.prc': caller,
      'release/v2/pkg_fee.pks': spec,
      'release/v2/pkg_fee.pkb': body,
      'release/v2/settle.prc': caller,
    });
    const modules: string[] = [];
    graph.forEachNode((n) => {
      if (n.label === 'Module') modules.push(`${n.properties.name}@${n.properties.filePath}`);
    });
    expect(modules.sort()).toEqual([
      'PKG_FEE@release/v1/pkg_fee.pks',
      'PKG_FEE@release/v2/pkg_fee.pks',
    ]);
    expect(edges(graph, 'CALLS')).toEqual([
      'SETTLE@L1 -> FEE@release/v1/pkg_fee.pkb',
      'SETTLE@L1 -> FEE@release/v2/pkg_fee.pkb',
    ]);
    for (const r of graph.iterRelationships()) {
      if (r.type === 'CALLS') expect(r.reason).toBe('plsql-call');
    }
  });

  it('does not lose PL/SQL statements when the CREATE header is split across lines', () => {
    const { graph } = run({
      'p.pkb': `CREATE OR REPLACE
PACKAGE BODY p AS
  PROCEDURE run IS
  BEGIN
    FETCH c INTO r;
    exit when r.id IS NULL;
    get(r.id);
  END run;
  PROCEDURE get(p_id NUMBER) IS BEGIN DELETE FROM t_x WHERE id = p_id; END get;
END p;
/
`,
    });
    expect(edges(graph, 'CALLS')).toEqual(['RUN@L3 -> GET@p.pkb']);
  });
});

describe('segment deadline', () => {
  it('scales with segment size above the floor', () => {
    expect(segmentDeadlineMs(10)).toBe(SEGMENT_DEADLINE_FLOOR_MS);
    expect(segmentDeadlineMs(4_000)).toBeGreaterThan(30_000);
    expect(segmentDeadlineMs(4_000, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('facts store', () => {
  it('extracts a source once per run and never serves facts for different content', () => {
    resetPlSqlFactsStore(2);
    const a = plsqlFactsForFile('a.prc', 'CREATE PROCEDURE a IS BEGIN NULL; END;\n/\n');
    expect(plsqlFactsForFile('a.prc', 'CREATE PROCEDURE a IS BEGIN NULL; END;\n/\n')).toBe(a);
    const edited = plsqlFactsForFile('a.prc', 'CREATE PROCEDURE b IS BEGIN NULL; END;\n/\n');
    expect(edited).not.toBe(a);
    expect(edited.definitions.map((d) => d.name)).toEqual(['B']);
  });
});
