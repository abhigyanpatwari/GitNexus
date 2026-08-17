import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import type { GraphNode, RelationshipType } from "gitnexus-shared";
import { runPipelineFromRepo } from "../../src/core/ingestion/pipeline.js";
import { runFullAnalysis } from "../../src/core/run-analyze.js";
import { LocalBackend } from "../../src/mcp/local/local-backend.js";
import type { PipelineResult } from "../../src/types/pipeline.js";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/objective-c",
);

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

const HEADER = readFixture("SYModuleCaller.h");
const IMPL = readFixture("SYModuleCaller.m");
const PLAIN_C_HEADER = readFixture("SYModuleSupport.h");

const HEADER_V2 = HEADER.replace(
  "- (void)runTask:(NSString *)name completion:(void (^)(BOOL ok))completion;\n@end",
  "- (void)runTask:(NSString *)name completion:(void (^)(BOOL ok))completion;\n- (void)cancelTask;\n@end",
).replace(
  "- (void)traceEvent:(NSString *)name;\n@end",
  "- (void)traceEvent:(NSString *)name;\n- (void)traceDetail:(NSString *)name level:(NSInteger)level;\n@end",
);

const IMPL_V2 = IMPL.replace(
  "[self traceEvent:name];",
  "[self traceEvent:name];\n  [self traceDetail:name level:1];",
).replace(
  "@implementation SYModuleCaller (Tracing)\n- (void)traceEvent:(NSString *)name {}\n@end",
  "@implementation SYModuleCaller (Tracing)\n- (void)traceEvent:(NSString *)name {}\n- (void)traceDetail:(NSString *)name level:(NSInteger)level {}\n@end",
);

function git(repoRoot: string, command: string): void {
  execSync(command, { cwd: repoRoot, stdio: "pipe" });
}

function gitCommitAll(repoRoot: string, message: string): void {
  git(
    repoRoot,
    "git -c user.name=test -c user.email=t@t -c commit.gpgsign=false add -A",
  );
  git(
    repoRoot,
    `git -c user.name=test -c user.email=t@t -c commit.gpgsign=false commit -q -m "${message}"`,
  );
}

function writeObjectiveCRepo(
  repoRoot: string,
  header = HEADER,
  impl = IMPL,
): void {
  fs.writeFileSync(path.join(repoRoot, "SYModuleCaller.h"), header);
  fs.writeFileSync(path.join(repoRoot, "SYModuleCaller.m"), impl);
  fs.writeFileSync(path.join(repoRoot, "SYModuleSupport.h"), PLAIN_C_HEADER);
}

function normalizeRows(rows: unknown): unknown[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const record = row as Record<string, unknown>;
      return {
        uid: record.uid ?? record.id,
        name: record.name,
        filePath: record.filePath,
        kind: record.kind,
      };
    })
    .sort((left, right) =>
      `${left.uid ?? ""}:${left.name ?? ""}:${left.filePath ?? ""}`.localeCompare(
        `${right.uid ?? ""}:${right.name ?? ""}:${right.filePath ?? ""}`,
      ),
    );
}

function normalizeBuckets(value: unknown): Record<string, unknown[]> {
  const record = (value ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, normalizeRows(record[key])]),
  );
}

function normalizeContext(value: unknown): Record<string, unknown> {
  const record = value as Record<string, unknown>;
  const symbol = (record.symbol ?? {}) as Record<string, unknown>;
  return {
    status: record.status,
    symbol: {
      uid: symbol.uid,
      name: symbol.name,
      kind: symbol.kind,
      filePath: symbol.filePath,
    },
    incoming: normalizeBuckets(record.incoming),
    outgoing: normalizeBuckets(record.outgoing),
  };
}

