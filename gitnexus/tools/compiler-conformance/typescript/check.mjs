import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runPipelineFromRepo } from '../../../dist/core/ingestion/pipeline.js';
import { lookupNameClaim } from '../../../dist/core/ingestion/scope-resolution/scope/walkers.js';
import { resolveDefGraphId } from '../../../dist/core/ingestion/scope-resolution/graph-bridge/ids.js';
import { buildGraphNodeLookup } from '../../../dist/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { compareReports } from '../compare.mjs';
import { graphDeclaration } from '../gitnexus-report.mjs';
import { compilerReport, emptyReport, graphRelations, relations } from './compiler-report.mjs';

export function publishedMethodOwners(graph) {
  const owners = new Map();
  for (const edge of graph.iterRelationshipsByType('HAS_METHOD')) {
    const owner = graph.getNode(edge.sourceId);
    assert.ok(owner, 'Unpublished method owner: ' + edge.sourceId);
    assert.ok(!owners.has(edge.targetId), 'Multiple HAS_METHOD edges for ' + edge.targetId);
    owners.set(edge.targetId, owner);
  }
  return owners;
}

function graphReport(
  graph,
  boundCalls,
  inventory,
  methodFacts,
  propertyAccess,
  parameterCalls,
  classes,
  methodReturns,
  constructedTargets,
) {
  // Class nodes carry a line. The real graph bridge joins their IDs to the
  // exact scope declarations, including two local classes on that same line.
  const classPositions = new Map();
  const result = emptyReport();
  result.publishedCalls = [];
  const lookup = buildGraphNodeLookup(graph);
  for (const def of classes) {
    const id = resolveDefGraphId(def.filePath, def, lookup);
    if (!id || !def.declarationRange) continue;
    const { startLine, startCol } = def.declarationRange;
    const position = def.filePath + '#' + startLine + ':' + startCol;
    const previous = classPositions.get(id);
    assert.ok(!previous || previous === position, id + ' merges ' + previous + ' and ' + position);
    classPositions.set(id, position);
    if (def.typeParameters?.length) {
      result.CLASS_TYPE_PARAMETERS.edges.push({
        from: position,
        to: JSON.stringify(
          def.typeParameters.map(({ name, bound, defaultType }) => [
            name,
            bound ?? null,
            defaultType ?? null,
          ]),
        ),
      });
    }
  }
  function graphIdentity(node) {
    if (node.label === 'Class') {
      const position = classPositions.get(node.id);
      assert.ok(position, 'No scope declaration for published class ' + node.id);
      return position;
    }
    if (['Interface', 'TypeAlias', 'Enum'].includes(node.label)) {
      const { filePath, startLine, name } = node.properties;
      return filePath + '#' + (startLine + 1) + ':' + name;
    }
    return graphDeclaration(node);
  }
  const owners = publishedMethodOwners(graph);
  function callableIdentity(node) {
    const owner = owners.get(node.id);
    if (node.label === 'Method' && ['Interface', 'Const', 'Variable'].includes(owner?.label))
      return graphDeclaration(node);
    return node.label === 'Method' && owner
      ? JSON.stringify([
          graphIdentity(owner),
          node.properties.isStatic === true,
          node.properties.name,
        ])
      : graphIdentity(node);
  }
  result.PARAMETER_CALLS.sites = publishedParameterCalls(graph, parameterCalls);
  const parameterRanges = new Set(parameterCalls.map(siteKey));
  if (propertyAccess) {
    for (const edge of graph.iterRelationshipsByType('ACCESSES')) {
      const caller = graph.getNode(edge.sourceId);
      const field = graph.getNode(edge.targetId);
      assert.ok(caller && field, 'Unpublished property access: ' + edge.id);
      const kind = edge.reason?.split(': ').at(-1);
      assert.ok(kind === 'read' || kind === 'write', 'Unknown property access: ' + edge.id);
      const report = result[kind === 'read' ? 'PROPERTY_READS' : 'PROPERTY_WRITES'];
      const target = graphIdentity(field);
      report.edges.push({ from: callableIdentity(caller), to: target });
      const prefix = 'rel:ACCESSES:' + edge.sourceId + '->' + edge.targetId + ':';
      const span =
        edge.id.startsWith(prefix) &&
        /^(?:read|write):(\d+:\d+):(\d+:\d+)$/.exec(edge.id.slice(prefix.length));
      assert.ok(span, 'Missing property access span: ' + edge.id);
      report.sites.push({
        file: caller.properties.filePath,
        start: span[1],
        end: span[2],
        status: 'resolved',
        target,
      });
    }
  }
  if (methodFacts) {
    for (const node of graph.nodes) {
      if (node.label !== 'Method') continue;
      const { isAbstract, isStatic, parameterTypes } = node.properties;
      result.METHOD_FACTS.edges.push({
        from: callableIdentity(node),
        to: JSON.stringify([
          isAbstract,
          isStatic,
          parameterTypes ?? [],
          ...(isAbstract ? [methodReturns.get(graphDeclaration(node)) ?? null] : []),
        ]),
      });
    }
  }
  if (inventory) {
    for (const node of graph.nodes) {
      if (!['Class', 'Interface', 'Method', 'Function'].includes(node.label)) continue;
      result.DECLARATIONS.edges.push({
        from: node.properties.filePath,
        to: node.label + ':' + node.properties.name + '@' + callableIdentity(node),
      });
    }
    for (const [id, owner] of owners) {
      const method = graph.getNode(id);
      if (method?.label === 'Method')
        result.HAS_METHOD.edges.push({ from: graphIdentity(owner), to: callableIdentity(method) });
    }
  }
  const boundRanges = new Set();
  for (const site of boundCalls) {
    const key = siteKey(site);
    boundRanges.add(key);
    if (constructedTargets.get(key) !== site.target) result.CALLS.sites.push(site);
  }
  for (const relation of graphRelations) {
    for (const edge of graph.iterRelationshipsByType(relation)) {
      if (edge.reason === 'interface-dispatch') continue;
      const valueReference = relation === 'USES' && edge.reason === 'scope-resolution: value-ref';
      if (
        relation === 'USES' &&
        !valueReference &&
        edge.reason !== 'scope-resolution: type-reference'
      )
        continue;
      const from = graph.getNode(edge.sourceId);
      const to = graph.getNode(edge.targetId);
      assert.ok(from && to, 'Unpublished endpoint: ' + edge.id);
      if (valueReference && to.label !== 'Function') continue;
      const located = relation === 'CALLS' || relation === 'USES';
      const prefix = 'rel:' + relation + ':' + edge.sourceId + '->' + edge.targetId + ':';
      const span =
        located &&
        edge.id.startsWith(prefix) &&
        /^(\d+:\d+):(\d+:\d+)$/.exec(edge.id.slice(prefix.length));
      const site = span && { file: from.properties.filePath, start: span[1], end: span[2] };
      let kind = valueReference ? 'FUNCTION_VALUES' : relation;
      if (relation === 'CALLS' && to.label === 'Property') kind = 'CALLABLE_PROPERTIES';
      if (edge.reason === 'callable-value-flow' && site && parameterRanges.has(siteKey(site)))
        continue; // The checker binds this invocation to its parameter signature.
      if (kind === 'CALLS' && site && constructedTargets.get(siteKey(site)) === graphIdentity(to))
        continue;
      result[kind].edges.push({ from: callableIdentity(from), to: callableIdentity(to) });
      if (kind === 'CALLS') {
        result.publishedCalls.push({
          ...(site && site.start !== site.end ? site : {}),
          caller: callableIdentity(from),
          target: callableIdentity(to),
        });
      }
      if (
        site &&
        site.start !== site.end &&
        !(kind === 'CALLS' && boundRanges.has(siteKey(site)))
      ) {
        result[kind].sites.push({ ...site, status: 'resolved', target: graphIdentity(to) });
      }
    }
  }
  return result;
}

