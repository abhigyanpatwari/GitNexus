import { beforeAll, describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import { processPlSql } from '../../src/core/ingestion/plsql-processor.js';
import {
  loadPlSqlParser,
  plsqlFactsForFile,
  resetPlSqlFactsStore,
} from '../../src/core/ingestion/plsql/facts-store.js';
import { nearestGroups } from '../../src/core/ingestion/plsql/resolve.js';
import {
  segmentDeadlineMs,
  SEGMENT_DEADLINE_FLOOR_MS,
} from '../../src/core/ingestion/plsql/parse.js';

// The parser loads lazily (the phase awaits it); tests calling the processor directly preload it.
beforeAll(loadPlSqlParser);

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

  it('binds named-argument calls only to overloads whose required parameters are supplied', () => {
    const { graph } = run({
      'p.pkb': `CREATE OR REPLACE PACKAGE BODY p AS
  PROCEDURE q(a IN NUMBER, b IN NUMBER DEFAULT 0) IS BEGIN NULL; END q;
  PROCEDURE q(b IN NUMBER) IS BEGIN NULL; END q;
  PROCEDURE r(a IN NUMBER) IS BEGIN NULL; END r;
  PROCEDURE run IS
  BEGIN
    q(b => 1);
    r(1, 2);
  END run;
END p;
/
`,
    });
    const targets: string[] = [];
    for (const rel of graph.iterRelationships()) {
      if (rel.type !== 'CALLS') continue;
      const t = graph.getNode(rel.targetId)!;
      targets.push(`${t.properties.name}@L${t.properties.startLine! + 1} ${rel.reason}`);
    }
    // q(b => 1) cannot bind q(a, b) (a is required); r(1, 2) has too many arguments.
    expect(targets).toEqual(['Q@L3 plsql-call']);
  });

  it('keeps a quoted dotted package name apart from nested names', () => {
    const { graph } = run({
      'p.pkb': `CREATE OR REPLACE PACKAGE BODY "A.B" AS
  PROCEDURE f IS BEGIN NULL; END f;
END "A.B";
/
CREATE OR REPLACE PACKAGE BODY a AS
  PROCEDURE b IS
    PROCEDURE f IS BEGIN NULL; END f;
  BEGIN
    f;
  END b;
END a;
/
`,
    });
    const calls: string[] = [];
    for (const rel of graph.iterRelationships()) {
      if (rel.type === 'CALLS') {
        const t = graph.getNode(rel.targetId)!;
        calls.push(`${t.properties.name}@L${t.properties.startLine! + 1}`);
      }
    }
    expect(calls).toEqual(['F@L7']);
  });

  it('binds `S.P` to the standalone subprogram of schema S, never one of another schema', () => {
    const { graph } = run({
      'db/procs.sql': `CREATE OR REPLACE PROCEDURE a.p IS BEGIN NULL; END p;
/
CREATE OR REPLACE PROCEDURE b.p IS BEGIN NULL; END p;
/
CREATE OR REPLACE PROCEDURE caller IS
BEGIN
  b.p;
  c.p;
END caller;
/
`,
    });
    const targets: number[] = [];
    for (const rel of graph.iterRelationships()) {
      if (rel.type === 'CALLS')
        targets.push(graph.getNode(rel.targetId)!.properties.startLine! + 1);
    }
    // b.p resolves to line 3; c.p names a schema with no indexed P and stays unresolved.
    expect(targets).toEqual([3]);
  });

  it('keeps a table over a database link apart from the local table of the same name', () => {
    const { graph } = run({
      'p.prc': `CREATE OR REPLACE PROCEDURE p IS
BEGIN
  INSERT INTO t_orders SELECT * FROM t_orders@core_link;
END p;
/
`,
    });
    const records: string[] = [];
    graph.forEachNode((n) => {
      if (n.label === 'Record') records.push(n.properties.name);
    });
    expect(records.sort()).toEqual(['T_ORDERS', 'T_ORDERS@CORE_LINK']);
  });

  it('binds to the body when the caller sits next to the spec and the body lives elsewhere', () => {
    const { graph } = run({
      'db/api/pkg_fee.pks':
        'CREATE OR REPLACE PACKAGE pkg_fee AS\n  FUNCTION fee RETURN NUMBER;\nEND pkg_fee;\n/\n',
      'db/api/settle.prc':
        'CREATE OR REPLACE PROCEDURE settle IS\n  x NUMBER;\nBEGIN\n  x := pkg_fee.fee();\nEND settle;\n/\n',
      'db/impl/pkg_fee.pkb':
        'CREATE OR REPLACE PACKAGE BODY pkg_fee AS\n  FUNCTION fee RETURN NUMBER IS BEGIN RETURN 1; END fee;\nEND pkg_fee;\n/\n',
    });
    const targets: string[] = [];
    for (const rel of graph.iterRelationships()) {
      if (rel.type === 'CALLS') targets.push(graph.getNode(rel.targetId)!.properties.filePath);
    }
    expect(targets).toEqual(['db/impl/pkg_fee.pkb']);
  });

  it('never lets the body of one package copy hide the declaration of another', () => {
    const spec =
      'CREATE OR REPLACE PACKAGE pkg_fee AS\n  FUNCTION fee RETURN NUMBER;\nEND pkg_fee;\n/\n';
    const { graph, result } = run({
      'a/pkg_fee.pks': spec,
      'a/pkg_fee.pkb':
        'CREATE OR REPLACE PACKAGE BODY pkg_fee AS\n  FUNCTION fee RETURN NUMBER IS BEGIN RETURN 1; END fee;\nEND pkg_fee;\n/\n',
      'b/pkg_fee.pks': spec,
      'settle.prc':
        'CREATE OR REPLACE PROCEDURE settle IS\n  x NUMBER;\nBEGIN\n  x := pkg_fee.fee();\nEND settle;\n/\n',
    });
    // Both copies are equally near: the body of `a` and the spec of `b` stay candidates.
    expect(edges(graph, 'CALLS')).toEqual([
      'SETTLE@L1 -> FEE@a/pkg_fee.pkb',
      'SETTLE@L1 -> FEE@b/pkg_fee.pks',
    ]);
    expect(result.ambiguousCalls).toBe(1);
  });

  it('measures a package instance by its nearest spec or body file', () => {
    const pkg = [
      { filePath: 'db/api/pkg_fee.pks', instance: 'A', isSpec: true },
      { filePath: 'db/impl/pkg_fee.pkb', instance: 'A', isSpec: false },
      { filePath: 'other/pkg_fee.pks', instance: 'B', isSpec: true },
    ];
    const nearest = nearestGroups(pkg, 'db/impl/settle.prc', (p) => p.instance);
    // The whole instance is kept, so a qualifier binds to its spec, not just the nearer body.
    expect(nearest.map((p) => p.filePath)).toEqual(['db/api/pkg_fee.pks', 'db/impl/pkg_fee.pkb']);
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

  it('keeps same-named packages of different schemas apart and honours S.A.N calls', () => {
    const { graph } = run({
      'db/schemas.pck': `CREATE OR REPLACE PACKAGE a.pkg AS PROCEDURE f; END pkg;
/
CREATE OR REPLACE PACKAGE BODY a.pkg AS PROCEDURE f IS BEGIN NULL; END f; END pkg;
/
CREATE OR REPLACE PACKAGE b.pkg AS PROCEDURE f; END pkg;
/
CREATE OR REPLACE PACKAGE BODY b.pkg AS PROCEDURE f IS BEGIN NULL; END f; END pkg;
/
CREATE OR REPLACE PROCEDURE caller IS BEGIN b.pkg.f; END caller;
/
`,
    });
    let modules = 0;
    graph.forEachNode((n) => {
      if (n.label === 'Module') modules++;
    });
    expect(modules).toBe(2);
    const targets: number[] = [];
    for (const r of graph.iterRelationships()) {
      if (r.type === 'CALLS') targets.push(graph.getNode(r.targetId)!.properties.startLine! + 1);
    }
    expect(targets).toEqual([7]); // b.pkg body, not a.pkg
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
    expect(segmentDeadlineMs(10, SEGMENT_DEADLINE_FLOOR_MS)).toBe(SEGMENT_DEADLINE_FLOOR_MS);
    expect(segmentDeadlineMs(4_000, SEGMENT_DEADLINE_FLOOR_MS)).toBeGreaterThan(30_000);
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