async function readPersistedObjectiveCSurface(
  repoRoot: string,
): Promise<Record<string, unknown>> {
  const backend = new LocalBackend();
  try {
    const classContext = await backend.callTool("context", {
      name: "SYModuleCaller",
      file_path: "SYModuleCaller.h",
      repo: repoRoot,
    });
    const runTaskContext = await backend.callTool("context", {
      uid: "Method:objc:method:objc:class:SYModuleCaller:-:runTask:completion:",
      repo: repoRoot,
    });
    const queryResult = (await backend.callTool("query", {
      search_query: "SYModuleCaller",
      repo: repoRoot,
      limit: 5,
      include_content: false,
    })) as Record<string, unknown>;
    const protocolAndCategoryResult = await backend.callTool("cypher", {
      query:
        "MATCH (n) WHERE labels(n) IN ['Protocol', 'Category'] " +
        "RETURN n.id AS id, labels(n)[0] AS kind ORDER BY kind, id",
      repo: repoRoot,
    });
    const categoryHostResult = await backend.callTool("cypher", {
      query:
        "MATCH (category:Category)-[r:CodeRelation]->(host:Class) " +
        "WHERE r.type = 'MEMBER_OF' " +
        "RETURN category.id AS category, host.id AS host",
      repo: repoRoot,
    });
    return {
      classContext: normalizeContext(classContext),
      runTaskContext: normalizeContext(runTaskContext),
      queryDefinitions: normalizeRows(queryResult.definitions),
      protocolAndCategoryResult,
      categoryHostResult,
    };
  } finally {
    await backend.disconnect();
  }
}

async function analyzeObjectiveCRepo(
  repoRoot: string,
  options: { force?: boolean } = {},
): Promise<string[]> {
  const logs: string[] = [];
  await runFullAnalysis(
    repoRoot,
    {
      force: options.force,
      skipAgentsMd: true,
      skipSkills: true,
      workerPoolSize: 1,
    },
    {
      onProgress: () => undefined,
      onLog: (message) => logs.push(message),
    },
  );
  return logs;
}

