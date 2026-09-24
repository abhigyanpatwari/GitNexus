#!/usr/bin/env node
/**
 * Build-free scaling and correctness guard for Objective-C workspace
 * resolution (#3179).
 *
 * Import lookup already lives in bench/import-target (the `objc` arm). This
 * bench isolates `emitPostResolutionEdges`: heritage, category membership,
 * and static message-send dispatch. Two shapes:
 *
 *   spread    — typed self / super / sibling receivers. Cost must stay
 *               linear in class count (the C# "namespaces spread" analog).
 *   protocol  — every class conforms to one protocol and sends one
 *               protocol-typed message. Implementer USES live on one
 *               shared node per (protocol, selector); messages only add
 *               the source→shared hop. Both arms must stay linear.
 *
 * Usage:
 *   node --import tsx bench/objective-c-resolution/measure.mjs
 *   node --import tsx bench/objective-c-resolution/measure.mjs --check
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createKnowledgeGraph } from '../../src/core/graph/graph.ts';
import {
  OBJECTIVE_C_GRAMMAR_PACKAGE,
  OBJECTIVE_C_GRAMMAR_VERSION,
  OBJECTIVE_C_PROVIDER_VERSION,
  objcClassQualifiedName,
  objcMethodQualifiedName,
  objcProtocolQualifiedName,
} from '../../src/core/ingestion/languages/objective-c/facts.ts';
import { objectiveCScopeResolver } from '../../src/core/ingestion/languages/objective-c/scope-resolver.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SMALL_CLASSES = 40;
const LARGE_CLASSES = 160;
const REPS = 7;

const graphNodeId = (label, qualifiedName) => `${label}:${qualifiedName}`;

function emptyFacts(filePath) {
  return {
    providerVersion: OBJECTIVE_C_PROVIDER_VERSION,
    grammarPackage: OBJECTIVE_C_GRAMMAR_PACKAGE,
    grammarVersion: OBJECTIVE_C_GRAMMAR_VERSION,
    filePath,
    containers: [],
    methods: [],
    members: [],
    functions: [],
    imports: [],
    messages: [],
    unresolvedMessages: [],
  };
}

function classContainer(filePath, name, extras = {}) {
  const qualifiedName = objcClassQualifiedName(name);
  return {
    kind: 'class',
    declarationRole: 'implementation',
    name,
    qualifiedName,
    nodeId: graphNodeId('Class', qualifiedName),
    label: 'Class',
    filePath,
    startLine: 1,
    endLine: 20,
    protocols: extras.protocols ?? [],
    ...(extras.superclass !== undefined ? { superclass: extras.superclass } : {}),
  };
}

function protocolContainer(filePath, name) {
  const qualifiedName = objcProtocolQualifiedName(name);
  return {
    kind: 'protocol',
    declarationRole: 'interface',
    name,
    qualifiedName,
    nodeId: graphNodeId('Protocol', qualifiedName),
    label: 'Protocol',
    filePath,
    startLine: 1,
    endLine: 4,
    protocols: [],
  };
}

function methodFact(filePath, owner, selector, methodKind, startLine) {
  const qualifiedName = objcMethodQualifiedName(owner.qualifiedName, methodKind, selector);
  return {
    name: selector,
    selector,
    methodKind,
    ownerQualifiedName: owner.qualifiedName,
    ownerName: owner.name,
    ownerKind: owner.kind,
    qualifiedName,
    nodeId: graphNodeId('Method', qualifiedName),
    filePath,
    startLine,
    endLine: startLine,
    declarationRole: 'implementation',
    parameterTypes: [],
    parameterNames: [],
  };
}

function messageFact(method, selector, receiverKind, receiverText, extras = {}) {
  return {
    selector,
    receiverText,
    receiverKind,
    sourceMethodQualifiedName: method.qualifiedName,
    sourceMethodId: method.nodeId,
    sourceOwnerQualifiedName: method.ownerQualifiedName,
    sourceOwnerName: method.ownerName,
    sourceMethodKind: method.methodKind,
    filePath: method.filePath,
    startLine: extras.startLine ?? method.startLine + 1,
    startCol: extras.startCol ?? 2,
    ...(extras.receiverType !== undefined ? { receiverType: extras.receiverType } : {}),
  };
}

function parsedFile(filePath, facts) {
  return Object.freeze({
    filePath,
    moduleScope: 0,
    scopes: Object.freeze([]),
    parsedImports: Object.freeze([]),
    localDefs: Object.freeze([]),
    referenceSites: Object.freeze([]),
    captureSideChannel: Object.freeze({ kind: 'objective-c', facts }),
  });
}

function seedGraph(graph, factsList) {
  for (const facts of factsList) {
    graph.addNode({
      id: graphNodeId('File', facts.filePath),
      label: 'File',
      properties: {
        name: facts.filePath,
        qualifiedName: facts.filePath,
        filePath: facts.filePath,
        startLine: 1,
        endLine: 1,
        language: 'objective-c',
        isExported: false,
      },
    });
    for (const container of facts.containers) {
      graph.addNode({
        id: container.nodeId,
        label: container.label,
        properties: {
          name: container.name,
          qualifiedName: container.qualifiedName,
          filePath: facts.filePath,
          startLine: container.startLine,
          endLine: container.endLine,
          language: 'objective-c',
          isExported: true,
        },
      });
    }
    for (const method of facts.methods) {
      graph.addNode({
        id: method.nodeId,
        label: 'Method',
        properties: {
          name: method.selector,
          qualifiedName: method.qualifiedName,
          filePath: facts.filePath,
          startLine: method.startLine,
          endLine: method.endLine,
          language: 'objective-c',
          isExported: true,
        },
      });
    }
  }
}

function summarize(graph) {
  let calls = 0;
  let extendsEdges = 0;
  let implementsEdges = 0;
  let protocolCandidateUses = 0;
  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'CALLS') calls++;
    else if (rel.type === 'EXTENDS') extendsEdges++;
    else if (rel.type === 'IMPLEMENTS') implementsEdges++;
    else if (rel.type === 'USES' && String(rel.reason).startsWith('objc-protocol-candidate:')) {
      protocolCandidateUses++;
    }
  }
  return {
    calls,
    extends: extendsEdges,
    implements: implementsEdges,
    protocol_candidate_uses: protocolCandidateUses,
  };
}

function spreadCorpus(classCount) {
  const factsList = [];
  const parsedFiles = [];
  for (let i = 0; i < classCount; i++) {
    const filePath = `src/Class${i}.m`;
    const name = `Class${i}`;
    const sibling = `Class${(i + 1) % classCount}`;
    const owner = classContainer(filePath, name, i === 0 ? {} : { superclass: 'Class0' });
    const run = methodFact(filePath, owner, 'run', '-', 4);
    const tick = methodFact(filePath, owner, 'tick', '-', 8);
    const messages = [
      messageFact(tick, 'run', 'self', 'self', { startLine: 9, startCol: 2 }),
      messageFact(tick, 'run', 'local', 'sib', {
        startLine: 10,
        startCol: 2,
        receiverType: { kind: 'class', name: sibling, raw: `${sibling} *` },
      }),
    ];
    if (i > 0) {
      messages.push(messageFact(tick, 'run', 'super', 'super', { startLine: 11, startCol: 2 }));
    }
    const facts = {
      ...emptyFacts(filePath),
      containers: [owner],
      methods: [run, tick],
      messages,
    };
    factsList.push(facts);
    parsedFiles.push(parsedFile(filePath, facts));
  }
  return { factsList, parsedFiles };
}

function protocolCorpus(classCount) {
  const factsList = [];
  const parsedFiles = [];
  const protocolPath = 'src/Runnable.h';
  const protocol = protocolContainer(protocolPath, 'Runnable');
  const protocolRun = methodFact(protocolPath, protocol, 'run', '-', 2);
  const protocolFacts = {
    ...emptyFacts(protocolPath),
    containers: [protocol],
    methods: [protocolRun],
  };
  factsList.push(protocolFacts);
  parsedFiles.push(parsedFile(protocolPath, protocolFacts));

  for (let i = 0; i < classCount; i++) {
    const filePath = `src/Class${i}.m`;
    const owner = classContainer(filePath, `Class${i}`, { protocols: ['Runnable'] });
    const run = methodFact(filePath, owner, 'run', '-', 4);
    const tick = methodFact(filePath, owner, 'tick:', '-', 8);
    const facts = {
      ...emptyFacts(filePath),
      containers: [owner],
      methods: [run, tick],
      messages: [
        messageFact(tick, 'run', 'local', 'runner', {
          startLine: 9,
          startCol: 2,
          receiverType: { kind: 'protocol', name: 'Runnable', raw: 'id<Runnable>' },
        }),
      ],
    };
    factsList.push(facts);
    parsedFiles.push(parsedFile(filePath, facts));
  }
  return { factsList, parsedFiles };
}

function run(shape, classCount) {
  const corpus = shape === 'spread' ? spreadCorpus(classCount) : protocolCorpus(classCount);
  const graph = createKnowledgeGraph();
  seedGraph(graph, corpus.factsList);
  objectiveCScopeResolver.emitPostResolutionEdges(graph, corpus.parsedFiles);
  return summarize(graph);
}

function measure(shape, classCount) {
  run(shape, classCount);
  let bestMs = Infinity;
  let counts = { calls: 0, extends: 0, implements: 0, protocol_candidate_uses: 0 };
  for (let i = 0; i < REPS; i++) {
    const start = performance.now();
    counts = run(shape, classCount);
    bestMs = Math.min(bestMs, performance.now() - start);
  }
  return {
    classes: classCount,
    ...counts,
    min_ms: Number(bestMs.toFixed(2)),
  };
}

function scalingReport(small, large) {
  const workloadRatio = large.classes / small.classes;
  const scalingRatio = Number((large.min_ms / Math.max(small.min_ms, 0.01)).toFixed(3));
  return {
    small,
    large,
    workload_ratio: workloadRatio,
    scaling_ratio: scalingRatio,
    linear_factor: Number((scalingRatio / workloadRatio).toFixed(3)),
  };
}

const report = {
  spread: scalingReport(measure('spread', SMALL_CLASSES), measure('spread', LARGE_CLASSES)),
  protocol: scalingReport(measure('protocol', SMALL_CLASSES), measure('protocol', LARGE_CLASSES)),
};

if (!process.argv.includes('--check')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(join(HERE, 'baseline.json'), 'utf8'));
const failures = [];
const requirePositiveNumber = (path, value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0)) {
    failures.push(`${path}: expected a finite positive number, got ${JSON.stringify(value)}`);
    return false;
  }
  return true;
};

for (const shape of ['spread', 'protocol']) {
  const measured = report[shape];
  const expected = baseline[shape];
  for (const arm of ['small', 'large']) {
    for (const key of ['classes', 'calls', 'extends', 'implements', 'protocol_candidate_uses']) {
      if (measured[arm][key] !== expected[arm][key]) {
        failures.push(
          `${shape}.${arm}.${key}: expected ${expected[arm][key]}, got ${measured[arm][key]}`,
        );
      }
    }
    if (
      requirePositiveNumber(`${shape}.${arm}.ms_budget`, expected[arm].ms_budget) &&
      measured[arm].min_ms > expected[arm].ms_budget
    ) {
      failures.push(
        `${shape}.${arm}.min_ms ${measured[arm].min_ms} exceeds budget ${expected[arm].ms_budget}`,
      );
    }
  }
}

if (
  requirePositiveNumber('spread.linear_scaling_slack', baseline.spread.linear_scaling_slack) &&
  report.spread.linear_factor > baseline.spread.linear_scaling_slack
) {
  failures.push(
    `spread.linear_factor ${report.spread.linear_factor} exceeds slack ` +
      `${baseline.spread.linear_scaling_slack} (runtime ${report.spread.scaling_ratio}x ` +
      `for ${report.spread.workload_ratio}x work)`,
  );
}

if (
  requirePositiveNumber('protocol.linear_scaling_slack', baseline.protocol.linear_scaling_slack) &&
  report.protocol.linear_factor > baseline.protocol.linear_scaling_slack
) {
  failures.push(
    `protocol.linear_factor ${report.protocol.linear_factor} exceeds slack ` +
      `${baseline.protocol.linear_scaling_slack} (runtime ${report.protocol.scaling_ratio}x ` +
      `for ${report.protocol.workload_ratio}x work)`,
  );
}

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error('[objective-c-resolution --check] FAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('[objective-c-resolution --check] PASS');