function siteKey(site) {
  return JSON.stringify([site.file, site.start, site.end]);
}

// Some relationship IDs encode only an endpoint pair. For those pairs the
// observer separately verifies the binding at each compiler site.
export function comparePublishedCalls(expected, published) {
  const pair = ({ caller, target }) => JSON.stringify([caller, target]);
  const row = (call) => JSON.stringify([siteKey(call), call.caller, call.target]);
  const remaining = new Map();
  for (const call of expected) {
    const endpoints = pair(call);
    let sites = remaining.get(endpoints);
    if (!sites) {
      sites = new Set();
      remaining.set(endpoints, sites);
    }
    sites.add(row(call));
  }
  const located = new Set();
  const locatedPairs = new Set();
  const collapsed = new Set();
  for (const call of published) {
    const endpoints = pair(call);
    if (call.start) {
      const site = row(call);
      assert.ok(!located.has(site), 'Duplicate published CALLS ' + site);
      assert.ok(remaining.get(endpoints)?.delete(site), 'Unexpected published CALLS ' + site);
      located.add(site);
      locatedPairs.add(endpoints);
    } else {
      assert.ok(remaining.has(endpoints), 'Unexpected published CALLS ' + endpoints);
      assert.ok(!collapsed.has(endpoints), 'Duplicate published CALLS ' + endpoints);
      collapsed.add(endpoints);
    }
  }
  for (const [endpoints, sites] of remaining) {
    assert.ok(
      !(collapsed.has(endpoints) && locatedPairs.has(endpoints)),
      'Mixed located and positionless CALLS ' + endpoints,
    );
    if (sites.size) assert.ok(collapsed.has(endpoints), 'Missing published CALLS ' + [...sites][0]);
    else assert.ok(!collapsed.has(endpoints), 'Duplicate published CALLS ' + endpoints);
  }
}