describe("Objective-C provider integration", () => {
  let repoRoot: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "gitnexus-objc-provider-"),
    );
    fs.writeFileSync(path.join(repoRoot, "SYModuleCaller.h"), HEADER);
    fs.writeFileSync(path.join(repoRoot, "SYModuleCaller.m"), IMPL);
    fs.writeFileSync(path.join(repoRoot, "SYModuleSupport.h"), PLAIN_C_HEADER);
    result = await runPipelineFromRepo(repoRoot, () => undefined, {
      workerPoolSize: 1,
    });
  }, 60000);

  afterAll(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  function nodeByQualifiedName(qualifiedName: string): GraphNode | undefined {
    return result.graph.nodes.find(
      (node) => node.properties.qualifiedName === qualifiedName,
    );
  }

  function expectNode(
    qualifiedName: string,
    label: GraphNode["label"],
  ): GraphNode {
    const node = nodeByQualifiedName(qualifiedName);
    expect(node, qualifiedName).toBeDefined();
    expect(node?.label).toBe(label);
    return node!;
  }

  function hasRelationship(
    type: RelationshipType,
    sourceId: string,
    targetId: string,
    reason?: string | RegExp,
  ): boolean {
    return result.graph.relationships.some((rel) => {
      if (
        rel.type !== type ||
        rel.sourceId !== sourceId ||
        rel.targetId !== targetId
      )
        return false;
      if (reason === undefined) return true;
      return typeof reason === "string"
        ? rel.reason === reason
        : reason.test(rel.reason);
    });
  }

  it("indexes Objective-C semantic nodes beyond File nodes", () => {
    expectNode("objc:protocol:SYModuleRunnable", "Protocol");
    expectNode("objc:class:SYBaseCaller", "Class");
    expectNode("objc:class:SYModuleCaller", "Class");
    expectNode("objc:category:SYModuleCaller:Tracing", "Category");
    expectNode(
      "objc:method:objc:class:SYModuleCaller:-:runTask:completion:",
      "Method",
    );
    expectNode(
      "objc:method:objc:class:SYModuleCaller:+:sharedCaller",
      "Method",
    );
    expectNode(
      "objc:method:objc:category:SYModuleCaller:Tracing:-:traceEvent:",
      "Method",
    );
    expectNode("objc:property:objc:class:SYModuleCaller:helper", "Property");
    expectNode("objc:ivar:objc:class:SYModuleCaller:_base", "Variable");
    expectNode("objc:function:SYModuleSupportAdd", "Function");
    expectNode("objc:function:SYModuleCompute", "Function");
  });

  it("emits imports, inheritance, protocol, and category host relationships", () => {
    const caller = expectNode("objc:class:SYModuleCaller", "Class");
    const base = expectNode("objc:class:SYBaseCaller", "Class");
    const protocol = expectNode("objc:protocol:SYModuleRunnable", "Protocol");
    const category = expectNode(
      "objc:category:SYModuleCaller:Tracing",
      "Category",
    );

    expect(hasRelationship("EXTENDS", caller.id, base.id)).toBe(true);
    expect(hasRelationship("IMPLEMENTS", caller.id, protocol.id)).toBe(true);
    expect(hasRelationship("MEMBER_OF", category.id, caller.id)).toBe(true);

    const importNodes = result.graph.nodes.filter(
      (node) => node.label === "Import",
    );
    expect(importNodes.map((node) => node.properties.targetRaw)).toEqual(
      expect.arrayContaining([
        "SYModuleCaller.h",
        "SYModuleSupport.h",
        "Foundation",
      ]),
    );

    const mFile = result.graph.nodes.find(
      (node) =>
        node.label === "File" &&
        node.properties.filePath === "SYModuleCaller.m",
    );
    const hFile = result.graph.nodes.find(
      (node) =>
        node.label === "File" &&
        node.properties.filePath === "SYModuleCaller.h",
    );
    expect(mFile).toBeDefined();
    expect(hFile).toBeDefined();
    expect(hasRelationship("IMPORTS", mFile!.id, hFile!.id)).toBe(true);
  });

  it("records implementation evidence for merged declarations", () => {
    const caller = expectNode("objc:class:SYModuleCaller", "Class");
    const runTask = expectNode(
      "objc:method:objc:class:SYModuleCaller:-:runTask:completion:",
      "Method",
    );

    const implementationEvidence = result.graph.nodes.filter(
      (node) =>
        node.label === "CodeElement" &&
        node.properties.objectiveCKind === "implementation-evidence" &&
        node.properties.filePath === "SYModuleCaller.m",
    );
    expect(
      implementationEvidence.map((node) => node.properties.targetQualifiedName),
    ).toEqual(
      expect.arrayContaining([
        "objc:class:SYModuleCaller",
        "objc:method:objc:class:SYModuleCaller:-:runTask:completion:",
      ]),
    );
    expect(
      implementationEvidence.some((node) =>
        hasRelationship(
          "DECLARES",
          node.id,
          caller.id,
          "objc: implementation of merged symbol",
        ),
      ),
    ).toBe(true);
    expect(
      implementationEvidence.some((node) =>
        hasRelationship(
          "DECLARES",
          node.id,
          runTask.id,
          "objc: implementation of merged symbol",
        ),
      ),
    ).toBe(true);
  });

  it("emits conservative Objective-C message-send call edges and unresolved evidence", () => {
    const runTask = expectNode(
      "objc:method:objc:class:SYModuleCaller:-:runTask:completion:",
      "Method",
    );
    const loadData = expectNode(
      "objc:method:objc:class:SYBaseCaller:-:loadData:completion:",
      "Method",
    );
    const traceEvent = expectNode(
      "objc:method:objc:category:SYModuleCaller:Tracing:-:traceEvent:",
      "Method",
    );
    const runProtocol = expectNode(
      "objc:method:objc:class:SYModuleCaller:-:runProtocol:",
      "Method",
    );
    const protocolRun = expectNode(
      "objc:method:objc:protocol:SYModuleRunnable:-:runTask:completion:",
      "Method",
    );

    expect(
      hasRelationship(
        "CALLS",
        runTask.id,
        loadData.id,
        /objc-message: (super|local) receiver/,
      ),
    ).toBe(true);
    expect(
      hasRelationship(
        "CALLS",
        runTask.id,
        loadData.id,
        "objc-message: self receiver",
      ),
    ).toBe(true);
    expect(
      hasRelationship(
        "CALLS",
        runTask.id,
        traceEvent.id,
        "objc-message: self receiver",
      ),
    ).toBe(true);
    expect(
      hasRelationship(
        "CALLS",
        runProtocol.id,
        protocolRun.id,
        "objc-message: protocol receiver",
      ),
    ).toBe(true);

    const unresolved = result.graph.nodes.find(
      (node) =>
        node.label === "CodeElement" &&
        node.properties.objectiveCKind === "unresolved-message" &&
        node.properties.receiver === "dynamic",
    );
    expect(unresolved).toBeDefined();
    expect(
      hasRelationship("CALLS", runTask.id, unresolved!.id),
      "dynamic id receiver must not become a certain CALLS edge",
    ).toBe(false);

    const macroUnresolved = result.graph.nodes.find(
      (node) =>
        node.label === "CodeElement" &&
        node.properties.objectiveCKind === "unresolved-message" &&
        node.properties.receiver === "SY_OBJC_RECEIVER(self)",
    );
    expect(macroUnresolved?.properties.reason).toBe(
      "macro receiver SY_OBJC_RECEIVER is dynamic",
    );

    const candidates = result.graph.nodes.find(
      (node) =>
        node.label === "CodeElement" &&
        node.properties.objectiveCKind === "protocol-candidate-implementations",
    );
    expect(candidates?.properties.candidateImplementations).toEqual(
      expect.arrayContaining([
        "objc:method:objc:class:SYModuleCaller:-:runTask:completion:",
      ]),
    );
  });
});

