import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo, findDanglingEdges } from './resolvers/helpers.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { goScopeResolver } from '../../src/core/ingestion/languages/go/scope-resolver.js';
import { populateGoWorkspaceOwners } from '../../src/core/ingestion/languages/go/method-owners.js';
import { createSemanticModel } from '../../src/core/ingestion/model/index.js';
import { reconcileOwnership } from '../../src/core/ingestion/scope-resolution/pipeline/reconcile-ownership.js';
import { buildGraphNodeLookup } from '../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { resolveDefGraphId } from '../../src/core/ingestion/scope-resolution/graph-bridge/ids.js';

it('keeps build-variant owners consistent across real workers, semantic registry and graph', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'go-build-owners-'));
  const files = new Map<string, string>();
  const expected: string[] = [];
  const add = (file: string, body: string, tag = '') => {
    files.set(file, `${tag ? `//go:build ${tag}\n\n` : ''}package example\n${body}\n`);
  };
  const own = (declaration: string, method: string, name = 'Run') => {
    expected.push(`Struct:${declaration}:Value -> Method:${method}:Value.${name}#0`);
  };
  // Same-file variants reproduce the regression; sibling declarations require
  // the workspace pass to select by the method's constraints, not file order.
  for (const platform of ['linux', 'windows']) {
    const local = `local/value_${platform}.go`;
    add(local, 'type Value struct {}\nfunc (v Value) Run() {}');
    own(local, local);
    const declaration = `sibling/value_${platform}.go`;
    const method = `sibling/method_${platform}.go`;
    add(declaration, 'type Value struct {}');
    add(method, 'func (v *Value) Run() {}');
    own(declaration, method);
  }
  for (const [file, tag] of [
    ['fast', 'fast && (cgo || debug)'],
    ['fallback', '!(fast && (cgo || debug))'],
  ]) {
    add(`tagged/${file}.go`, 'type Value struct {}', tag);
    add(`tagged/${file}_methods.go`, 'func (v Value) Run() {}', tag);
    own(`tagged/${file}.go`, `tagged/${file}_methods.go`);
  }
  for (const arch of ['amd64', 'arm64']) {
    const file = `arch/value_linux_${arch}_test.go`;
    add(file, 'type Value struct {}\nfunc (Value) Run() {}');
    own(file, file);
  }
  // Overlapping constraints still decline, including same-file provisional
  // owners. Linux files also build on Android, so those are NOT disjoint.
  for (const platform of ['linux', 'android']) {
    add(`overlap/value_${platform}.go`, 'type Value struct {}\nfunc (v Value) Run() {}');
  }
  add('duplicate/a.go', 'type Value struct {}\nfunc (v Value) Run() {}', 'fast');
  add('duplicate/b.go', 'type Value struct {}', 'fast || debug');
  // A shared method can refer to either variant: one ownerId cannot encode it.
  add('shared/value_linux.go', 'type Value struct {}');
  add('shared/value_windows.go', 'type Value struct {}');
  add('shared/method.go', 'func (v Value) Run() {}');
  // Mutually exclusive sole candidates must not produce impossible edges.
  add('incompatible/value_linux.go', 'type Value struct {}');
  add('incompatible/method_windows.go', 'func (v Value) Run() {}');
  // A bounded header scan can leave a valid method's constraints unknown.
  // That must not revive an owner whose platform constraints are impossible.
  const unknownMethod = '// license '.repeat(2000) + '\npackage example\nfunc (v Value) Run() {}\n';
  add('impossible/value_linux.go', 'type Value struct {}', 'windows');
  files.set('impossible/method.go', unknownMethod);
  add('unknown/value_linux.go', 'type Value struct {}', 'windows');
  add('unknown/value.go', 'type Value struct {}');
  files.set('unknown/method.go', unknownMethod);
  own('unknown/value.go', 'unknown/method.go');
  // Invalid modern constraints remain possible: they cannot eliminate a
  // competitor and promote a provisional same-file owner to a unique choice.
  add('malformed/local.go', 'type Value struct {}\nfunc (v Value) Run() {}', '!fast');
  add('malformed/competitor.go', 'type Value struct {}', '!!fast');
  add('malformed_space/local.go', 'type Value struct {}\nfunc (v Value) Run() {}', '!fast');
  add('malformed_space/competitor.go', 'type Value struct {}', 'fast\u00a0&& debug');
  try {
    fs.writeFileSync(path.join(repo, 'go.mod'), 'module example.com/variants\n\ngo 1.22\n');
    for (const [file, content] of files) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), content);
    }
    const result = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      workerPoolSize: 1,
      chunkByteBudget: 1,
    });
    expect(result.usedWorkerPool).toBe(true);
    expect(result.scopeExtractionFailures).toEqual([]);
    expect(findDanglingEdges(result, ['HAS_METHOD'])).toEqual([]);
    const graphOwners = [...result.graph.iterRelationshipsByType('HAS_METHOD')]
      .map((edge) => `${edge.sourceId} -> ${edge.targetId}`)
      .sort();
    expect(graphOwners).toEqual(expected.sort());

    const parsedFiles = [...files].map(([file, source]) => {
      const parsed = extractParsedFile(goScopeResolver.languageProvider, source, file);
      if (!parsed) throw new Error(`Scope extraction failed for ${file}`);
      goScopeResolver.populateOwners(parsed);
      return parsed;
    });
    // Reverse the input to ensure first/last declaration order cannot decide.
    populateGoWorkspaceOwners(parsedFiles.reverse(), { fileContents: files });
    const model = createSemanticModel();
    expect(reconcileOwnership(parsedFiles, model).methodsRegistered).toBe(expected.length);
    const defs = new Map(
      parsedFiles.flatMap((file) => file.localDefs).map((def) => [def.nodeId, def]),
    );
    const lookup = buildGraphNodeLookup(result.graph);
    const semanticOwners = [...defs.values()]
      .filter((def) => def.type === 'Method' && def.ownerId)
      .map((def) => {
        if (!def.ownerId) throw new Error(`Missing owner for ${def.nodeId}`);
        const owner = defs.get(def.ownerId);
        if (!owner) throw new Error(`Unknown owner ${def.ownerId}`);
        expect((def as { goReceiverKind?: string }).goReceiverKind).toBe(
          def.filePath.startsWith('sibling/') ? 'pointer' : 'value',
        );
        expect(model.methods.lookupAllByOwner(owner.nodeId, 'Run')).toContainEqual(def);
        return `${resolveDefGraphId(owner.filePath, owner, lookup)} -> ${resolveDefGraphId(def.filePath, def, lookup)}`;
      })
      .sort();
    expect(semanticOwners).toEqual(graphOwners);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