function publishedParameterCalls(graph, calls) {
  if (!calls.length) return [];
  const owners = new Map();
  for (const node of graph.iterNodes()) {
    if (
      (node.label === 'Method' || node.label === 'Function') &&
      Array.isArray(node.properties.parameterTypes) &&
      Number.isInteger(node.properties.startColumn)
    ) {
      owners.set(graphDeclaration(node), node.properties.parameterTypes);
    }
  }
  return calls.map(({ formal, ...site }) => {
    const annotation = owners.get(formal.owner)?.[formal.index];
    assert.ok(annotation, 'Missing published parameter type at ' + formal.declaration);
    return { ...site, target: JSON.stringify([formal.declaration, annotation]) };
  });
}

function parameterInvocations(file, indexes) {
  const formals = new Map();
  for (const site of file.callableFlowSites ?? []) {
    if (site.kind !== 'formal') continue;
    const scope = indexes.scopeTree.getScope(site.binding.inScope);
    const owner = scope?.ownedDefs.find(
      (def) =>
        def.declarationRange?.startLine === site.ownerRange.startLine &&
        def.declarationRange?.startCol === site.ownerRange.startCol,
    );
    if (!owner?.parameterTypes?.[site.parameterIndex]) continue;
    const name = site.binding.atRange;
    formals.set(JSON.stringify([scope.id, site.binding.name]), {
      declaration: file.filePath + '#' + name.startLine + ':' + name.startCol,
      owner: file.filePath + '#' + site.ownerRange.startLine + ':' + site.ownerRange.startCol,
      index: site.parameterIndex,
    });
  }
  const calls = [];
  for (const site of file.callableFlowSites ?? []) {
    if (site.kind !== 'invoke' || site.invocationKind !== 'indirect') continue;
    const { scope } = lookupNameClaim(site.callee.inScope, site.callee.name, indexes, {
      purpose: 'value',
      position: site.callee.atRange,
    });
    const formal = scope && formals.get(JSON.stringify([scope.id, site.callee.name]));
    if (!formal) continue;
    const range = site.callSite;
    calls.push({
      file: file.filePath,
      start: range.startLine + ':' + range.startCol,
      end: range.endLine + ':' + range.endCol,
      status: 'resolved',
      formal,
    });
  }
  return calls;
}