describe("Objective-C provider persisted index behavior", () => {
  it("surfaces query/context semantics and keeps incremental results aligned with force rebuild", async () => {
    const repoRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "gitnexus-objc-provider-index-"),
    );
    try {
      writeObjectiveCRepo(repoRoot);
      git(repoRoot, "git init");
      gitCommitAll(repoRoot, "initial Objective-C fixture");

      await analyzeObjectiveCRepo(repoRoot);
      const initialSurface = await readPersistedObjectiveCSurface(repoRoot);
      expect(initialSurface).toMatchObject({
        classContext: {
          status: "found",
          symbol: {
            uid: "Class:objc:class:SYModuleCaller",
            kind: "Class",
            filePath: "SYModuleCaller.h",
          },
          incoming: {
            declares: expect.arrayContaining([
              expect.objectContaining({
                uid: expect.stringContaining(
                  "CodeElement:objc:implementation:objc:class:SYModuleCaller:SYModuleCaller.m:",
                ),
                filePath: "SYModuleCaller.m",
              }),
            ]),
            imports: expect.arrayContaining([
              expect.objectContaining({
                uid: "File:SYModuleCaller.m",
                filePath: "SYModuleCaller.m",
              }),
            ]),
          },
        },
        queryDefinitions: expect.arrayContaining([
          expect.objectContaining({ uid: "Class:objc:class:SYModuleCaller" }),
          expect.objectContaining({
            uid: expect.stringMatching(
              /^Method:objc:method:objc:class:SYModuleCaller:/,
            ),
          }),
        ]),
        protocolAndCategoryResult: expect.objectContaining({
          markdown: expect.stringContaining(
            "Protocol:objc:protocol:SYModuleRunnable",
          ),
        }),
        categoryHostResult: expect.objectContaining({
          markdown: expect.stringContaining(
            "Category:objc:category:SYModuleCaller:Tracing",
          ),
        }),
      });

      writeObjectiveCRepo(repoRoot, HEADER_V2, IMPL_V2);
      gitCommitAll(
        repoRoot,
        "change Objective-C declarations and implementations",
      );
      const incrementalLogs = await analyzeObjectiveCRepo(repoRoot);
      expect(incrementalLogs).toContainEqual(
        expect.stringContaining("Incremental: changed="),
      );
      const incrementalSurface = await readPersistedObjectiveCSurface(repoRoot);

      await analyzeObjectiveCRepo(repoRoot, { force: true });
      const forceSurface = await readPersistedObjectiveCSurface(repoRoot);
      expect(incrementalSurface).toEqual(forceSurface);
      expect(forceSurface).toMatchObject({
        classContext: {
          outgoing: {
            has_method: expect.arrayContaining([
              expect.objectContaining({
                uid: "Method:objc:method:objc:category:SYModuleCaller:Tracing:-:traceDetail:level:",
              }),
            ]),
          },
        },
        runTaskContext: {
          outgoing: {
            calls: expect.arrayContaining([
              expect.objectContaining({
                uid: "Method:objc:method:objc:category:SYModuleCaller:Tracing:-:traceDetail:level:",
              }),
            ]),
          },
        },
      });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  }, 180000);
});
