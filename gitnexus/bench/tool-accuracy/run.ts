import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ResolutionOutcome } from '../../src/core/ingestion/scope-resolution/resolution-outcome.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';
import { formatAccuracyMarkdown, scoreAccuracy, type KnownGapManifest } from './score.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKOUT = path.resolve(HERE, '../../..');
const args = process.argv.slice(2);
let out = path.join(HERE, 'results');
let knownGaps = path.join(HERE, 'known-gaps.json');
let check = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--check') check = true;
  else if (args[index] === '--out' && args[index + 1]) out = path.resolve(args[++index]);
  else if (args[index] === '--known-gaps' && args[index + 1])
    knownGaps = path.resolve(args[++index]);
  else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
}

const observations: Record<string, string[]> = {};
const toolOutputs: Array<{ tool: string; params: Record<string, unknown>; result: unknown }> = [];
const errors: string[] = [];
const need = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};
const integer = (value: unknown, min = 0) => Number.isInteger(value) && Number(value) >= min;

async function fixtureDigest(
  dir: string,
  relative = '',
  digest = createHash('sha256'),
): Promise<string> {
  const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await fixtureDigest(path.join(dir, entry.name), rel, digest);
    else
      digest
        .update(rel)
        .update('\0')
        .update(await fs.readFile(path.join(dir, entry.name)))
        .update('\0');
  }
  return relative ? '' : digest.digest('hex');
}