function recordBindings(observation, calls, typeParameters, reads, unbound, parameterCalls) {
  const definitions = new Map(
    observation.parsedFiles.flatMap((file) => file.localDefs.map((def) => [def.nodeId, def])),
  );
  for (const file of observation.parsedFiles) {
    parameterCalls.push(...parameterInvocations(file, observation.indexes));
    for (const site of file.referenceSites) {
      const binding = observation.referenceBindings.get(site);
      if (site.kind === 'read' && binding?.status === 'resolved') {
        for (const id of binding.targetDefIds) {
          const def = definitions.get(id);
          if (!def?.nameRange) continue;
          const range = site.atRange;
          reads.push({
            file: file.filePath,
            start: range.startLine + ':' + range.startCol,
            end: range.endLine + ':' + range.endCol,
            status: 'resolved',
            target: def.filePath + '#' + def.nameRange.startLine + ':' + def.nameRange.startCol,
          });
        }
      }
      if (binding?.basis === 'type-parameter') {
        let scope = observation.indexes.scopeTree.getScope(site.inScope);
        while (scope) {
          const owner = scope.ownedDefs.find(
            (def) =>
              def.declarationRange?.startLine === scope.range.startLine &&
              def.declarationRange?.startCol === scope.range.startCol &&
              def.typeParameters?.some((p) => p.name === site.name),
          );
          const name =
            owner?.nameRange ??
            (scope.typeParameters?.some((parameter) => parameter.name === site.name) &&
              scope.range);
          if (name) {
            const range = site.atRange;
            typeParameters.push({
              file: file.filePath,
              start: range.startLine + ':' + range.startCol,
              end: range.endLine + ':' + range.endCol,
              status: 'type-parameter',
              target: scope.filePath + '#' + name.startLine + ':' + name.startCol + '/' + site.name,
            });
            break;
          }
          scope = observation.indexes.scopeTree.getParent(scope.id);
        }
      }
      if (site.kind !== 'call') continue;
      if (binding?.status !== 'resolved') {
        if (binding && (binding.status === 'blocked' || binding.status === 'unresolved')) {
          const range = site.atRange;
          unbound.push({
            file: file.filePath,
            start: range.startLine + ':' + range.startCol,
            end: range.endLine + ':' + range.endCol,
            status: 'unresolved',
          });
        }
        continue;
      }
      for (const id of binding.targetDefIds) {
        const def = definitions.get(id);
        if (!def?.declarationRange || !['Function', 'Method', 'Class'].includes(def.type)) continue;
        const { startLine, startCol } = def.declarationRange;
        const range = site.atRange;
        calls.push({
          file: file.filePath,
          start: range.startLine + ':' + range.startCol,
          end: range.endLine + ':' + range.endCol,
          status: 'resolved',
          target: def.filePath + '#' + startLine + ':' + startCol,
        });
      }
    }
  }
}

const fixturesDirectory = fileURLToPath(new URL('../../../test/fixtures/', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('./projects.json', import.meta.url), 'utf8'));

