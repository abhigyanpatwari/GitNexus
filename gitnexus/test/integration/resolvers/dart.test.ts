/**
 * Dart: field-type resolution and call-result binding.
 * Verifies that class fields are captured as Property nodes with HAS_PROPERTY
 * edges, and that calls (including chained and call-result-bound) are resolved.
 *
 * All Dart pipeline features are covered: Property nodes, HAS_PROPERTY edges,
 * CALLS chain resolution, IMPORTS, call attribution, and ACCESSES field reads.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  edgeSet,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';
import {
  isLanguageAvailable,
  loadParser,
  loadLanguage,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

// isLanguageAvailable only checks whether the module loaded — it does NOT verify
// that the native binary works at runtime (tree-sitter-dart can fail on setLanguage).
// Probe the parser to get a reliable skip guard.
let dartAvailable = isLanguageAvailable(SupportedLanguages.Dart);
if (dartAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Dart);
  } catch {
    dartAvailable = false;
  }
}

// ── Phase 8: Field-type resolution ──────────────────────────────────────

describe.skipIf(!dartAvailable)('Dart field-type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'dart-field-types'), () => {});
  }, 60000);

  it('detects classes and their properties', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(expect.arrayContaining(['Address', 'User']));
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('address');
    expect(properties).toContain('city');
    expect(properties).toContain('name');
  });

  it('emits HAS_PROPERTY edges from class to field', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(edgeSet(propEdges)).toEqual(
      expect.arrayContaining(['User → address', 'User → name', 'Address → city']),
    );
  });

  it('resolves save() call from field-chain user.address.save()', () => {
    const calls = getRelationships(result, 'CALLS');
    // Dart attributes calls to the enclosing Function
    const saveCalls = calls.filter(
      (c) => c.target === 'save' && c.sourceFilePath.includes('app.dart'),
    );
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0]!.targetFilePath).toContain('models.dart');
  });

  it('attributes save() call source to processUser, not File', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(
      (c) => c.target === 'save' && c.sourceFilePath.includes('app.dart'),
    );
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0]!.source).toBe('processUser');
    expect(saveCalls[0]!.sourceLabel).toBe('Function');
  });

  it('creates IMPORTS edge between app.dart and models.dart', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const appImports = imports.filter(
      (e) => e.sourceFilePath.includes('app.dart') && e.targetFilePath.includes('models.dart'),
    );
    expect(appImports.length).toBe(1);
  });

  it('emits ACCESSES edges for field reads in chains', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const addressReads = accesses.filter((e) => e.target === 'address' && e.rel.reason === 'read');
    expect(addressReads.length).toBe(1);
    expect(addressReads[0]!.source).toBe('processUser');
    expect(addressReads[0]!.targetLabel).toBe('Property');
  });
});

// ── Phase 9: Call-result binding ────────────────────────────────────────

describe.skipIf(!dartAvailable)('Dart call-result binding', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'dart-call-result-binding'), () => {});
  }, 60000);

  it('detects classes, methods, and functions', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Function')).toEqual(
      expect.arrayContaining(['getUser', 'processUser']),
    );
  });

  it('resolves save() call via call-result binding', () => {
    const calls = getRelationships(result, 'CALLS');
    // Dart attributes calls to the enclosing Function
    const saveCalls = calls.filter(
      (c) => c.target === 'save' && c.sourceFilePath.includes('app.dart'),
    );
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0]!.targetFilePath).toContain('models.dart');
  });

  it('resolves getUser() call', () => {
    const calls = getRelationships(result, 'CALLS');
    const getUserCalls = calls.filter(
      (c) => c.target === 'getUser' && c.sourceFilePath.includes('app.dart'),
    );
    expect(getUserCalls.length).toBe(1);
  });

  it('attributes calls to processUser, not File', () => {
    const calls = getRelationships(result, 'CALLS');
    const appCalls = calls.filter((c) => c.sourceFilePath.includes('app.dart'));
    for (const call of appCalls) {
      expect(call.source).toBe('processUser');
      expect(call.sourceLabel).toBe('Function');
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 16: Method enrichment (isAbstract, isStatic, annotations)
// animal.dart: abstract Animal with abstract speak(), static classify(), breathe()
// Dog extends Animal, @override speak()
// app.dart: dog.speak(), Animal.classify("dog")
// ---------------------------------------------------------------------------

describe.skipIf(!dartAvailable)('Dart method enrichment', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'dart-method-enrichment'), () => {});
  }, 60000);

  it('detects Animal and Dog classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Animal');
    expect(classes).toContain('Dog');
  });

  it('emits HAS_METHOD edges for Animal methods', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const animalMethods = hasMethod
      .filter((e) => e.source === 'Animal')
      .map((e) => e.target)
      .sort();
    expect(animalMethods).toContain('speak');
    expect(animalMethods).toContain('classify');
    expect(animalMethods).toContain('breathe');
  });

  it('emits HAS_METHOD edge for Dog.speak', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const dogSpeak = hasMethod.find((e) => e.source === 'Dog' && e.target === 'speak');
    expect(dogSpeak).toBeDefined();
  });

  it('emits EXTENDS edge Dog -> Animal', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const dogExtends = extends_.find((e) => e.source === 'Dog' && e.target === 'Animal');
    expect(dogExtends).toBeDefined();
  });

  it('marks abstract speak as isAbstract', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const speak = methods.find(
      (n) => n.name === 'speak' && n.properties.filePath === 'animal.dart',
    );
    expect(speak).toBeDefined();
    expect(speak!.properties.isAbstract).toBe(true);
  });

  it('marks breathe as NOT isAbstract', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const breathe = methods.find((n) => n.name === 'breathe');
    expect(breathe).toBeDefined();
    expect(breathe!.properties.isAbstract).toBe(false);
  });

  it('marks classify as isStatic', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const classify = methods.find((n) => n.name === 'classify');
    expect(classify).toBeDefined();
    expect(classify!.properties.isStatic).toBe(true);
  });

  it('marks breathe as NOT isStatic', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const breathe = methods.find((n) => n.name === 'breathe');
    expect(breathe).toBeDefined();
    expect(breathe!.properties.isStatic).toBe(false);
  });

  it('abstract Animal.speak has isAbstract=true and concrete breathe does not', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const speak = methods.find((n) => n.name === 'speak');
    expect(speak).toBeDefined();
    expect(speak!.properties.isAbstract).toBe(true);
    const breathe = methods.find((n) => n.name === 'breathe');
    expect(breathe).toBeDefined();
    expect(breathe!.properties.isAbstract).toBe(false);
  });

  it('populates parameterTypes for classify', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const classify = methods.find((n) => n.name === 'classify');
    expect(classify).toBeDefined();
    const params = classify!.properties.parameterTypes;
    expect(params).toContain('String');
  });

  it('resolves dog.speak() CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const speakCall = calls.find(
      (c) => c.target === 'speak' && c.sourceFilePath.includes('app.dart'),
    );
    expect(speakCall).toBeDefined();
  });

  it('resolves Animal.classify("dog") static CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const classifyCall = calls.find(
      (c) => c.target === 'classify' && c.sourceFilePath.includes('app.dart'),
    );
    expect(classifyCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Basic arity-based call resolution (Dart catch-up)
// one.dart: writeAudit(String message), zero.dart: writeAuditSimple()
// app.dart: writeAudit("hello"), writeAuditSimple()
// ---------------------------------------------------------------------------

describe.skipIf(!dartAvailable)('Dart calls', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'dart-calls'), () => {});
  }, 60000);

  it('detects top-level functions', () => {
    const functions = getNodesByLabel(result, 'Function');
    expect(functions).toContain('writeAudit');
    expect(functions).toContain('writeAuditSimple');
    expect(functions).toContain('run');
  });

  it('resolves writeAudit("hello") CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const auditCall = calls.find(
      (c) => c.target === 'writeAudit' && c.sourceFilePath.includes('app.dart'),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall!.targetFilePath).toContain('one.dart');
  });

  it('resolves writeAuditSimple() CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const simpleCall = calls.find(
      (c) => c.target === 'writeAuditSimple' && c.sourceFilePath.includes('app.dart'),
    );
    expect(simpleCall).toBeDefined();
    expect(simpleCall!.targetFilePath).toContain('zero.dart');
  });

  it('attributes calls to run, not File', () => {
    const calls = getRelationships(result, 'CALLS');
    const appCalls = calls.filter((c) => c.sourceFilePath.includes('app.dart'));
    for (const call of appCalls) {
      expect(call.source).toBe('run');
      expect(call.sourceLabel).toBe('Function');
    }
  });

  it('creates IMPORTS edges from app.dart', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const appImports = imports.filter((e) => e.sourceFilePath.includes('app.dart'));
    const targetFiles = appImports.map((e) => e.targetFilePath).sort();
    expect(targetFiles).toEqual(expect.arrayContaining(['one.dart', 'zero.dart']));
  });
});

// ---------------------------------------------------------------------------
// Member calls: receiver-type resolution via constructor inference
// user.dart: User { save() }, app.dart: var user = User(); user.save()
// ---------------------------------------------------------------------------

describe.skipIf(!dartAvailable)('Dart member calls', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'dart-member-calls'), () => {});
  }, 60000);

  it('detects User class and save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Function')).toContain('processUser');
  });

  it('emits HAS_METHOD edge User -> save', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const userSave = hasMethod.find((e) => e.source === 'User' && e.target === 'save');
    expect(userSave).toBeDefined();
  });

  it('resolves user.save() CALLS edge via constructor inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.sourceFilePath.includes('app.dart'),
    );
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toContain('user.dart');
  });

  it('attributes save() call to processUser, not File', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.sourceFilePath.includes('app.dart'),
    );
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processUser');
    expect(saveCall!.sourceLabel).toBe('Function');
  });

  it('creates IMPORTS edge from app.dart to user.dart', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const appImport = imports.find(
      (e) => e.sourceFilePath.includes('app.dart') && e.targetFilePath.includes('user.dart'),
    );
    expect(appImport).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Dart async / async* / sync* method detection
// Verifies isDartAsync correctly identifies all three async-like forms
// ---------------------------------------------------------------------------

describe.skipIf(!dartAvailable)('Dart async method detection', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'dart-async-methods'), () => {});
  }, 60000);

  it('detects DataService class', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('DataService');
  });

  it('emits HAS_METHOD edges for all DataService methods', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const methods = hasMethod
      .filter((e) => e.source === 'DataService')
      .map((e) => e.target)
      .sort();
    expect(methods).toContain('fetchUser');
    expect(methods).toContain('countUp');
    expect(methods).toContain('generateNames');
    expect(methods).toContain('formatName');
  });

  it('marks async method fetchUser as isAsync=true', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const fetchUser = methods.find((n) => n.name === 'fetchUser');
    expect(fetchUser).toBeDefined();
    expect(fetchUser!.properties.isAsync).toBe(true);
  });

  it('marks async* generator countUp as isAsync=true', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const countUp = methods.find((n) => n.name === 'countUp');
    expect(countUp).toBeDefined();
    expect(countUp!.properties.isAsync).toBe(true);
  });

  it('marks sync* generator generateNames as isAsync=true', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const generateNames = methods.find((n) => n.name === 'generateNames');
    expect(generateNames).toBeDefined();
    expect(generateNames!.properties.isAsync).toBe(true);
  });

  it('marks regular sync method formatName as isAsync=false', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const formatName = methods.find((n) => n.name === 'formatName');
    expect(formatName).toBeDefined();
    // buildMethodProps only sets isAsync when truthy; for sync methods the
    // property is absent (undefined), which is equivalent to false.
    expect(formatName!.properties.isAsync ?? false).toBe(false);
  });

  it('populates parameterTypes for fetchUser(int id)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const fetchUser = methods.find((n) => n.name === 'fetchUser');
    expect(fetchUser).toBeDefined();
    expect(fetchUser!.properties.parameterTypes).toContain('int');
  });

  it('populates returnType for formatName', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const formatName = methods.find((n) => n.name === 'formatName');
    expect(formatName).toBeDefined();
    expect(formatName!.properties.returnType).toBe('String');
  });
});

// ---------------------------------------------------------------------------
// Interface dispatch: METHOD_IMPLEMENTS edges from concrete → abstract methods
// abstract Repository with find/save, SqlRepository implements them
// ---------------------------------------------------------------------------

describe.skipIf(!dartAvailable)('Dart interface dispatch (METHOD_IMPLEMENTS)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'dart-interface-dispatch'), () => {});
  }, 60000);

  it('detects Repository class and SqlRepository class', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Repository');
    expect(classes).toContain('SqlRepository');
  });

  it('emits IMPLEMENTS edge SqlRepository → Repository', () => {
    const impl = getRelationships(result, 'IMPLEMENTS');
    const edge = impl.find((e) => e.source === 'SqlRepository' && e.target === 'Repository');
    expect(edge).toBeDefined();
  });

  it('emits METHOD_IMPLEMENTS edges for find and save', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const findEdge = mi.find(
      (e) =>
        e.source === 'find' &&
        e.target === 'find' &&
        e.sourceFilePath.includes('sql_repository') &&
        e.targetFilePath.includes('repository'),
    );
    const saveEdge = mi.find(
      (e) =>
        e.source === 'save' &&
        e.target === 'save' &&
        e.sourceFilePath.includes('sql_repository') &&
        e.targetFilePath.includes('repository'),
    );
    expect(findEdge).toBeDefined();
    expect(saveEdge).toBeDefined();
  });
});