const source = {
  sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: CHECKOUT, encoding: 'utf8' }).trim(),
  dirty: !!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: CHECKOUT,
    encoding: 'utf8',
  }).trim(),
  fixtureSha: await fixtureDigest(path.join(HERE, 'fixtures')),
};
const manifest: KnownGapManifest = JSON.parse(await fs.readFile(knownGaps, 'utf8'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-tool-accuracy-'));
const scrubPaths = (value: string) => {
  for (const [internal, label] of [
    [temp, '[fixture]'],
    [CHECKOUT, '[checkout]'],
  ]) {
    value = value.replaceAll(internal, label).replaceAll(internal.replace(/\\/g, '/'), label);
  }
  return value;
};
const previousEnv = new Map(
  ['GITNEXUS_HOME', 'GITNEXUS_SHARED_STORE', 'GITNEXUS_LBUG_EXTENSION_INSTALL'].map((key) => [
    key,
    process.env[key],
  ]),
);
process.env.GITNEXUS_HOME = path.join(temp, 'home');
process.env.GITNEXUS_SHARED_STORE = 'off';
process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'never';
// The fixture fetch calls are parsed, never executed. Fail any accidental JS fetch.
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('Network fetch forbidden in tool-accuracy checks');
};
let backend: import('../../src/mcp/local/local-backend.js').LocalBackend | undefined;
let adapter: typeof import('../../src/core/lbug/lbug-adapter.js') | undefined;

try {
  const [
    { runPipelineFromRepo },
    storage,
    pool,
    { LocalBackend },
    { summarizeUnresolvedReceivers },
    { taintModelVersion },
  ] = await Promise.all([
    import('../../src/core/ingestion/pipeline.js'),
    import('../../src/storage/repo-manager.js'),
    import('../../src/core/lbug/pool-adapter.js'),
    import('../../src/mcp/local/local-backend.js'),
    import('../../src/core/ingestion/scope-resolution/unresolved-receivers.js'),
    import('../../src/core/ingestion/taint/typescript-model.js'),
  ]);
  adapter = await import('../../src/core/lbug/lbug-adapter.js');
  const repoPath = path.join(temp, 'repo');
  const storagePath = path.join(temp, 'index');
  const dbPath = path.join(storagePath, 'lbug');
  await fs.cp(path.join(HERE, 'fixtures'), repoPath, { recursive: true });
  await fs.mkdir(storagePath, { recursive: true });
  const pipeline = await runPipelineFromRepo(repoPath, () => {}, {
    pdg: true,
    workerPoolSize: 1,
    skipGraphPhases: true,
    fetchWrappers: ['fetchWithTimeout'],
  });
  need(
    pipeline.totalFileCount > 0 && pipeline.graph.nodeCount > 0,
    'Pipeline produced no fixture files or graph',
  );
  need(
    pipeline.scopeExtractionFailures.length === 0 && pipeline.unavailableScopeLanguageFiles === 0,
    'Fixture scope extraction is incomplete',
  );
  await adapter.initLbug(dbPath);
  await adapter.loadGraphToLbug(pipeline.graph, repoPath, storagePath);
  await adapter.flushWAL();
  const db = adapter.getDatabase();
  need(db, 'Native graph database missing');
  await pool.initLbugWithDb(dbPath, db!, dbPath); // Existing integration-helper lifecycle; one native DB owner.
  const baseMeta: RepoMeta = {
    repoPath,
    storagePath,
    lastCommit: source.sha,
    indexedAt: '2026-10-06T00:00:00.000Z',
    scopeExtractionReceipt: 1,
    unresolvedReceiverMembers: summarizeUnresolvedReceivers(pipeline.resolutionOutcomes),
    pdg: { maxFunctionLines: 2000, maxEdgesPerFunction: 0, taintModelVersion },
    stats: {
      files: pipeline.totalFileCount,
      nodes: pipeline.graph.nodeCount,
      edges: pipeline.graph.relationshipCount,
      communities: 0,
      processes: 0,
      embeddings: 0,
    },
  };
  await storage.saveMeta(storagePath, baseMeta);
  const repo = await storage.registerRepo(repoPath, baseMeta, {
    name: 'tool-accuracy-fixture',
    storagePath,
  });
  backend = new LocalBackend();
  need(await backend.init(), 'Backend did not discover the fixture index');

  async function call(tool: string, params: Record<string, unknown> = {}) {
    const result = await backend!.callTool(tool, { ...params, repo });
    toolOutputs.push({ tool, params, result });
    need(
      result && typeof result === 'object' && !result.error,
      `${tool} returned an error or missing output: ${JSON.stringify(result)}`,
    );
    need(
      !result.truncated && !result.partial && !result.timedOut,
      `${tool} returned incomplete output`,
    );
    return result;
  }
  async function capture(label: string, action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await capture('rename', async () => {
    const target = [...pipeline.graph.iterNodes()].find(
      (node) =>
        node.label === 'Method' &&
        node.properties.filePath === 'rename/writer.ts' &&
        node.properties.startLine === 1,
    );
    need(target, 'Writer.close symbol missing');
    const result = await call('rename', {
      symbol_uid: target!.id,
      new_name: 'closeWriter',
      dry_run: true,
    });
    need(
      result.status === 'success' && result.applied === false && Array.isArray(result.changes),
      'Malformed rename preview',
    );
    const edits: Array<{ file: string; line: number; text: string }> = [];
    for (const change of result.changes) {
      need(
        typeof change.file_path === 'string' && Array.isArray(change.edits),
        'Malformed rename file edits',
      );
      for (const edit of change.edits) {
        need(
          integer(edit.line, 1) &&
            typeof edit.old_text === 'string' &&
            typeof edit.new_text === 'string' &&
            ['graph', 'text_search'].includes(edit.confidence),
          'Malformed rename edit',
        );
        edits.push({ file: change.file_path, line: edit.line, text: edit.new_text });
      }
    }
    need(
      integer(result.total_edits) &&
        result.total_edits === edits.length &&
        result.graph_edits + result.text_search_edits === edits.length &&
        result.files_affected === result.changes.length,
      'Inconsistent rename totals',
    );
    const key = (edit: (typeof edits)[number]) => `${edit.file}:${edit.line}:${edit.text}`;
    const comment = (edit: (typeof edits)[number]) =>
      edit.file === 'rename/writer.ts' && [10, 11].includes(edit.line);
    const reference = (edit: (typeof edits)[number]) =>
      (edit.file === 'rename/writer.ts' && [2, 8].includes(edit.line)) ||
      (edit.file === 'rename/caller.ts' && edit.line === 3);
    observations['rename.references'] = edits.filter(reference).map(key);
    observations['rename.comments-strings'] = edits.filter(comment).map(key);
    observations['rename.homonyms'] = edits
      .filter((edit) => !reference(edit) && !comment(edit))
      .map(key);
  });

  await capture('routes', async () => {
    const result = await call('route_map');
    need(
      Array.isArray(result.routes) && result.total === result.routes.length,
      'Malformed route_map result',
    );
    for (const route of result.routes)
      need(
        typeof route.route === 'string' &&
          typeof route.handler === 'string' &&
          (typeof route.method === 'string' || route.method === null) &&
          Array.isArray(route.consumers),
        'Malformed route_map route',
      );
    for (const [id, url] of [
      ['routes.production-handler', '/api/info'],
      ['routes.all-method', '/api/mcp'],
      ['routes.map-lookup', '/lookup-only'],
      ['routes.helper-registration', '/api/progress'],
    ])
      observations[id] = result.routes
        .filter((route: any) => route.route === url)
        .map((route: any) => `${route.method} ${route.route} ${route.handler}`);
  });

  for (const [id, url] of [
    ['api.template-wrapper', '/api/repos'],
    ['api.literal-control', '/api/direct'],
  ]) {
    await capture(id, async () => {
      const result = await call('api_impact', { route: url, method: 'GET' });
      need(
        result.route === url &&
          Array.isArray(result.consumers) &&
          result.impactSummary?.directConsumers === result.consumers.length,
        'Malformed api_impact result',
      );
      need(
        result.consumers.every((consumer: any) => typeof consumer.file === 'string'),
        'Malformed API consumers',
      );
      observations[id] = [
        ...new Set<string>(result.consumers.map((consumer: any) => consumer.file)),
      ];
    });
  }

  await capture('explain', async () => {
    const result = await call('explain', { limit: 200 });
    need(
      Array.isArray(result.findings) &&
        integer(result.totalFindings) &&
        result.totalFindings === result.findings.length,
      'Malformed explain result',
    );
    for (const finding of result.findings) {
      need(
        typeof finding.file === 'string' &&
          finding.sinkKind !== 'unknown' &&
          Array.isArray(finding.hops) &&
          finding.hops.length > 0 &&
          !finding.pathIncomplete &&
          integer(finding.source?.line) &&
          integer(finding.sink?.line),
        'Malformed explain finding',
      );
      for (const hop of finding.hops)
        need(
          integer(hop.line) && typeof (hop.function ?? hop.variable) === 'string',
          'Malformed explain hop',
        );
    }
    const named = result.findings.filter(
      (finding: any) => finding.interprocedural && finding.source.function === 'handleUnsafe',
    );
    observations['explain.named-flow'] = named.map(
      (finding: any) =>
        `${finding.source.function} -> ${finding.sink.function} ${finding.sinkKind}`,
    );
    observations['explain.inline-flow'] = result.findings
      .filter((finding: any) => finding.interprocedural && finding.file === 'src/server/inline.ts')
      .map((finding: any) => `${finding.file} -> ${finding.sink.function} ${finding.sinkKind}`);
    observations['explain.guard'] = result.findings
      .filter(
        (finding: any) => finding.interprocedural && finding.source.function === 'handleGuarded',
      )
      .map(
        (finding: any) =>
          `${finding.source.function} -> ${finding.sink.function} ${finding.sinkKind}`,
      );
    observations['explain.cross-lines'] = named.flatMap((finding: any) => [
      `source ${finding.source.function}@${finding.source.line}`,
      `sink ${finding.sink.function}@${finding.sink.line}`,
      ...finding.hops.map((hop: any, index: number) => `hop ${index} ${hop.function}@${hop.line}`),
    ]);
    observations['explain.intra-lines'] = result.findings
      .filter(
        (finding: any) =>
          !finding.interprocedural &&
          finding.file === 'src/security.ts' &&
          finding.functionLine === 22,
      )
      .flatMap((finding: any) => [
        `function@${finding.functionLine}`,
        `source ${finding.source.variable}@${finding.source.line}`,
        `sink@${finding.sink.line}`,
        ...finding.hops.map(
          (hop: any, index: number) => `hop ${index} ${hop.variable}@${hop.line}`,
        ),
      ]);
    const constant = await call('explain', { target: 'safeConstant' });
    need(
      Array.isArray(constant.findings) && constant.totalFindings === constant.findings.length,
      'Malformed constant-control explain output',
    );
    observations['explain.constant-control'] = constant.findings.map(
      (finding: any) => finding.sinkKind,
    );
  });

  for (const [id, name, file, member] of [
    ['python.module-direct', 'direct_caller', 'pkg/user.py', 'target'],
    ['python.module-chain', 'lazy_chain', 'pkg/user.py', 'target'],
    ['python.module-local', 'lazy_local', 'pkg/user.py', 'target'],
    ['python.factory-direct', 'control', 'callers.py', 'm'],
    ['python.factory-conditional', 'conditional', 'callers.py', 'm'],
    ['python.factory-qualified', 'qualified', 'callers.py', 'm'],
    ['python.factory-boolean', 'boolean', 'callers.py', 'm'],
    ['python.nested-local-import', 'caller_local', 'nested.py', 'target'],
    ['python.nested-module-import', 'caller_module', 'nested_module.py', 'target'],
    ['python.nested-unbound', 'caller_unbound', 'nested.py', 'target'],
    ['python.local-import-control', 'caller_bound', 'local_import.py', 'target'],
    ['python.local-import-leak', 'caller_sibling', 'local_import.py', 'target'],
  ]) {
    await capture(id, async () => {
      const result = await call('context', { name, file_path: file });
      need(
        result.status === 'found' &&
          result.symbol?.filePath === file &&
          result.outgoing &&
          typeof result.outgoing === 'object' &&
          (result.outgoing.calls === undefined || Array.isArray(result.outgoing.calls)),
        'Malformed or unresolved context output',
      );
      const calls = result.outgoing.calls ?? []; // Empty categories are omitted by context's public output contract.
      for (const target of calls)
        need(
          typeof target.uid === 'string' &&
            typeof target.name === 'string' &&
            typeof target.filePath === 'string',
          'Malformed context callee',
        );
      observations[id] = calls
        .filter((target: any) => target.name === member)
        .map((target: any) => {
          const node = pipeline.graph.getNode(target.uid);
          need(node, `Tool callee does not exist in fixture graph: ${target.uid}`);
          // UID preserves the class / lexical owner that a simple display name loses.
          return target.uid.replace(/^(Function|Method):/, '').replace(/#\d+$/, '');
        });
    });
  }

  await capture('summary', async () => {
    async function epistemic(id: string, summary: RepoMeta['unresolvedReceiverMembers']) {
      await storage.saveMeta(storagePath, { ...baseMeta, unresolvedReceiverMembers: summary });
      const result = await call('impact', {
        target: 'summary_target',
        file_path: 'summary.py',
        direction: 'upstream',
        depth: 1,
      });
      need(
        ['exact', 'lower-bound'].includes(result.epistemic) &&
          integer(result.impactedCount) &&
          result.byDepth &&
          typeof result.byDepth === 'object',
        'Malformed impact output',
      );
      observations[id] = [result.epistemic];
    }
    await epistemic('summary.exact-control', undefined);
    await epistemic('summary.retained-lower-bound', {
      counts: { summary_target: 1 },
      totalSites: 1,
    });
    const outcomes: ResolutionOutcome[] = [];
    // Use the production metadata writer on 501 known dropped names; no parser,
    // tool result or summary consumer is mocked for this bounded contract case.
    for (let index = 0; index < 501; index++) {
      for (let count = 0; count < (index < 500 ? 2 : 1); count++)
        outcomes.push({
          kind: 'suppressed',
          reason: 'receiver-unresolved',
          phase: 'receiver-bound',
          filePath: 'summary.py',
          name: index < 500 ? `drop_${String(index).padStart(3, '0')}` : 'summary_target',
          candidateIds: [],
          siteKind: 'call',
          receiverOrigin: 'in-program',
          range: { startLine: index + 1, startCol: 0, endLine: index + 1, endCol: 1 },
        });
    }
    const summary = summarizeUnresolvedReceivers(outcomes);
    need(summary && typeof summary.counts === 'object', 'Missing drop-summary output');
    observations['summary.cap'] = [
      `kept=${Object.keys(summary!.counts).length} total=${summary!.totalSites} omitted=${summary!.omittedNames ?? 0} target=${Object.hasOwn(summary!.counts, 'summary_target')}`,
    ];
    await epistemic('summary.omitted-lower-bound', summary);
  });
} catch (error) {
  errors.push(
    `Fixture execution: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
} finally {
  try {
    await backend?.dispose();
    await adapter?.closeLbug();
  } catch (error) {
    errors.push(`Database cleanup failed: ${String(error)}`);
  }
  await fs.rm(temp, { recursive: true, force: true });
  globalThis.fetch = previousFetch;
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const report = scoreAccuracy(observations, manifest, source, errors.map(scrubPaths));
await fs.mkdir(out, { recursive: true });
await fs.writeFile(
  path.join(out, 'accuracy.json'),
  `${JSON.stringify({ ...report, toolOutputs }, (_key, value) => (typeof value === 'string' ? scrubPaths(value) : value), 2)}\n`,
);
await fs.writeFile(path.join(out, 'accuracy.md'), scrubPaths(formatAccuracyMarkdown(report)));
console.log(
  `Tool accuracy: ${report.summary.passed}/${report.summary.total} fixed answers pass; ${report.summary.failed} fail; regression gate ${report.gate.passed ? 'PASS' : 'FAIL'}. Reports: ${out}`,
);
for (const error of report.gate.errors) console.error(error);
if (report.gate.unexpectedFailures.length)
  console.error(`New or worsened failures: ${report.gate.unexpectedFailures.join(', ')}`);
if (report.gate.staleAllowances.length)
  console.error(`Remove repaired allowances: ${report.gate.staleAllowances.join(', ')}`);
if (report.gate.errors.length || (check && !report.gate.passed)) process.exitCode = 1;