export async function compareProject(root, options = {}, expectedDiagnostics = []) {
  const key = path.relative(fixturesDirectory, root).split(path.sep).join('/');
  const inventory = manifest.declarationInventory.includes(key);
  const methodFacts = manifest.methodFacts.includes(key);
  const propertyAccess = manifest.propertyAccess.includes(key);
  const reference = compilerReport(root, expectedDiagnostics, inventory, {
    methodFacts,
    propertyAccess,
    projects: manifest.compilerProjects[key],
  });
  assert.ok(
    relations.some((kind) => reference[kind].edges.length || reference[kind].sites.length),
    root + ': TypeScript reported no project-local declarations at any reference',
  );
  const boundCalls = [];
  const parameterCalls = [];
  const classes = [];
  const methodReturns = new Map();
  const typeParameters = [];
  const reads = [];
  const unbound = [];
  const pipeline = await runPipelineFromRepo(root, () => {}, {
    ...options,
    // Keep local declarations observable when a property read could bind to a same-named variable.
    ...(propertyAccess ? { keepLocalValueSymbols: true } : {}),
    onScopeResolved(observation) {
      for (const file of observation.parsedFiles) {
        for (const def of file.localDefs) {
          if (def.type === 'Class') classes.push(def);
          if (methodFacts && def.type === 'Method' && def.declarationRange) {
            const { startLine, startCol } = def.declarationRange;
            methodReturns.set(file.filePath + '#' + startLine + ':' + startCol, def.returnType);
          }
        }
      }
      recordBindings(observation, boundCalls, typeParameters, reads, unbound, parameterCalls);
    },
  });
  const observed = graphReport(
    pipeline.graph,
    boundCalls,
    inventory,
    methodFacts,
    propertyAccess,
    parameterCalls,
    classes,
    methodReturns,
    new Map(
      reference.uncheckedMemberSites
        .filter((site) => site.constructedTarget)
        .map((site) => [siteKey(site), site.constructedTarget]),
    ),
  );
  comparePublishedCalls(reference.publishedCalls, observed.publishedCalls);
  observed.TYPE_PARAMETER_USES.sites = typeParameters;
  // Each compiler-selected variable read must have a binding at the same range.
  // The observer also sees property reads, argument reads and other syntax.
  const rejectedLocations = new Set(reference.REJECTED_CALLS.sites.map(siteKey));
  observed.REJECTED_CALLS.sites = unbound.filter((site) => rejectedLocations.has(siteKey(site)));
  const checkedReads = new Set(reference.VARIABLE_READS.sites.map(siteKey));
  observed.VARIABLE_READS.sites = reads.filter((site) => checkedReads.has(siteKey(site)));
  for (const relation of relations) {
    if (!reference[relation].edges.length && !reference[relation].sites.length) {
      assert.deepEqual(
        observed[relation],
        { sites: [], edges: [] },
        root + ': unexpected ' + relation,
      );
      continue;
    }
    try {
      compareReports(
        { producer: 'TypeScript', ...reference[relation] },
        { producer: 'GitNexus', ...observed[relation] },
      );
    } catch (cause) {
      throw new Error(path.basename(root) + ' ' + relation, { cause });
    }
  }
  return {
    pipeline,
    counts: Object.fromEntries(
      relations.map((kind) => [kind, reference[kind].sites.length || reference[kind].edges.length]),
    ),
  };
}

export async function compareProjects(fixtures, diagnostics, diagnosticsOnly = new Set()) {
  assert.ok(fixtures.length, 'No TypeScript fixtures found');
  const failures = [];
  for (const root of fixtures) {
    const key = path.relative(fixturesDirectory, root).split(path.sep).join('/');
    try {
      if (diagnosticsOnly.has(key)) {
        compilerReport(root, diagnostics[key]);
        console.log(path.basename(root), 'TypeScript diagnostics only');
      } else {
        const { counts } = await compareProject(root, {}, diagnostics[key]);
        console.log(path.basename(root), counts);
      }
    } catch (cause) {
      failures.push(new Error(path.basename(root), { cause }));
    }
  }
  if (failures.length)
    throw new AggregateError(failures, `${failures.length} TypeScript conformance fixtures failed`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controls = ['controls.test.mjs', 'capture-controls.test.mjs', 'product/mcp-tools.ts'].map(
    (file) => fileURLToPath(new URL(file, import.meta.url)),
  );
  const reporter = new URL('../java/native-reporter.mjs', import.meta.url);
  execFileSync(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-reporter=' + reporter.href, ...controls],
    {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      stdio: 'inherit',
      env: { ...process.env, GITNEXUS_CONFORMANCE_TEST_FILES: JSON.stringify(controls) },
    },
  );

  const corpus = fileURLToPath(
    new URL('../../../test/fixtures/compiler-conformance/', import.meta.url),
  );
  const diagnostics = JSON.parse(
    readFileSync(new URL('./diagnostics.json', import.meta.url), 'utf8'),
  );
  if (process.argv.length > 2) {
    await compareProjects(
      process.argv.slice(2).map((dir) => path.resolve(dir)),
      diagnostics,
    );
  } else {
    const projects = [
      ...readdirSync(corpus, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('typescript-'))
        .map((entry) => 'compiler-conformance/' + entry.name),
      ...manifest.projects,
      ...manifest.diagnosticsOnly,
    ];
    const registered = new Set(projects);
    assert.equal(registered.size, projects.length, 'Duplicate TypeScript project registration');
    for (const key of Object.keys(diagnostics))
      assert.ok(registered.has(key), 'Diagnostics for an unregistered TypeScript project: ' + key);
    await compareProjects(
      projects.map((key) => path.join(fixturesDirectory, key)),
      diagnostics,
      new Set(manifest.diagnosticsOnly),
    );
  }
}
