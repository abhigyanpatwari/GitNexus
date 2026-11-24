import { compareCodeUnits } from '../compare.mjs';
import { copyResolutionProject } from './graph-observations.mjs';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import { _captureLogger } from '../../../dist/core/logger.js';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  edgeSet,
  getResolutionOutcomes,
  runPipelineFromRepo,
  writeFixtureRepo,
} from './graph-observations.mjs';
function compareParameterTypes(left, right) {
  const sharedLength = Math.min(left.length, right.length);
  for (let i = 0; i < sharedLength; i++) {
    const order = compareCodeUnits(left[i], right[i]);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

async function verifyJavaHeritageResolution() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-heritage'), () => {});
  // resolves exactly 4 IMPORTS edges
  {
    const imports = getRelationships(result, 'IMPORTS');
    assert.equal(imports.length, 4);
    assert.deepEqual(edgeSet(imports), [
      'User.java \u2192 Serializable.java',
      'User.java \u2192 Validatable.java',
      'UserService.java \u2192 Serializable.java',
      'UserService.java \u2192 User.java',
    ]);
  }
  // no OVERRIDES edges target Property nodes
  {
    const overrides = getRelationships(result, 'METHOD_OVERRIDES');
    for (const edge of overrides) {
      const target = result.graph.getNode(edge.rel.targetId);
      assert.notEqual(target, undefined);
      assert.notEqual(target.label, 'Property');
    }
  }
}
async function verifyJavaQualifiedBaseHeritageResolution1956U2() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-qualified-base'), () => {});
  // emits exactly one EXTENDS per class, tail-resolved (no spurious prefix edge)
  {
    const extends_ = getRelationships(result, 'EXTENDS');
    assert.deepEqual(edgeSet(extends_), [
      'Plain \u2192 Base',
      'Service \u2192 Box',
      'Two \u2192 Box',
    ]);
  }
  // emits exactly one IMPLEMENTS per class, tail-resolved (no spurious prefix edge)
  {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    assert.deepEqual(edgeSet(implements_), [
      'Plain \u2192 IBar',
      'Service \u2192 IFoo',
      'Two \u2192 IFoo',
    ]);
  }
}
async function verifyJavaAmbiguousSymbolResolution() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-ambiguous'), () => {});
  // import edges point to models/ not other/
  {
    const imports = getRelationships(result, 'IMPORTS');
    const targets = imports.map((e) => e.target).sort(compareCodeUnits);
    assert.ok(targets.includes('Handler.java'));
    assert.ok(targets.includes('Processor.java'));
    for (const imp of imports) {
      assert.match(imp.targetFilePath, /^models\//);
    }
  }
}
async function verifyJavaCallResolutionWithArityFiltering() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-calls'), () => {});
  // resolves processUser → writeAudit to util/OneArg.java via arity narrowing
  {
    const calls = getRelationships(result, 'CALLS');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].source, 'processUser');
    assert.equal(calls[0].target, 'writeAudit');
    assert.equal(calls[0].targetFilePath, 'util/OneArg.java');
    assert.equal(calls[0].rel.reason, 'import-resolved');
  }
}
async function verifyJavaSameModulePriorityForDuplicateFQNs() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-duplicate-fqn-modules'), () => {});
  // resolves Module1App.run calls to module1 UserService, not module2
  {
    const calls = getRelationships(result, 'CALLS');
    const module1ToModule1 = calls.filter(
      (c) =>
        c.source === 'run' &&
        c.target === 'UserService' &&
        c.sourceFilePath === 'module1/src/main/java/com/example/Module1App.java' &&
        c.targetFilePath === 'module1/src/main/java/com/example/UserService.java',
    );
    const module1ToModule2 = calls.filter(
      (c) =>
        c.source === 'run' &&
        c.target === 'UserService' &&
        c.sourceFilePath === 'module1/src/main/java/com/example/Module1App.java' &&
        c.targetFilePath === 'module2/src/main/java/com/example/UserService.java',
    );
    const module1ToAnyUserService = calls.filter(
      (c) =>
        c.source === 'run' &&
        c.target === 'UserService' &&
        c.sourceFilePath === 'module1/src/main/java/com/example/Module1App.java' &&
        /module[12]\/src\/main\/java\/com\/example\/UserService\.java/.test(c.targetFilePath),
    );
    assert.equal(module1ToModule1.length, 1);
    assert.equal(module1ToModule2.length, 0);
    assert.equal(module1ToAnyUserService.length, 1);
  }
  // resolves Module2App.run calls to module2 UserService, not module1
  {
    const calls = getRelationships(result, 'CALLS');
    const module2ToModule2 = calls.filter(
      (c) =>
        c.source === 'run' &&
        c.target === 'UserService' &&
        c.sourceFilePath === 'module2/src/main/java/com/example/Module2App.java' &&
        c.targetFilePath === 'module2/src/main/java/com/example/UserService.java',
    );
    const module2ToModule1 = calls.filter(
      (c) =>
        c.source === 'run' &&
        c.target === 'UserService' &&
        c.sourceFilePath === 'module2/src/main/java/com/example/Module2App.java' &&
        c.targetFilePath === 'module1/src/main/java/com/example/UserService.java',
    );
    const module2ToAnyUserService = calls.filter(
      (c) =>
        c.source === 'run' &&
        c.target === 'UserService' &&
        c.sourceFilePath === 'module2/src/main/java/com/example/Module2App.java' &&
        /module[12]\/src\/main\/java\/com\/example\/UserService\.java/.test(c.targetFilePath),
    );
    assert.equal(module2ToModule2.length, 1);
    assert.equal(module2ToModule1.length, 0);
    assert.equal(module2ToAnyUserService.length, 1);
  }
}
async function verifyJavaMemberCallResolution() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-member-calls'), () => {});
  // emits HAS_METHOD edge from User to save
  {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const edge = hasMethod.find((e) => e.source === 'User' && e.target === 'save');
    assert.notEqual(edge, undefined);
  }
}
async function verifyJavaDeclaredPackageImportResolution2910() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-import-package-evidence'), () => {});
  // does not emit an IMPORTS edge from java.util.List to local util/List.java
  {
    const imports = getRelationships(result, 'IMPORTS');
    assert.equal(
      imports.some(
        (edge) =>
          edge.sourceFilePath === 'app/Main.java' && edge.targetFilePath === 'util/List.java',
      ),
      false,
    );
  }
  // resolves a declared package even when the file path is flattened
  {
    const imports = getRelationships(result, 'IMPORTS');
    assert.equal(
      imports.some(
        (edge) => edge.sourceFilePath === 'app/Main.java' && edge.targetFilePath === 'User.java',
      ),
      true,
    );
    const calls = getRelationships(result, 'CALLS');
    assert.equal(
      calls.some(
        (edge) =>
          edge.source === 'run' && edge.target === 'save' && edge.targetFilePath === 'User.java',
      ),
      true,
    );
  }
}
async function verifyJavaVariadicCallResolution() {
  const { graph } = await runPipelineFromRepo(
    path.join(FIXTURES, 'java-variadic-resolution'),
    () => {},
  );
  let hasCalls = false;
  for (const edge of graph.iterRelationships()) {
    if (edge.type === 'CALLS') hasCalls = true;
    assert.ok(
      graph.getNode(edge.sourceId),
      'Missing source ' + edge.sourceId + ' for ' + edge.type,
    );
  }
  assert.ok(hasCalls, 'Expected CALLS edges in the variadic fixture');
}
async function verifyJavaWildcardImportResolution() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-wildcard-import'), () => {});
  // emits an IMPORTS edge only to the package file whose type the importer names
  {
    const imports = getRelationships(result, 'IMPORTS').filter(
      (edge) => edge.sourceFilePath === 'com/example/app/Main.java',
    );
    assert.deepEqual(imports.map((edge) => edge.targetFilePath).sort(compareCodeUnits), [
      'com/example/models/User.java',
    ]);
  }
}
async function verifyJavaOnDemandImportEdges() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-wildcard-on-demand'), () => {});
  const importsOf = (file) =>
    getRelationships(result, 'IMPORTS')
      .filter((edge) => edge.sourceFilePath === `com/example/app/${file}`)
      .map((edge) => edge.targetFilePath.replace('com/example/models/', ''))
      .sort(compareCodeUnits);
  // keeps the files a type-only use names — the edge is their only trace
  {
    assert.deepEqual(importsOf('TypeOnly.java'), [
      'Audited.java',
      'BizException.java',
      'User.java',
    ]);
  }
  // emits no edge for a wildcard import the file never uses
  {
    assert.deepEqual(importsOf('Unused.java'), []);
  }
  // keeps the type a static wildcard import names
  {
    assert.deepEqual(importsOf('StaticUser.java'), ['Utils.java']);
  }
  // keeps an explicit import whether or not its type is used
  {
    assert.deepEqual(importsOf('Explicit.java'), ['Order.java']);
  }
}
async function verifyJavaRecordMethodResolution2564() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-record-methods'), () => {});
  // emits HAS_METHOD edges linking sum and scaled to Point
  {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const sumEdge = hasMethod.find((e) => e.source === 'Point' && e.target === 'sum');
    const scaledEdge = hasMethod.find((e) => e.source === 'Point' && e.target === 'scaled');
    assert.notEqual(sumEdge, undefined);
    assert.notEqual(scaledEdge, undefined);
  }
  // keeps a same-line explicit overload distinct from the implicit accessor (#2936)
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-record-sameline-'));
    try {
      copyResolutionProject(root, 'record-explicit-overload');
      const linked = await runPipelineFromRepo(root, () => {});
      const arities = getNodesByLabelFull(linked, 'Method')
        .filter((node) => node.name === 'x')
        .map((node) => Number(node.properties.parameterCount))
        .sort((left, right) => left - right);
      assert.deepEqual(arities, [0, 1]);
    } finally {
      fs.rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  }
  // uses the Record node as a caller source and constructor-call target (#2801)
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-record-link-'));
    try {
      copyResolutionProject(root, 'record-construction');
      const linked = await runPipelineFromRepo(root, () => {});
      const initializerCall = getRelationships(linked, 'CALLS').find(
        (edge) => edge.source === 'Point' && edge.target === 'initialize',
      );
      assert.equal(initializerCall?.sourceLabel, 'Record');
      const constructorCall = getRelationships(linked, 'CALLS').find(
        (edge) => edge.source === 'make' && edge.target === 'Point',
      );
      assert.equal(constructorCall?.targetLabel, 'Record');
    } finally {
      fs.rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  }
  // links and dispatches an explicit Record interface method (#2900)
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-record-heritage-'));
    try {
      copyResolutionProject(root, 'record-interface-method');
      const linked = await runPipelineFromRepo(root, () => {});
      const implementsEdge = getRelationships(linked, 'IMPLEMENTS').find(
        (edge) => edge.source === 'User' && edge.target === 'Named',
      );
      const fanout = getRelationships(linked, 'CALLS').filter(
        (edge) =>
          edge.source === 'read' &&
          edge.target === 'name' &&
          edge.rel.reason === 'interface-dispatch',
      );
      assert.equal(implementsEdge?.sourceLabel, 'Record');
      assert.equal(implementsEdge?.targetLabel, 'Interface');
      assert.deepEqual(
        fanout.map((edge) => `${edge.targetLabel}:${edge.targetFilePath}`).sort(compareCodeUnits),
        ['Method:RecordHeritage.java'],
      );
    } finally {
      fs.rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  }
  // materializes implicit accessors and dispatches them through a Record interface (#2917)
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-record-accessor-'));
    try {
      copyResolutionProject(root, 'record-component-dispatch');
      const linked = await runPipelineFromRepo(root, () => {});
      const implementsEdge = getRelationships(linked, 'IMPLEMENTS').find(
        (edge) => edge.source === 'User' && edge.target === 'Named',
      );
      const fanout = getRelationships(linked, 'CALLS').filter(
        (edge) =>
          edge.source === 'read' &&
          edge.target === 'name' &&
          edge.rel.reason === 'interface-dispatch',
      );
      const methods = getNodesByLabelFull(linked, 'Method');
      const userName = methods.find(
        (method) => method.name === 'name' && method.properties.filePath.endsWith('User.java'),
      );
      const userTags = methods.find(
        (method) => method.name === 'tags' && method.properties.filePath.endsWith('User.java'),
      );
      const explicitNames = methods.filter(
        (method) => method.name === 'name' && method.properties.filePath.endsWith('Explicit.java'),
      );
      const userHasMethod = getRelationships(linked, 'HAS_METHOD').filter(
        (edge) => edge.source === 'User' && (edge.target === 'name' || edge.target === 'tags'),
      );
      const methodImplements = getRelationships(linked, 'METHOD_IMPLEMENTS').filter(
        (edge) => edge.source === 'name' && edge.target === 'name',
      );
      const directTags = getRelationships(linked, 'CALLS').find(
        (edge) => edge.source === 'directTags' && edge.target === 'tags',
      );
      assert.equal(implementsEdge?.sourceLabel, 'Record');
      assert.equal(implementsEdge?.targetLabel, 'Interface');
      assert.partialDeepStrictEqual(userName?.properties, {
        parameterCount: 0,
        returnType: 'String',
        visibility: 'public',
      });
      assert.partialDeepStrictEqual(userTags?.properties, {
        parameterCount: 0,
        returnType: 'java.util.List<String>',
        visibility: 'public',
      });
      assert.equal(explicitNames.length, 1);
      assert.deepEqual(userHasMethod.map((edge) => edge.target).sort(compareCodeUnits), [
        'name',
        'tags',
      ]);
      assert.ok(
        ((items) =>
          items.length === 2 &&
          items[0]?.includes('Explicit.java') &&
          items[1]?.includes('User.java'))(
          methodImplements.map((edge) => edge.sourceFilePath).sort(compareCodeUnits),
        ),
      );
      assert.ok(
        ((items) =>
          items.length === 2 &&
          items[0]?.includes('Explicit.java') &&
          items[1]?.includes('User.java'))(
          fanout.map((edge) => edge.targetFilePath).sort(compareCodeUnits),
        ),
      );
      assert.ok((directTags?.targetFilePath).includes('User.java'));
    } finally {
      fs.rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  }
}
async function verifyJavaEnumInterfaceHeritage2918() {
  // links and dispatches an Enum interface method (#2918)
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-enum-heritage-'));
    try {
      copyResolutionProject(root, 'enum-interface-method');
      const linked = await runPipelineFromRepo(root, () => {});
      const implementsEdges = getRelationships(linked, 'IMPLEMENTS').filter(
        (edge) => edge.source === 'Status' && edge.target === 'Named',
      );
      const fanout = getRelationships(linked, 'CALLS').filter(
        (edge) =>
          edge.source === 'read' &&
          edge.target === 'label' &&
          edge.rel.reason === 'interface-dispatch',
      );
      assert.equal(implementsEdges.length, 1);
      assert.equal(implementsEdges[0]?.sourceLabel, 'Enum');
      assert.equal(implementsEdges[0]?.targetLabel, 'Interface');
      assert.deepEqual(fanout.map((edge) => edge.rel.targetId).sort(compareCodeUnits), [
        'Method:EnumHeritage.java:Status.label#0',
      ]);
    } finally {
      fs.rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  }
  // keeps enum constant-body methods distinct while preserving enum heritage (#2918)
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-enum-constant-body-'));
    try {
      copyResolutionProject(root, 'enum-constant-ownership');
      const linked = await runPipelineFromRepo(root, () => {});
      const implementsEdges = getRelationships(linked, 'IMPLEMENTS').filter(
        (edge) => edge.source === 'Status' && edge.target === 'Named',
      );
      assert.equal(implementsEdges.length, 1);
      assert.equal(implementsEdges[0]?.sourceLabel, 'Enum');
      assert.equal(getNodesByLabel(linked, 'Method').filter((name) => name === 'label').length, 3);
      const fanout = getRelationships(linked, 'CALLS').filter(
        (edge) =>
          edge.source === 'read' &&
          edge.target === 'label' &&
          edge.rel.reason === 'interface-dispatch',
      );
      assert.deepEqual(fanout.map((edge) => edge.rel.targetId).sort(compareCodeUnits), [
        'Method:EnumConstantBody.java:Status$1.label#0',
        'Method:EnumConstantBody.java:Status.label#0',
      ]);
    } finally {
      fs.rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  }
  // keeps non-synthetic implementations ahead of abstract enum constant bodies at the cap
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-enum-fanout-cap-'));
    try {
      const constants = Array.from(
        {
          length: 40,
        },
        (_, index) => `A${index} { public String label() { return "enum-${index}"; } }`,
      ).join(',\n');
      const classes = Array.from(
        {
          length: 30,
        },
        (_, index) =>
          `class ZImpl${index} extends ZBase { public String label() { return "class-${index}"; } }`,
      ).join('\n');
      writeFixtureRepo(root, {
        'Fanout.java': `interface Named { String label(); }
          enum AaaBig implements Named {
            ${constants};
            public abstract String label();
          }
          abstract class ZBase implements Named { public abstract String label(); }
          ${classes}
          class Reader { String read(Named value) { return value.label(); } }`,
      });
      const loggerCapture = _captureLogger();
      let linked;
      let logRecords;
      try {
        linked = await runPipelineFromRepo(root, () => {});
        logRecords = loggerCapture.records();
      } finally {
        loggerCapture.restore();
      }
      const fanoutIds = getRelationships(linked, 'CALLS')
        .filter(
          (edge) =>
            edge.source === 'read' &&
            edge.target === 'label' &&
            edge.rel.reason === 'interface-dispatch',
        )
        .map((edge) => edge.rel.targetId);
      assert.equal(fanoutIds.length, 32);
      for (let index = 0; index < 30; index++) {
        assert.ok(fanoutIds.includes(`Method:Fanout.java:ZImpl${index}.label#0`));
      }
      assert.ok(fanoutIds.includes('Method:Fanout.java:AaaBig$1.label#0'));
      assert.ok(fanoutIds.includes('Method:Fanout.java:AaaBig$2.label#0'));
      const warning = logRecords.find(
        (record) =>
          record.msg ===
          'interface-dispatch: members over the fan-out cap dropped implementors (their CALLS edges were not emitted)',
      );
      assert.partialDeepStrictEqual(warning, {
        dispatchFanoutSkipped: 38,
        fanoutCap: 32,
        dispatchFanoutSkippedNames: [
          'Named.label (70 targets; dropped: AaaBig$3.label, AaaBig$4.label, AaaBig$5.label, AaaBig$6.label, AaaBig$7.label, +33 more)',
        ],
      });
    } finally {
      fs.rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  }
}
async function verifyFieldTypeResolutionJava() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-field-types'), () => {});
  // detects Property nodes for Java fields
  {
    const properties = getNodesByLabel(result, 'Property');
    assert.ok(properties.includes('address'));
    assert.ok(properties.includes('name'));
    assert.ok(properties.includes('city'));
  }
  // emits HAS_PROPERTY edges linking properties to classes
  {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    assert.equal(propEdges.length, 3);
    assert.ok(edgeSet(propEdges).includes('User \u2192 address'));
    assert.ok(edgeSet(propEdges).includes('User \u2192 name'));
    assert.ok(edgeSet(propEdges).includes('Address \u2192 city'));
  }
  // emits ACCESSES read edge for user.address field access in chain
  {
    const accesses = getRelationships(result, 'ACCESSES');
    const addressReads = accesses.filter((e) => e.target === 'address' && e.rel.reason === 'read');
    assert.equal(addressReads.length, 1);
    assert.equal(addressReads[0].source, 'processUser');
    assert.equal(addressReads[0].targetLabel, 'Property');
  }
  // populates field metadata (visibility, isStatic, declaredType) on Property nodes
  {
    const properties = getNodesByLabelFull(result, 'Property');
    const city = properties.find((p) => p.name === 'city');
    assert.notEqual(city, undefined);
    assert.equal(city.properties.visibility, 'public');
    assert.equal(city.properties.isStatic, false);
    assert.equal(city.properties.isReadonly, false);
    assert.equal(city.properties.declaredType, 'String');
    const addr = properties.find((p) => p.name === 'address');
    assert.notEqual(addr, undefined);
    assert.equal(addr.properties.visibility, 'public');
    assert.equal(addr.properties.declaredType, 'Address');
  }
}
async function verifyDeepFieldChainResolutionJava() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-deep-field-chain'), () => {});
  // detects Property nodes for Java fields
  {
    const properties = getNodesByLabel(result, 'Property');
    assert.ok(properties.includes('address'));
    assert.ok(properties.includes('city'));
    assert.ok(properties.includes('zipCode'));
  }
  // emits HAS_PROPERTY edges for nested type chain
  {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    assert.ok(edgeSet(propEdges).includes('User \u2192 address'));
    assert.ok(edgeSet(propEdges).includes('Address \u2192 city'));
    assert.ok(edgeSet(propEdges).includes('City \u2192 zipCode'));
  }
}
async function verifyMixedFieldCallChainResolutionJava() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-mixed-chain'), () => {});
  // detects Property nodes for mixed-chain fields
  {
    const properties = getNodesByLabel(result, 'Property');
    assert.ok(properties.includes('city'));
    assert.ok(properties.includes('address'));
  }
}
async function verifyWriteAccessTrackingJava() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-write-access'), () => {});
  // emits ACCESSES write edges for field assignments
  {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    assert.equal(writes.length, 2);
    const nameWrite = writes.find((e) => e.target === 'name');
    const addressWrite = writes.find((e) => e.target === 'address');
    assert.notEqual(nameWrite, undefined);
    assert.equal(nameWrite.source, 'updateUser');
    assert.notEqual(addressWrite, undefined);
    assert.equal(addressWrite.source, 'updateUser');
  }
}
async function verifyJavaImportOfATypeDeclaredUnderSeveral() {
  let result;
  result = await runPipelineFromRepo(
    path.join(FIXTURES, 'java-duplicate-fqn-source-roots'),
    () => {},
  );
  // %s (%s) imports and calls only %j
  for (const [importer, method, userFiles] of [
    [
      'beta/src/main/java/services/UserService.java',
      'process',
      ['beta/src/main/java/models/User.java'],
    ],
    ['gamma/src/main/java/reports/Report.java', 'run', []],
  ]) {
    const imports = getRelationships(result, 'IMPORTS').filter(
      (e) => e.sourceFilePath === importer && e.targetFilePath.endsWith('/models/User.java'),
    );
    const saves = getRelationships(result, 'CALLS').filter(
      (c) => c.source === method && c.target === 'save',
    );
    assert.deepEqual(
      imports.map((e) => e.targetFilePath),
      userFiles,
    );
    assert.deepEqual(
      saves.map((c) => c.targetFilePath),
      userFiles,
    );
  }
}
async function verifyJavaOverloadDisambiguationByParameterTypes() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-overload-param-types'), () => {});
  // produces distinct graph nodes for same-arity overloads via type-hash suffix
  {
    const methods = getNodesByLabelFull(result, 'Method');
    const lookupNodes = methods.filter((m) => m.name === 'lookup');
    assert.equal(lookupNodes.length, 2);
    const types = lookupNodes.map((n) => n.properties.parameterTypes).sort(compareParameterTypes);
    assert.deepEqual(types, [['String'], ['int']]);
  }
}
async function verifyJavaSameArityOverloadCrossFileAndChain() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-same-arity-cross-file'), () => {});
  // emits METHOD_IMPLEMENTS from DbLookup.find(int) → ILookup.find(int)
  {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const edges = mi.filter(
      (e) =>
        e.source === 'find' &&
        e.target === 'find' &&
        e.sourceFilePath.includes('DbLookup') &&
        e.targetFilePath.includes('ILookup'),
    );
    assert.equal(edges.length, 2);
    for (const edge of edges) {
      const sourceNode = result.graph.getNode(edge.rel.sourceId);
      const targetNode = result.graph.getNode(edge.rel.targetId);
      assert.deepEqual(
        sourceNode?.properties.parameterTypes,
        targetNode?.properties.parameterTypes,
      );
    }
  }
}
async function verifyJavaVirtualDispatchViaConstructorTypeSameFile() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-virtual-dispatch'), () => {});
  // detects Animal, Dog, and App classes in same file
  {
    const classes = getNodesByLabel(result, 'Class');
    assert.ok(classes.includes('Animal'));
    assert.ok(classes.includes('Dog'));
    assert.ok(classes.includes('App'));
  }
  // detects Dog extends Animal heritage
  {
    const extends_ = getRelationships(result, 'EXTENDS');
    const dogExtends = extends_.find((e) => e.source === 'Dog' && e.target === 'Animal');
    assert.notEqual(dogExtends, undefined);
  }
  // detects fetchBall() as Dog-only method
  {
    const methods = getNodesByLabel(result, 'Method');
    assert.ok(methods.includes('fetchBall'));
  }
  // resolves fetchBall() calls from run() — proves virtual dispatch override
  {
    const calls = getRelationships(result, 'CALLS');
    const fetchCalls = calls.filter((c) => c.source === 'run' && c.target === 'fetchBall');
    assert.equal(fetchCalls.length, 1);
  }
}
async function verifyJavaCrossFileBindingPropagation() {
  let result;
  const fixture = path.join(FIXTURES, '..', 'java', 'java-cross-file');
  result = await runPipelineFromRepo(fixture, () => {});
  // emits IMPORTS edge from App.java to UserFactory.java
  {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(
      (e) => e.sourceFilePath.includes('App') && e.targetFilePath.includes('UserFactory'),
    );
    assert.notEqual(edge, undefined);
  }
  // emits HAS_METHOD edges linking save and getName to User
  {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const saveEdge = hasMethod.find((e) => e.source === 'User' && e.target === 'save');
    const getNameEdge = hasMethod.find((e) => e.source === 'User' && e.target === 'getName');
    assert.notEqual(saveEdge, undefined);
    assert.notEqual(getNameEdge, undefined);
  }
}
async function verifyJavaMethodEnrichment() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-method-enrichment'), () => {});
  // emits HAS_METHOD edges for Animal methods
  {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const animalMethods = hasMethod.filter((e) => e.source === 'Animal').map((e) => e.target);
    assert.ok(animalMethods.includes('speak'));
    assert.ok(animalMethods.includes('classify'));
    assert.ok(animalMethods.includes('breathe'));
  }
  // emits HAS_METHOD edge for Dog.speak
  {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const dogSpeak = hasMethod.find((e) => e.source === 'Dog' && e.target === 'speak');
    assert.notEqual(dogSpeak, undefined);
  }
  // marks abstract speak as isAbstract (conditional)
  {
    const methods = getNodesByLabelFull(result, 'Function');
    const speak = methods.find(
      (n) => n.name === 'speak' && n.properties.filePath?.includes('Animal.java'),
    );
    if (speak?.properties.isAbstract !== void 0) {
      assert.equal(speak.properties.isAbstract, true);
    }
  }
  // marks breathe as NOT isAbstract (conditional)
  {
    const methods = getNodesByLabelFull(result, 'Function');
    const breathe = methods.find((n) => n.name === 'breathe');
    if (breathe?.properties.isAbstract !== void 0) {
      assert.equal(breathe.properties.isAbstract, false);
    }
  }
  // marks classify as isStatic (conditional)
  {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((n) => n.name === 'classify');
    if (classify?.properties.isStatic !== void 0) {
      assert.equal(classify.properties.isStatic, true);
    }
  }
  // marks breathe as NOT isStatic (conditional)
  {
    const methods = getNodesByLabelFull(result, 'Function');
    const breathe = methods.find((n) => n.name === 'breathe');
    if (breathe?.properties.isStatic !== void 0) {
      assert.equal(breathe.properties.isStatic, false);
    }
  }
  // captures @Override annotation on Dog.speak (conditional)
  {
    const methods = getNodesByLabelFull(result, 'Function');
    const dogSpeak = methods.find(
      (n) => n.name === 'speak' && n.properties.annotations?.includes('@Override'),
    );
    if (dogSpeak) {
      assert.ok(dogSpeak.properties.annotations.includes('@Override'));
    }
  }
  // populates parameterTypes for classify (conditional)
  {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((n) => n.name === 'classify');
    if (classify?.properties.parameterTypes !== void 0) {
      assert.ok(classify.properties.parameterTypes.includes('String'));
    }
  }
}
async function verifyJavaInterfaceDispatchMETHODIMPLEMENTS() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-interface-dispatch'), () => {});
  // emits METHOD_IMPLEMENTS edges from LogEvent.execute → Action.execute
  {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const edge = mi.find(
      (e) =>
        e.source === 'execute' &&
        e.target === 'execute' &&
        e.sourceFilePath.includes('LogEvent') &&
        e.targetFilePath.includes('Action'),
    );
    assert.notEqual(edge, undefined);
  }
  // emits METHOD_IMPLEMENTS edges from SendEmail.execute → Action.execute
  {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const edge = mi.find(
      (e) =>
        e.source === 'execute' &&
        e.target === 'execute' &&
        e.sourceFilePath.includes('SendEmail') &&
        e.targetFilePath.includes('Action'),
    );
    assert.notEqual(edge, undefined);
  }
  // emits METHOD_IMPLEMENTS for priority() in both implementors
  {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const priorityEdges = mi.filter(
      (e) =>
        e.source === 'priority' && e.target === 'priority' && e.targetFilePath.includes('Action'),
    );
    assert.equal(priorityEdges.length, 2);
    const sourceFiles = priorityEdges.map((e) => e.sourceFilePath).sort(compareCodeUnits);
    assert.equal(
      sourceFiles.some((f) => f.includes('LogEvent')),
      true,
    );
    assert.equal(
      sourceFiles.some((f) => f.includes('SendEmail')),
      true,
    );
  }
}
async function verifyJavaOverloadedMethodDisambiguationMETHODIMPLEMENTS() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-overload-dispatch'), () => {});
  // detects distinct Method nodes for overloaded find methods on SqlRepository
  {
    const methods = getNodesByLabelFull(result, 'Method');
    const findMethods = methods.filter(
      (m) => m.name === 'find' && m.properties.filePath?.includes('SqlRepository'),
    );
    assert.equal(findMethods.length, 2);
    const paramCounts = findMethods
      .map((m) => m.properties.parameterCount)
      .sort((left, right) => left - right);
    assert.deepEqual(paramCounts, [1, 2]);
  }
  // detects distinct Method nodes for overloaded find methods on Repository interface
  {
    const methods = getNodesByLabelFull(result, 'Method');
    const findMethods = methods.filter(
      (m) =>
        m.name === 'find' &&
        m.properties.filePath?.includes('Repository') &&
        !m.properties.filePath?.includes('SqlRepository'),
    );
    assert.equal(findMethods.length, 2);
    const paramCounts = findMethods
      .map((m) => m.properties.parameterCount)
      .sort((left, right) => left - right);
    assert.deepEqual(paramCounts, [1, 2]);
  }
  // emits METHOD_IMPLEMENTS for find(int) → Repository.find(int)
  {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const edge = mi.find(
      (e) =>
        e.source === 'find' &&
        e.target === 'find' &&
        e.sourceFilePath.includes('SqlRepository') &&
        e.targetFilePath.includes('Repository'),
    );
    assert.notEqual(edge, undefined);
    const findEdges = mi.filter(
      (e) =>
        e.source === 'find' &&
        e.target === 'find' &&
        e.sourceFilePath.includes('SqlRepository') &&
        e.targetFilePath.includes('Repository'),
    );
    const sourceNodes = findEdges.map((e) => {
      const methods = getNodesByLabelFull(result, 'Method');
      return methods.find(
        (m) =>
          m.name === 'find' &&
          m.properties.filePath?.includes('SqlRepository') &&
          m.properties.parameterCount === 1,
      );
    });
    assert.equal(
      sourceNodes.some((n) => n !== void 0),
      true,
    );
  }
  // emits METHOD_IMPLEMENTS for find(String, boolean) → Repository.find(String, boolean)
  {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const findEdges = mi.filter(
      (e) =>
        e.source === 'find' &&
        e.target === 'find' &&
        e.sourceFilePath.includes('SqlRepository') &&
        e.targetFilePath.includes('Repository'),
    );
    assert.equal(findEdges.length, 2);
  }
  // emits METHOD_IMPLEMENTS for save(String) → Repository.save(String)
  {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const edge = mi.find(
      (e) =>
        e.source === 'save' &&
        e.target === 'save' &&
        e.sourceFilePath.includes('SqlRepository') &&
        e.targetFilePath.includes('Repository'),
    );
    assert.notEqual(edge, undefined);
  }
  // emits exactly 3 METHOD_IMPLEMENTS edges
  {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const edges = mi.filter(
      (e) => e.sourceFilePath.includes('SqlRepository') && e.targetFilePath.includes('Repository'),
    );
    assert.equal(edges.length, 3);
  }
}
async function verifyJavaSameArityOverloadsWorkerPath() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-same-arity-cross-file'), () => {});
  // produces distinct graph nodes for find(int) and find(String)
  {
    const methods = getNodesByLabelFull(result, 'Method');
    const findNodes = methods.filter(
      (m) => m.name === 'find' && m.properties.filePath?.includes('DbLookup'),
    );
    assert.equal(findNodes.length, 2);
    const types = findNodes.map((n) => n.properties.parameterTypes).sort(compareParameterTypes);
    assert.deepEqual(types, [['String'], ['int']]);
  }
  // METHOD_IMPLEMENTS edges match interface methods — sequential path
  {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const edges = mi.filter(
      (e) =>
        e.source === 'find' &&
        e.target === 'find' &&
        e.sourceFilePath.includes('DbLookup') &&
        e.targetFilePath.includes('ILookup'),
    );
    assert.equal(edges.length, 2);
    for (const edge of edges) {
      const sourceNode = result.graph.getNode(edge.rel.sourceId);
      const targetNode = result.graph.getNode(edge.rel.targetId);
      assert.deepEqual(
        sourceNode?.properties.parameterTypes,
        targetNode?.properties.parameterTypes,
      );
    }
  }
}
async function verifyCrossClassMethodChainResolutionJava575() {
  let result;
  result = await runPipelineFromRepo(
    path.join(FIXTURES, 'java-method-chain-cross-class'),
    () => {},
  );
  // detects classes: Address, App, City, User
  {
    assert.deepEqual(getNodesByLabel(result, 'Class'), ['Address', 'App', 'City', 'User']);
  }
  // two-step chain: user.getAddress().save() → Address#save
  {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'save' && e.source === 'twoStepChain');
    assert.equal(saveCalls.length, 1);
    assert.ok(saveCalls[0].targetFilePath.includes('Address'));
  }
  // two-step chain: user.getAddress().save() also emits CALLS to User#getAddress
  {
    const calls = getRelationships(result, 'CALLS');
    const getAddressCalls = calls.filter(
      (e) => e.target === 'getAddress' && e.source === 'twoStepChain',
    );
    assert.equal(getAddressCalls.length, 1);
    assert.ok(getAddressCalls[0].targetFilePath.includes('User'));
  }
  // three-step chain: user.getAddress().getCity().getZipCode() → City#getZipCode
  {
    const calls = getRelationships(result, 'CALLS');
    const zipCalls = calls.filter(
      (e) => e.target === 'getZipCode' && e.source === 'threeStepChain',
    );
    assert.equal(zipCalls.length, 1);
    assert.ok(zipCalls[0].targetFilePath.includes('City'));
  }

  // mixed chain: user.getAddress().city.getZipCode() → City#getZipCode
  {
    const calls = getRelationships(result, 'CALLS');
    const zipCalls = calls.filter((e) => e.target === 'getZipCode' && e.source === 'mixedChain');
    assert.equal(zipCalls.length, 1);
    assert.ok(zipCalls[0].targetFilePath.includes('City'));
  }
  // mixed chain emits ACCESSES edge for field step: .city on Address
  {
    const accesses = getRelationships(result, 'ACCESSES');
    const cityAccess = accesses.filter((e) => e.target === 'city' && e.source === 'mixedChain');
    assert.equal(cityAccess.length, 1);
  }
}
async function verifyJavaCastReceiverResolution() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-cast-receiver'), () => {});
  // detects the caller plus target and decoy classes
  {
    assert.deepEqual(getNodesByLabel(result, 'Class'), [
      'App',
      'Box',
      'Fallback',
      'Shape',
      'Target',
      'Wrapper',
    ]);
  }

  // does not emit an open() edge to the decoy Wrapper
  {
    const calls = getRelationships(result, 'CALLS');
    assert.equal(
      calls.some((c) => c.target === 'open' && c.targetFilePath === 'models/Wrapper.java'),
      false,
    );
  }

  // does not emit a render() edge to the inner cast or to the decoy Shape (expr declared type)
  {
    const calls = getRelationships(result, 'CALLS');
    assert.equal(
      calls.some((c) => c.target === 'render' && c.targetFilePath === 'models/Shape.java'),
      false,
    );
  }

  // does not emit a draw() edge to the decoy Shape (field declared type)
  {
    const calls = getRelationships(result, 'CALLS');
    assert.equal(
      calls.some((c) => c.target === 'draw' && c.targetFilePath === 'models/Shape.java'),
      false,
    );
  }
  // does not fall back to the pre-cast type for an unindexed String receiver
  {
    const calls = getRelationships(result, 'CALLS');
    const actCall = calls.find((c) => c.target === 'act' && c.source === 'castUnindexedType');
    assert.equal(actCall, undefined);
  }
}
async function verifyJavaUnparseableCastReceiverResolution() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-cast-receiver'), () => {});
  const callTargets = (source, target) =>
    getRelationships(result, 'CALLS')
      .filter((c) => c.source === source && c.target === target)
      .map((c) => `${c.source} \u2192 ${c.target} @ ${c.targetFilePath}`);
  // emits no open() edge for a generic cast ((Box<String>) obj) — declared-type decoy Wrapper
  {
    assert.deepEqual(callTargets('castGeneric', 'open'), []);
  }
  // emits no act2() edge for an array cast ((Box[]) obj) — declared-type decoy Wrapper
  {
    assert.deepEqual(callTargets('castArray', 'act2'), []);
  }
  // emits no act3() edge for a fully-qualified cast ((models.Box) obj) — declared-type decoy Wrapper
  {
    assert.deepEqual(callTargets('castQualified', 'act3'), []);
  }
  // emits no act4() edge for a generic-FQN cast over this.field — field declared-type decoy Shape
  {
    assert.deepEqual(callTargets('castGenericFqnThisField', 'act4'), []);
  }
  // leaves a non-cast parenthesized receiver untouched — no crash, no fabricated edge
  {
    const fromNonCast = getRelationships(result, 'CALLS')
      .filter((c) => c.source === 'nonCastParen')
      .map((c) => `${c.source} \u2192 ${c.target} @ ${c.targetFilePath}`);
    assert.deepEqual(fromNonCast, []);
  }
}
async function verifyJavaBareThisDispatchCase4Pinning() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-this-dispatch'), () => {});
  // resolves this.greet("world") to the inherited Base.greet(String)
  {
    const calls = getRelationships(result, 'CALLS');
    const greetEdges = [
      ...new Set(
        calls
          .filter((c) => c.source === 'announce' && c.target === 'greet')
          .map((c) => `${c.targetFilePath} reason=${c.rel.reason}`),
      ),
    ].sort(compareCodeUnits);
    assert.deepEqual(greetEdges, ['models/Base.java reason=import-resolved']);
  }
  // pins the this.size field read to the size() Method node (methods-shadow-fields)
  {
    const accesses = getRelationships(result, 'ACCESSES');
    const sizeReads = accesses.filter((e) => e.source === 'describe' && e.target === 'size');
    assert.equal(sizeReads.length, 1);
    assert.equal(sizeReads[0].rel.reason, 'read');
    assert.equal(sizeReads[0].targetLabel, 'Method');
    assert.equal(sizeReads[0].targetFilePath, 'models/Widget.java');
  }
  // emits the primary this.run() edge from the default method to Task.run
  {
    const calls = getRelationships(result, 'CALLS');
    const primaries = [
      ...new Set(
        calls
          .filter(
            (c) =>
              c.source === 'runAll' && c.target === 'run' && c.rel.reason !== 'interface-dispatch',
          )
          .map((c) => c.targetFilePath),
      ),
    ].sort(compareCodeUnits);
    assert.deepEqual(primaries, ['models/Task.java']);
  }
  // fans this.run() out to exactly the implementors via interface-dispatch edges
  {
    const calls = getRelationships(result, 'CALLS');
    const fanout = [
      ...new Set(
        calls
          .filter((c) => c.source === 'runAll' && c.rel.reason === 'interface-dispatch')
          .map((c) => c.targetFilePath),
      ),
    ].sort(compareCodeUnits);
    assert.deepEqual(fanout, ['models/FastTask.java', 'models/SlowTask.java']);
  }
  // interface-dispatch fan-out excludes the interface itself and the non-implementor Runner
  {
    const calls = getRelationships(result, 'CALLS');
    const fanout = calls.filter((c) => c.rel.reason === 'interface-dispatch');
    for (const edge of fanout) {
      assert.notEqual(edge.targetFilePath, 'models/Task.java');
      assert.notEqual(edge.targetFilePath, 'models/Runner.java');
    }
  }
}
async function verifyJavaAnonymousClassInstanceIdentity2550() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-anonymous-class-scope'), () => {});
  // emits a Class node Worker$1 for the anonymous Runnable body
  {
    assert.ok(getNodesByLabel(result, 'Class').includes('Worker$1'));
  }
  // re-keys the anonymous run method to Worker$1.run and owns it via HAS_METHOD
  {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const owned = hasMethod.find(
      (e) =>
        e.rel.sourceId === 'Class:src/Worker.java:Worker$1' &&
        e.rel.targetId === 'Method:src/Worker.java:Worker$1.run#0',
    );
    assert.notEqual(owned, undefined);
  }
  // still extracts the anonymous Runnable method as a Method
  {
    assert.ok(getNodesByLabel(result, 'Method').includes('run'));
  }
  // resolves handler.run() to Worker$1.run via the receiver path, not the free-call leak
  {
    const calls = getRelationships(result, 'CALLS');
    const explicit = calls.find((c) => c.source === 'makeHandler' && c.target === 'run');
    assert.notEqual(explicit, undefined);
    assert.equal(explicit.rel.targetId, 'Method:src/Worker.java:Worker$1.run#0');
    assert.notEqual(explicit.rel.reason, 'local-call');
  }
  // does not resolve process()'s bare run() to the anonymous class's method (any reason)
  {
    const calls = getRelationships(result, 'CALLS');
    const leaked = calls.find((c) => c.source === 'process' && c.target === 'run');
    assert.equal(leaked, undefined);
  }
}
async function verifyJavaInstanceOwnershipFreeCallGate2550() {
  // does not resolve a bare call to an unrelated same-file class's method
  {
    const result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-unrelated-method-collision'),
      () => {},
    );
    const calls = getRelationships(result, 'CALLS');
    const leaked = calls.find((c) => c.source === 'work' && c.target === 'helper');
    assert.equal(leaked, undefined);
  }
  // still resolves a class's own bare call to its own method (implicit this)
  {
    const result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-builtin-name-legit-dispatch'),
      () => {},
    );
    const calls = getRelationships(result, 'CALLS');
    const legitimate = calls.find((c) => c.source === 'trigger' && c.target === 'run');
    assert.notEqual(legitimate, undefined);
    assert.equal(legitimate.targetFilePath, 'src/RealTask.java');
  }
  // still resolves a bare inherited call through the MRO arm
  {
    const result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-inherited-bare-call'),
      () => {},
    );
    const calls = getRelationships(result, 'CALLS');
    const inherited = calls.find((c) => c.source === 'go' && c.target === 'log');
    assert.notEqual(inherited, undefined);
  }
}
async function verifyJavaLocalTypeIdentityAndLexicalScope2562() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-local-class-naming'), () => {});
  // emits the correct graph label and owner for every local type kind
  {
    assert.ok(getNodesByLabel(result, 'Enum').includes('Types$1E'));
    assert.ok(getNodesByLabel(result, 'Record').includes('Types$1R'));
    assert.ok(getNodesByLabel(result, 'Interface').includes('Types$1I'));
    assert.ok(!getNodesByLabel(result, 'Class').includes('Types$1E'));
    assert.ok(!getNodesByLabel(result, 'Class').includes('Types$1R'));
    assert.ok(!getNodesByLabel(result, 'Class').includes('Types$1I'));
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    for (const [label, owner, method] of [
      ['Class', 'Outer$1Local', 'inner'],
      ['Class', 'Outer$2Local', 'inner'],
      ['Class', 'Outer$1CtorHost$1Local', 'inner'],
      ['Class', 'Outer$1NestedHost$Member', 'make'],
      ['Enum', 'Types$1E', 'enumHit'],
      ['Record', 'Types$1R', 'recordHit'],
      ['Interface', 'Types$1I', 'run'],
    ]) {
      assert.equal(
        hasMethod.some(
          (edge) =>
            edge.rel.sourceId ===
              `${label}:src/${owner.startsWith('Types') ? 'Types' : 'Outer'}.java:${owner}` &&
            edge.rel.targetId ===
              `Method:src/${owner.startsWith('Types') ? 'Types' : 'Outer'}.java:${owner}.${method}#0`,
        ),
        true,
      );
    }
  }
  // keeps source-level construction dispatch bound to each local identity
  {
    const calls = getRelationships(result, 'CALLS');
    assert.equal(
      calls.find((c) => c.source === 'first' && c.target === 'inner')?.rel.targetId,
      'Method:src/Outer.java:Outer$1Local.inner#0',
    );
    assert.equal(
      calls.find((c) => c.source === 'second' && c.target === 'inner')?.rel.targetId,
      'Method:src/Outer.java:Outer$2Local.inner#0',
    );
    assert.equal(
      calls.find((c) => c.source === 'CtorHost' && c.target === 'inner')?.rel.targetId,
      'Method:src/Outer.java:Outer$1CtorHost$1Local.inner#0',
    );
    for (const targetId of [
      'Method:src/Outer.java:Outer$1StaticLocal.staticHit#0',
      'Method:src/Outer.java:Outer$1InstanceLocal.instanceHit#0',
      'Method:src/Outer.java:Outer$1LambdaLocal.lambdaHit#0',
      'Method:src/Outer.java:Outer$3$1Local.anonymousHit#0',
      'Method:src/Outer.java:Outer$MemberHost$1Local.ordinaryMemberHit#0',
      'Method:src/Compact.java:Compact$1Local.inner#0',
      'Method:src/Types.java:Types$1E.enumHit#0',
      'Method:src/Types.java:Types$1R.recordHit#0',
      'Method:src/Types.java:Types$1.run#0',
    ]) {
      assert.equal(
        calls.some((call) => call.rel.targetId === targetId),
        true,
        targetId,
      );
    }
  }
}
async function verifyJavaAnonymousClassInheritanceAndHostCoverage2550() {
  // anon extending a same-file class keeps bare inherited calls and gains an EXTENDS edge
  {
    const result = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-anon-extends-base'),
      () => {},
    );
    const extends_ = getRelationships(result, 'EXTENDS');
    const anonExtends = extends_.find(
      (e) => e.rel.sourceId === 'Class:src/App.java:AnonExtHost$1' && e.target === 'Base',
    );
    assert.notEqual(anonExtends, undefined);
    const calls = getRelationships(result, 'CALLS');
    const inherited = calls.find((c) => c.source === 'extra' && c.target === 'work');
    assert.notEqual(inherited, undefined);
    assert.equal(inherited.rel.targetId, 'Method:src/App.java:Base.work#0');
  }
  // enum-hosted anonymous body is modeled (EnumHost$1) with no phantom constructed-type Class
  {
    const result = await runPipelineFromRepo(path.join(FIXTURES, 'java-anon-enum-host'), () => {});
    const classes = getNodesByLabel(result, 'Class');
    assert.ok(classes.includes('EnumHost$1'));
    assert.ok(!classes.includes('Runnable'));
    const calls = getRelationships(result, 'CALLS');
    const own = calls.find((c) => c.source === 'caller' && c.target === 'run');
    assert.notEqual(own, undefined);
    assert.equal(own.rel.targetId, 'Method:src/EnumHost.java:EnumHost.run#0');
  }
}
async function verifyJavaEnumConstantBodies2555() {
  let result;
  result = await runPipelineFromRepo(path.join(FIXTURES, 'java-enum-constant-body'), () => {});
  // models constant bodies as EnumConst$1 / EnumConst$2 with owned re-keyed methods
  {
    const classes = getNodesByLabel(result, 'Class');
    assert.ok(classes.includes('EnumConst$1'));
    assert.ok(classes.includes('EnumConst$2'));
    assert.ok(!classes.includes('A'));
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const owned = hasMethod.find(
      (e) =>
        e.rel.sourceId === 'Class:src/EnumConst.java:EnumConst$1' &&
        e.rel.targetId === 'Method:src/EnumConst.java:EnumConst$1.hook#0',
    );
    assert.notEqual(owned, undefined);
  }
  // emits EXTENDS from each constant body to the host enum
  {
    const extends_ = getRelationships(result, 'EXTENDS');
    const first = extends_.find(
      (e) => e.rel.sourceId === 'Class:src/EnumConst.java:EnumConst$1' && e.target === 'EnumConst',
    );
    assert.notEqual(first, undefined);
  }

  // does not resolve an unrelated same-file class's bare hook() to any constant body
  {
    const calls = getRelationships(result, 'CALLS');
    const leaked = calls.find((c) => c.source === 'caller' && c.target === 'hook');
    assert.equal(leaked, undefined);
  }
  // chains through enum constant bodies: anon inside a constant body is N$1$1
  {
    const result2 = await runPipelineFromRepo(
      path.join(FIXTURES, 'java-anon-in-constant-body'),
      () => {},
    );
    const classes = getNodesByLabel(result2, 'Class');
    assert.ok(classes.includes('N$1'));
    assert.ok(classes.includes('N$1$1'));
    assert.ok(!classes.includes('N$2'));
    const hasMethod = getRelationships(result2, 'HAS_METHOD');
    const owned = hasMethod.find(
      (e) =>
        e.rel.sourceId === 'Class:src/N.java:N$1$1' &&
        e.rel.targetId === 'Method:src/N.java:N$1$1.run#0',
    );
    assert.notEqual(owned, undefined);
  }
}

async function verifyJavaReceiverUnresolvedDropsNameTheProgramBoundary() {
  let repoDir;
  let result;
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-java-receiver-origin-'));
  copyResolutionProject(repoDir, 'receiver-program-boundary');
  result = await runPipelineFromRepo(repoDir, () => {}, {});
  try {
    // marks a System.out.println(...) drop external
    {
      const drops = getResolutionOutcomes(result).filter(
        (outcome) => outcome.kind === 'suppressed' && outcome.reason === 'receiver-unresolved',
      );
      assert.ok(
        drops.some(
          (item) =>
            item?.name === 'println' &&
            item?.siteKind === 'call' &&
            item?.receiverOrigin === 'external',
        ),
      );
    }
    // does not mark a drop on an undeclared user receiver external
    {
      const drops = getResolutionOutcomes(result).filter(
        (outcome) => outcome.kind === 'suppressed' && outcome.reason === 'receiver-unresolved',
      );
      assert.ok(
        drops.some(
          (item) =>
            item?.name === 'save' &&
            item?.siteKind === 'call' &&
            item?.receiverOrigin === 'unknown',
        ),
      );
      assert.ok(
        !drops.some((item) => item?.name === 'save' && item?.receiverOrigin === 'external'),
      );
    }
  } finally {
    if (repoDir !== void 0)
      fs.rmSync(repoDir, {
        recursive: true,
        force: true,
      });
  }
}
export async function checkGraphContracts() {
  await verifyJavaHeritageResolution();
  await verifyJavaQualifiedBaseHeritageResolution1956U2();
  await verifyJavaAmbiguousSymbolResolution();
  await verifyJavaCallResolutionWithArityFiltering();
  await verifyJavaSameModulePriorityForDuplicateFQNs();
  await verifyJavaMemberCallResolution();
  await verifyJavaDeclaredPackageImportResolution2910();
  await verifyJavaVariadicCallResolution();
  await verifyJavaWildcardImportResolution();
  await verifyJavaOnDemandImportEdges();
  await verifyJavaRecordMethodResolution2564();
  await verifyJavaEnumInterfaceHeritage2918();
  await verifyFieldTypeResolutionJava();
  await verifyDeepFieldChainResolutionJava();
  await verifyMixedFieldCallChainResolutionJava();
  await verifyWriteAccessTrackingJava();
  await verifyJavaImportOfATypeDeclaredUnderSeveral();
  await verifyJavaOverloadDisambiguationByParameterTypes();
  await verifyJavaSameArityOverloadCrossFileAndChain();
  await verifyJavaVirtualDispatchViaConstructorTypeSameFile();
  await verifyJavaCrossFileBindingPropagation();
  await verifyJavaMethodEnrichment();
  await verifyJavaInterfaceDispatchMETHODIMPLEMENTS();
  await verifyJavaOverloadedMethodDisambiguationMETHODIMPLEMENTS();
  await verifyJavaSameArityOverloadsWorkerPath();
  await verifyCrossClassMethodChainResolutionJava575();
  await verifyJavaCastReceiverResolution();
  await verifyJavaUnparseableCastReceiverResolution();
  await verifyJavaBareThisDispatchCase4Pinning();
  await verifyJavaAnonymousClassInstanceIdentity2550();
  await verifyJavaInstanceOwnershipFreeCallGate2550();
  await verifyJavaLocalTypeIdentityAndLexicalScope2562();
  await verifyJavaAnonymousClassInheritanceAndHostCoverage2550();
  await verifyJavaEnumConstantBodies2555();

  await verifyJavaReceiverUnresolvedDropsNameTheProgramBoundary();
}
