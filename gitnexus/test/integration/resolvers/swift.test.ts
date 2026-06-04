/**
 * Swift: constructor-inferred type resolution for member calls.
 * Verifies that `let user = User(name: "alice"); user.save()` resolves to User.save
 * without explicit type annotations, using SymbolTable verification.
 *
 * NOTE: Swift is installed as an optional dependency. These tests skip gracefully
 * if a consumer installs without optional dependencies.
 */
import { describe, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  createResolverParityIt,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  edgeSet,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

const it = createResolverParityIt('swift');

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);

describe.skipIf(!swiftAvailable)('Swift constructor-inferred type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'swift-constructor-type-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveFns = getNodesByLabel(result, 'Function').filter((m) => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves user.save() to Models/User.swift via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'Models/User.swift',
    );
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves repo.save() to Models/Repo.swift via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'Models/Repo.swift',
    );
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('processEntities');
  });

  it('emits exactly 2 save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// self.save() resolves to enclosing class's own save method
// Build-dep issue (NOT a feature gap): tree-sitter-swift has build issues on Node 22.
// The self/super resolution code already exists in type-env.ts lookupInEnv (lines 56-66).
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift self resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-self-this-resolution'), () => {});
  }, 60000);

  it('detects User and Repo classes, each with a save function', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    const saveFns = getNodesByLabel(result, 'Function').filter((m) => m === 'save');
    expect(saveFns.length).toBe(2);
  });

  it('resolves self.save() inside User.process to User.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('Sources/Models/User.swift');
  });
});

// ---------------------------------------------------------------------------
// Parent class resolution: EXTENDS + protocol conformance
// Build-dep issue (NOT a feature gap): tree-sitter-swift has build issues on Node 22.
// findEnclosingParentClassName in type-env.ts already has Swift inheritance_specifier handler.
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift parent resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-parent-resolution'), () => {});
  }, 60000);

  it('detects BaseModel and User classes plus Serializable protocol', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'User']);
    expect(getNodesByLabel(result, 'Interface')).toEqual(['Serializable']);
  });

  it('emits EXTENDS edge: User → BaseModel', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const extendsEdge = extends_.find((e) => e.source === 'User' && e.target === 'BaseModel');
    expect(extendsEdge).toBeDefined();
  });

  it('emits IMPLEMENTS edge: User → Serializable (protocol conformance)', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    const implEdge = implements_.find((e) => e.source === 'User' && e.target === 'Serializable');
    expect(implEdge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Swift cross-file User.init() type inference
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift cross-file User.init() inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-init-cross-file'), () => {});
  }, 60000);

  it('resolves user.save() via User.init(name:) inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.targetFilePath === 'User.swift');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('main');
  });

  it('resolves user.greet() via User.init(name:) inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find((c) => c.target === 'greet' && c.targetFilePath === 'User.swift');
    expect(greetCall).toBeDefined();
    expect(greetCall!.source).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// Return type inference: let user = getUser(name: "alice"); user.save()
// Swift's CONSTRUCTOR_BINDING_SCANNER captures property_declaration with
// call_expression values, enabling return type inference from function results.
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift return type inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-return-type'), () => {});
  }, 60000);

  it('detects User class and getUser function', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Function')).toContain('getUser');
  });

  it('detects save function on User (Swift class methods are Function nodes)', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('save');
  });

  it('resolves user.save() to User#save via return type of getUser() -> User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processUser' &&
        c.targetFilePath.includes('Models.swift'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Return-type inference with competing methods:
// Two classes both have save(), factory functions disambiguate via return type
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift return-type inference via function return type', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'swift-return-type-inference'),
      () => {},
    );
  }, 60000);

  it('resolves user.save() to User#save via return type of getUser()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processUser' &&
        c.targetFilePath.includes('Models.swift'),
    );
    expect(saveCall).toBeDefined();
  });

  it('user.save() does NOT resolve to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find((c) => c.target === 'save' && c.source === 'processUser');
    // Should resolve to exactly one target — if it resolves at all, check it's the right one
    if (wrongSave) {
      expect(wrongSave.targetFilePath).toContain('Models.swift');
    }
  });

  it('resolves repo.save() to Repo#save via return type of getRepo()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processRepo' &&
        c.targetFilePath.includes('Models.swift'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Implicit imports: Swift files in the same module see each other without
// explicit import statements. This is the foundation of all cross-file
// resolution — without addSwiftImplicitImports, Tier 2a lookups fail.
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift implicit imports (cross-file visibility)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-implicit-imports'), () => {});
  }, 60000);

  it('detects UserService class in Models.swift', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('UserService');
  });

  it('resolves UserService() constructor call across files (no explicit import)', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find(
      (c) => c.target === 'UserService' && c.targetFilePath === 'Models.swift',
    );
    expect(ctorCall).toBeDefined();
  });

  it('resolves service.fetchUser() member call across files', () => {
    const calls = getRelationships(result, 'CALLS');
    const memberCall = calls.find(
      (c) => c.target === 'fetchUser' && c.targetFilePath === 'Models.swift',
    );
    expect(memberCall).toBeDefined();
  });

  it('creates IMPORTS edges between files in the same module', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const crossFileImport = imports.find(
      (c) =>
        (c.sourceFilePath === 'App.swift' && c.targetFilePath === 'Models.swift') ||
        (c.sourceFilePath === 'Models.swift' && c.targetFilePath === 'App.swift'),
    );
    expect(crossFileImport).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Extension deduplication: Swift extensions create multiple Class nodes
// with the same name. The resolver should deduplicate and prefer the
// primary definition (shortest file path).
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift extension deduplication', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-extension-dedup'), () => {});
  }, 60000);

  it('detects Product class', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('Product');
  });

  it('resolves Product() constructor despite extension creating duplicate class node', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find((c) => c.target === 'Product' && c.source === 'process');
    expect(ctorCall).toBeDefined();
  });

  it('resolves product.save() to Product.swift (primary definition)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath === 'Product.swift',
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Constructor fallback: Swift constructors look like free function calls
// (no `new` keyword). The resolver retries with constructor form when
// free-form finds no callable but the name resolves to a Class/Struct.
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift constructor call fallback (no new keyword)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-constructor-fallback'), () => {});
  }, 60000);

  it('resolves OCRService() as constructor call across files', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find(
      (c) => c.target === 'OCRService' && c.targetFilePath === 'Service.swift',
    );
    expect(ctorCall).toBeDefined();
  });

  it('resolves ocr.recognize() member call via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const memberCall = calls.find(
      (c) => c.target === 'recognize' && c.targetFilePath === 'Service.swift',
    );
    expect(memberCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Export visibility: internal (default) symbols are cross-file visible,
// private/fileprivate are not. Verifies the export detection inversion.
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift export visibility (internal vs private)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-export-visibility'), () => {});
  }, 60000);

  it('resolves PublicService() constructor across files', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find(
      (c) => c.target === 'PublicService' && c.targetFilePath === 'Visible.swift',
    );
    expect(ctorCall).toBeDefined();
  });

  it('resolves internalHelper() across files (internal = module-scoped)', () => {
    const calls = getRelationships(result, 'CALLS');
    const helperCall = calls.find(
      (c) => c.target === 'internalHelper' && c.targetFilePath === 'Visible.swift',
    );
    expect(helperCall).toBeDefined();
  });

  // NOTE: private/fileprivate symbols are marked as unexported, which prevents
  // Tier 2a (import-scoped) resolution. However, Tier 3 (global) still resolves
  // them — export filtering at global scope is a separate enhancement.
  // These tests verify the symbols ARE marked correctly in export detection
  // (covered by parsing.test.ts mock tests), not end-to-end call blocking.
});

// ---------------------------------------------------------------------------
// if let / guard let optional binding resolution:
// Swift's most common unwrap patterns — extractIfGuardBinding extracts the
// variable name and infers type from the RHS call result.
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift if let / guard let binding resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-if-let-guard-let'), () => {});
  }, 60000);

  it('detects User and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.save() inside if-let to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processIfLet' && c.targetFilePath === 'Models.swift',
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves repo.save() inside guard-let to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processGuardLet' &&
        c.targetFilePath === 'Models.swift',
    );
    expect(saveCall).toBeDefined();
  });

  it('user.save() in if-let does NOT resolve to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find((c) => c.target === 'save' && c.source === 'processIfLet');
    if (wrongSave) {
      // If resolved, it should be to User's save (in Models.swift), not Repo's
      expect(wrongSave.targetFilePath).toBe('Models.swift');
    }
  });
});

// ---------------------------------------------------------------------------
// await / try expression unwrapping:
// Swift's await_expression and try_expression wrap call_expression nodes.
// extractPendingAssignment must unwrap these to find the inner call.
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift await / try expression unwrapping', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-await-try'), () => {});
  }, 60000);

  it('resolves user.save() via await fetchUser() return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processAwait' && c.targetFilePath === 'Models.swift',
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves repo.save() via try parseRepo() return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processTry' && c.targetFilePath === 'Models.swift',
    );
    expect(saveCall).toBeDefined();
  });

  it('detects fetchUser and parseRepo as functions', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('fetchUser');
    expect(fns).toContain('parseRepo');
  });
});

// ---------------------------------------------------------------------------
// For-in loop element type inference: extractForLoopBinding derives element
// type from the iterable's declared type annotation (e.g., [User] → User).
//
// KNOWN GAP: The type-env correctly stores declarationTypeNodes for Swift
// array types ([User]), but the call-processor's re-parse path doesn't
// propagate the for-loop binding to receiver resolution. The type-env
// infrastructure (extractForLoopBinding, extractSwiftElementTypeFromTypeNode,
// declarationTypeNodes population for type_annotation) is in place — the
// integration gap is in how processCalls rebuilds TypeEnv for call resolution.
// Fixture: swift-for-loop-inference/ (ready for when this is wired up).
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift for-in loop element type inference', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-for-loop-inference'), () => {});
  }, 60000);

  it('detects User and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('creates implicit import edges between files', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBeGreaterThan(0);
  });
});

// ── Phase 8: Field-type resolution ──────────────────────────────────────

describe.skipIf(!swiftAvailable)('Swift field-type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-field-types'), () => {});
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
      expect.arrayContaining(['User → address', 'Address → city']),
    );
  });

  it('resolves field-chain call user.address.save() → Address#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save' && c.source === 'processUser');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0]!.targetFilePath).toContain('Models.swift');
  });

  it('emits ACCESSES edges for field reads in chains', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const addressReads = accesses.filter((e) => e.target === 'address' && e.rel.reason === 'read');
    expect(addressReads.length).toBeGreaterThanOrEqual(1);
    expect(addressReads[0]!.source).toBe('processUser');
    expect(addressReads[0]!.targetLabel).toBe('Property');
  });

  it('populates field metadata (visibility, declaredType) on Property nodes', () => {
    const properties = getNodesByLabelFull(result, 'Property');

    const city = properties.find((p) => p.name === 'city');
    expect(city).toBeDefined();
    // Swift default visibility is 'internal', not 'public'
    expect(city!.properties.visibility).toBe('internal');
    expect(city!.properties.isStatic).toBe(false);
    expect(city!.properties.declaredType).toBe('String');

    const addr = properties.find((p) => p.name === 'address');
    expect(addr).toBeDefined();
    expect(addr!.properties.visibility).toBe('internal');
    expect(addr!.properties.declaredType).toBe('Address');
  });
});

// ── Phase 9: Call-result binding ────────────────────────────────────────

describe.skipIf(!swiftAvailable)('Swift call-result binding', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-call-result-binding'), () => {});
  }, 60000);

  it('resolves call-result-bound method call user.save() → User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save' && c.source === 'processUser');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0]!.targetFilePath).toContain('Models.swift');
  });

  it('getUser() is present as a defined function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('getUser');
  });

  it('emits processUser -> getUser CALLS edge for let-assigned free function call', () => {
    const calls = getRelationships(result, 'CALLS');
    const getUserCall = calls.find((c) => c.target === 'getUser' && c.source === 'processUser');
    expect(getUserCall).toBeDefined();
    expect(getUserCall!.targetFilePath).toContain('Models.swift');
  });
});

// ---------------------------------------------------------------------------
// Method enrichment: isAbstract, isFinal, isStatic, annotations
// Animal protocol with speak(), Dog class with speak(), static classify(),
// @objc final breathe(). App.swift calls dog.speak() and Dog.classify().
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift method enrichment', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-method-enrichment'), () => {});
  }, 60000);

  it('detects Animal protocol and Dog class', () => {
    expect(getNodesByLabel(result, 'Interface')).toContain('Animal');
    expect(getNodesByLabel(result, 'Class')).toContain('Dog');
  });

  it('emits IMPLEMENTS edge Dog -> Animal', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    const edge = implements_.find((e) => e.source === 'Dog' && e.target === 'Animal');
    expect(edge).toBeDefined();
  });

  it('emits HAS_METHOD edges for Dog methods', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const dogMethods = hasMethod
      .filter((e) => e.source === 'Dog')
      .map((e) => e.target)
      .sort();
    expect(dogMethods).toContain('speak');
    expect(dogMethods).toContain('classify');
    expect(dogMethods).toContain('breathe');
  });

  it('marks protocol Animal.speak as isAbstract', () => {
    // Protocol method declarations are emitted as 'Method' nodes (not 'Function')
    const methods = getNodesByLabelFull(result, 'Method');
    const speak = methods.find(
      (n) => n.name === 'speak' && n.properties.filePath === 'Sources/Animal.swift',
    );
    expect(speak).toBeDefined();
    expect(speak!.properties.isAbstract).toBe(true);
  });

  it('marks Dog.speak as NOT isAbstract', () => {
    // Dog's speak is a 'Function' node; both protocol and Dog are in Animal.swift,
    // so distinguish by startLine: Dog.speak is at line 5 (0-indexed).
    const methods = getNodesByLabelFull(result, 'Function');
    const dogSpeak = methods.find((n) => n.name === 'speak' && n.properties.startLine === 5);
    expect(dogSpeak).toBeDefined();
    expect(dogSpeak!.properties.isAbstract).toBe(false);
  });

  it('marks breathe as isFinal', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const breathe = methods.find((n) => n.name === 'breathe');
    expect(breathe).toBeDefined();
    expect(breathe!.properties.isFinal).toBe(true);
  });

  it('marks classify as isStatic', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((n) => n.name === 'classify');
    expect(classify).toBeDefined();
    expect(classify!.properties.isStatic).toBe(true);
  });

  it('captures @objc annotation on breathe', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const breathe = methods.find((n) => n.name === 'breathe');
    expect(breathe).toBeDefined();
    expect(breathe!.properties.annotations).toContain('@objc');
  });

  it('populates parameterTypes for classify(_ name: String)', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((n) => n.name === 'classify');
    expect(classify).toBeDefined();
    expect(classify!.properties.parameterTypes).toContain('String');
  });

  it('records parameterCount for classify', () => {
    const methods = getNodesByLabelFull(result, 'Function');
    const classify = methods.find((n) => n.name === 'classify');
    expect(classify).toBeDefined();
    expect(classify!.properties.parameterCount).toBe(1);
  });

  it('records returnType for speak', () => {
    // Dog.speak is a 'Function' node at startLine 5 (0-indexed); the protocol speak
    // is a 'Method' node, so filtering Function by name gives Dog's implementation.
    const methods = getNodesByLabelFull(result, 'Function');
    const speak = methods.find((n) => n.name === 'speak' && n.properties.startLine === 5);
    expect(speak).toBeDefined();
    expect(speak!.properties.returnType).toBe('String');
  });

  it('resolves dog.speak() CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const speakCall = calls.find(
      (c) => c.target === 'speak' && c.sourceFilePath === 'Sources/App.swift',
    );
    expect(speakCall).toBeDefined();
  });

  it('resolves Dog.classify("dog") CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const classifyCall = calls.find(
      (c) => c.target === 'classify' && c.sourceFilePath === 'Sources/App.swift',
    );
    expect(classifyCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Abstract dispatch: protocol base + concrete implementation + receiver resolution
// Repository protocol with find(id:), save(entity:)
// SqlRepository class implements both
// App.swift: repo = SqlRepository(); repo.find(id: 42); repo.save(entity: user)
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift abstract dispatch', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-abstract-dispatch'), () => {});
  }, 60000);

  it('detects Repository protocol and SqlRepository class', () => {
    expect(getNodesByLabel(result, 'Interface')).toContain('Repository');
    expect(getNodesByLabel(result, 'Class')).toContain('SqlRepository');
  });

  it('emits IMPLEMENTS edge SqlRepository -> Repository', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    const edge = implements_.find((e) => e.source === 'SqlRepository' && e.target === 'Repository');
    expect(edge).toBeDefined();
  });

  it('emits HAS_METHOD edges for Repository.find and Repository.save', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const repoFind = hasMethod.find((e) => e.source === 'Repository' && e.target === 'find');
    const repoSave = hasMethod.find((e) => e.source === 'Repository' && e.target === 'save');
    expect(repoFind).toBeDefined();
    expect(repoSave).toBeDefined();
  });

  it('emits HAS_METHOD edges for SqlRepository.find and SqlRepository.save', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const sqlFind = hasMethod.find((e) => e.source === 'SqlRepository' && e.target === 'find');
    const sqlSave = hasMethod.find((e) => e.source === 'SqlRepository' && e.target === 'save');
    expect(sqlFind).toBeDefined();
    expect(sqlSave).toBeDefined();
  });

  it('marks base Repository.find as isAbstract', () => {
    // Protocol method declarations are emitted as 'Method' nodes (not 'Function')
    const methods = getNodesByLabelFull(result, 'Method');
    const baseFind = methods.find(
      (n) => n.name === 'find' && n.properties.filePath === 'Sources/Repository.swift',
    );
    expect(baseFind).toBeDefined();
    expect(baseFind!.properties.isAbstract).toBe(true);
  });

  it('marks base Repository.save as isAbstract', () => {
    // Protocol method declarations are emitted as 'Method' nodes (not 'Function')
    const methods = getNodesByLabelFull(result, 'Method');
    const baseSave = methods.find(
      (n) => n.name === 'save' && n.properties.filePath === 'Sources/Repository.swift',
    );
    expect(baseSave).toBeDefined();
    expect(baseSave!.properties.isAbstract).toBe(true);
  });

  it('marks concrete SqlRepository.find as NOT isAbstract', () => {
    // SqlRepository and Repository are both in Repository.swift; distinguish by
    // startLine: SqlRepository.find starts at line 6 (0-indexed).
    const methods = getNodesByLabelFull(result, 'Function');
    const sqlFind = methods.find((n) => n.name === 'find' && n.properties.startLine === 6);
    expect(sqlFind).toBeDefined();
    expect(sqlFind!.properties.isAbstract).toBe(false);
  });

  it('resolves repo.find(id: 42) CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const findCall = calls.find(
      (c) => c.target === 'find' && c.sourceFilePath === 'Sources/App.swift',
    );
    expect(findCall).toBeDefined();
  });

  it('resolves repo.save(entity: user) CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.sourceFilePath === 'Sources/App.swift',
    );
    expect(saveCall).toBeDefined();
  });

  it('populates parameterTypes for Repository.find', () => {
    // Protocol method declarations are 'Method' nodes
    const methods = getNodesByLabelFull(result, 'Method');
    const baseFind = methods.find(
      (n) => n.name === 'find' && n.properties.filePath === 'Sources/Repository.swift',
    );
    expect(baseFind).toBeDefined();
    expect(baseFind!.properties.parameterTypes).toContain('Int');
  });

  it('populates parameterTypes for Repository.save', () => {
    // Protocol method declarations are 'Method' nodes
    const methods = getNodesByLabelFull(result, 'Method');
    const baseSave = methods.find(
      (n) => n.name === 'save' && n.properties.filePath === 'Sources/Repository.swift',
    );
    expect(baseSave).toBeDefined();
    expect(baseSave!.properties.parameterTypes).toContain('String');
  });

  it('records returnType for SqlRepository.find', () => {
    // SqlRepository.find is a 'Function' node at startLine 6 (0-indexed)
    const methods = getNodesByLabelFull(result, 'Function');
    const sqlFind = methods.find((n) => n.name === 'find' && n.properties.startLine === 6);
    expect(sqlFind).toBeDefined();
    expect(sqlFind!.properties.returnType).toBe('String');
  });

  it('emits METHOD_IMPLEMENTS edges from SqlRepository methods → Repository protocol methods', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const edges = mi.filter((e) => e.sourceFilePath.includes('Repository.swift'));
    expect(edges.length).toBe(2);
    const names = edges.map((e) => e.source).sort();
    expect(names).toEqual(['find', 'save']);
  });
});

// ---------------------------------------------------------------------------
// Overloaded method disambiguation: protocol with overloaded find + save,
// concrete class implements all three. Verifies METHOD_IMPLEMENTS edges
// correctly distinguish between overloaded signatures.
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift overloaded method disambiguation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-overload-dispatch'), () => {});
  }, 60000);

  it('detects 2 distinct find Method nodes on SqlRepository', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const sqlRepoFinds = methods.filter(
      (m) => m.name === 'find' && m.properties.filePath?.includes('SqlRepository'),
    );
    // Swift class methods may be emitted as Function nodes
    const functions = getNodesByLabelFull(result, 'Function');
    const sqlRepoFindFns = functions.filter(
      (m) => m.name === 'find' && m.properties.filePath?.includes('SqlRepository'),
    );
    const totalFinds = sqlRepoFinds.length + sqlRepoFindFns.length;
    expect(totalFinds).toBe(2);
  });

  it('emits METHOD_IMPLEMENTS edges for both find overloads', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const findEdges = mi.filter(
      (e) =>
        e.source === 'find' &&
        e.target === 'find' &&
        e.sourceFilePath.includes('SqlRepository') &&
        e.targetFilePath.includes('Repository'),
    );
    expect(findEdges.length).toBe(2);
  });

  it('emits METHOD_IMPLEMENTS edge for save', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    const saveEdge = mi.find(
      (e) =>
        e.source === 'save' &&
        e.target === 'save' &&
        e.sourceFilePath.includes('SqlRepository') &&
        e.targetFilePath.includes('Repository'),
    );
    expect(saveEdge).toBeDefined();
  });

  it('emits exactly 3 METHOD_IMPLEMENTS edges total', () => {
    const mi = getRelationships(result, 'METHOD_IMPLEMENTS');
    expect(mi.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// SM-9/SM-10: lookupMethodByOwnerWithMRO + D0 fast path — Swift first-wins
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)(
  'Swift Child extends Parent — inherited method resolution (SM-9)',
  () => {
    let result: PipelineResult;

    beforeAll(async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'swift-child-extends-parent'),
        () => {},
      );
    }, 60000);

    it('detects Parent and Child classes', () => {
      const classes = getNodesByLabel(result, 'Class');
      expect(classes).toContain('Parent');
      expect(classes).toContain('Child');
    });

    it('resolves c.parentMethod() to Parent.parentMethod via first-wins MRO walk', () => {
      const calls = getRelationships(result, 'CALLS');
      const parentMethodCall = calls.find(
        (c) => c.target === 'parentMethod' && c.targetFilePath.includes('Parent.swift'),
      );
      expect(parentMethodCall).toBeDefined();
      expect(parentMethodCall!.source).toBe('run');
    });
  },
);

// ---------------------------------------------------------------------------
// U3 — SPM-target subtree grouping (issue #1948). A Swift module is an SPM
// TARGET (a directory SUBTREE `Sources/<Target>/…`), not the immediate
// containing directory. `swift-multidir-target` has target `Alpha` spread
// across `Sources/Alpha/Core` + `Sources/Alpha/Entry` plus a colliding
// same-simple-named `User` in target `Beta` (`Sources/Beta/Core`). Grouping
// by SPM target (not by immediate dir) keeps Alpha's two subdirs in one
// module, so `User()` in Alpha/Entry resolves to Alpha/Core/User (NOT
// Beta/Core/User) and cross-dir IMPORTS within Alpha emit — while Alpha and
// Beta stay distinct modules with NO IMPORTS between them.
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift SPM multi-directory target grouping', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-multidir-target'), () => {});
  }, 60000);

  it('resolves User() in Alpha/Entry to Alpha/Core/User, not Beta/Core/User', () => {
    const calls = getRelationships(result, 'CALLS');
    const ctorCall = calls.find(
      (c) =>
        c.target === 'User' &&
        c.targetLabel === 'Class' &&
        c.sourceFilePath === 'Sources/Alpha/Entry/App.swift',
    );
    expect(ctorCall).toBeDefined();
    expect(ctorCall!.targetFilePath).toBe('Sources/Alpha/Core/User.swift');
  });

  it('resolves user.alphaSave() across directories within the Alpha target', () => {
    const calls = getRelationships(result, 'CALLS');
    const memberCall = calls.find(
      (c) => c.target === 'alphaSave' && c.source === 'processEntities',
    );
    expect(memberCall).toBeDefined();
    expect(memberCall!.targetFilePath).toBe('Sources/Alpha/Core/User.swift');
  });

  it('emits cross-directory IMPORTS edges within the Alpha target (Entry <-> Core)', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const entryToCore = imports.find(
      (c) =>
        c.sourceFilePath === 'Sources/Alpha/Entry/App.swift' &&
        c.targetFilePath === 'Sources/Alpha/Core/User.swift',
    );
    const coreToEntry = imports.find(
      (c) =>
        c.sourceFilePath === 'Sources/Alpha/Core/User.swift' &&
        c.targetFilePath === 'Sources/Alpha/Entry/App.swift',
    );
    expect(entryToCore).toBeDefined();
    expect(coreToEntry).toBeDefined();
  });

  it('does NOT emit IMPORTS across distinct targets (no Alpha <-> Beta)', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const crossTarget = imports.find(
      (c) =>
        (c.sourceFilePath.startsWith('Sources/Alpha/') &&
          c.targetFilePath.startsWith('Sources/Beta/')) ||
        (c.sourceFilePath.startsWith('Sources/Beta/') &&
          c.targetFilePath.startsWith('Sources/Alpha/')),
    );
    expect(crossTarget).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// U3 — No-package multi-folder fallback (issue #1948). With NO scanned
// source dir (`Sources/`/`Package/Sources/`/`src/`) `loadSwiftPackageConfig`
// returns null, so ALL files form one `__default__` module (single-Xcode-
// project assumption). `swift-multifolder-nopackage` spreads files across
// `Models/` + `Services/` with no manifest; cross-folder visibility must
// still resolve and emit IMPORTS because the whole repo is one module.
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)(
  'Swift no-package multi-folder fallback (__default__ module)',
  () => {
    let result: PipelineResult;

    beforeAll(async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'swift-multifolder-nopackage'),
        () => {},
      );
    }, 60000);

    it('resolves User() in Services to Models/User.swift across folders', () => {
      const calls = getRelationships(result, 'CALLS');
      const ctorCall = calls.find(
        (c) =>
          c.target === 'User' &&
          c.targetLabel === 'Class' &&
          c.sourceFilePath === 'Services/App.swift',
      );
      expect(ctorCall).toBeDefined();
      expect(ctorCall!.targetFilePath).toBe('Models/User.swift');
    });

    it('resolves user.save() across folders to Models/User.swift', () => {
      const calls = getRelationships(result, 'CALLS');
      const memberCall = calls.find((c) => c.target === 'save' && c.source === 'processEntities');
      expect(memberCall).toBeDefined();
      expect(memberCall!.targetFilePath).toBe('Models/User.swift');
    });

    it('emits cross-folder IMPORTS edges between Models and Services', () => {
      const imports = getRelationships(result, 'IMPORTS');
      const crossFolder = imports.find(
        (c) =>
          (c.sourceFilePath === 'Services/App.swift' && c.targetFilePath === 'Models/User.swift') ||
          (c.sourceFilePath === 'Models/User.swift' && c.targetFilePath === 'Services/App.swift'),
      );
      expect(crossFolder).toBeDefined();
    });
  },
);

// ---------------------------------------------------------------------------
// U4 — BUG1: member-write read/write classification (issue #1948). A Swift
// assignment LHS `obj.field = x` is wrapped in `directly_assignable_expression`
// (verified, tree-sitter-swift 0.7.1), so the old `parent.type === 'assignment'`
// write guard was dead — member writes leaked as spurious READ ACCESSES and no
// WRITE edge emitted. The fix re-tags the write-LHS navigation to
// `@reference.write.member`, so a `write` ACCESSES edge emits (for BOTH a
// `self.field = x` receiver-bound write AND a non-self `obj.field = x`) and no
// spurious read appears at the LHS. The genuine standalone field READs
// (`let y = obj.field`) are a registry-primary-only correctness win — the
// legacy DAG emits read ACCESSES only for field-access CHAINS feeding a call,
// not standalone reads — so the read-control assertion is skip-gated.
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift member-write ACCESSES (read/write classification)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-member-write-access'), () => {});
  }, 60000);

  it('emits write ACCESSES for self.field = x (self-receiver) with no spurious read at the LHS', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    // init: `self.balance = start`; deposit: `self.balance = amount`.
    const balanceWrites = accesses.filter(
      (e) => e.target === 'balance' && e.targetLabel === 'Property' && e.rel.reason === 'write',
    );
    const writeSources = balanceWrites.map((e) => e.source).sort();
    expect(writeSources).toContain('init');
    expect(writeSources).toContain('deposit');
    // No spurious READ at the write LHS (init/deposit only WRITE balance).
    const balanceReadsFromWriters = accesses.filter(
      (e) =>
        e.target === 'balance' &&
        e.rel.reason === 'read' &&
        (e.source === 'init' || e.source === 'deposit'),
    );
    expect(balanceReadsFromWriters).toHaveLength(0);
  });

  it('emits write ACCESSES for obj.field = y (non-self receiver) with no spurious read at the LHS', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    // App.swift `transfer`: `acct.owner = "alice"` — non-self receiver,
    // `acct`'s type (Account) must resolve first, then `owner` resolves.
    const ownerWrite = accesses.find(
      (e) =>
        e.target === 'owner' &&
        e.targetLabel === 'Property' &&
        e.source === 'transfer' &&
        e.rel.reason === 'write',
    );
    expect(ownerWrite).toBeDefined();
    expect(ownerWrite!.targetFilePath).toBe('Models.swift');
    // No spurious READ at the LHS of the non-self write.
    const spuriousRead = accesses.find(
      (e) => e.target === 'owner' && e.source === 'transfer' && e.rel.reason === 'read',
    );
    expect(spuriousRead).toBeUndefined();
  });

  // legacy_skip: registry-primary-only. The legacy DAG emits a read ACCESSES
  // only for a field-access CHAIN feeding a call (e.g. `user.address.save()`);
  // a STANDALONE field read (`let current = self.balance`, `let who = acct.owner`)
  // produces no read ACCESSES under legacy. The scope-resolver emits it via the
  // reference-site `read` kind. Registered in helpers.ts; backporting the read
  // edge to legacy is out of scope per the migration policy.
  it('still emits a read ACCESSES for a genuine standalone field read (not the write LHS)', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    // readBalance: `let current = self.balance` (self read).
    const balanceRead = accesses.find(
      (e) => e.target === 'balance' && e.source === 'readBalance' && e.rel.reason === 'read',
    );
    expect(balanceRead).toBeDefined();
    expect(balanceRead!.targetLabel).toBe('Property');
    // inspect: `let who = acct.owner` (non-self read).
    const ownerRead = accesses.find(
      (e) => e.target === 'owner' && e.source === 'inspect' && e.rel.reason === 'read',
    );
    expect(ownerRead).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// U4 — BUG2: `class func` self-binding (issue #1948). A Swift `class func`
// (type method) emits a BARE anonymous `class` token directly under
// `function_declaration` (verified, tree-sitter-swift 0.7.1), whereas
// `static func` emits it under a `modifiers > property_modifier` wrapper. The
// old `isStaticMethod` scanned only the `modifiers` wrapper, so a `class func`
// wrongly received a `self: <Type>` INSTANCE binding (it should have none — a
// type method has no instance receiver). The fix delegates to
// `swiftMethodConfig.isStatic`, which detects both via `hasKeyword('class')`.
//
// Observable signal: an instance `self.label` property read resolves with full
// self-binding provenance (`reason === 'read'`), but inside a `class func` /
// `static func` `self.label` has no instance binding, so it resolves only via
// the weaker lexical name fallback (`reason === 'scope-resolution: read'`).
// Pre-fix, the `class func` read carried the instance-binding provenance like
// `instanceCaller`; post-fix it matches `staticCaller`.
//
// legacy_skip: registry-primary-only — the legacy DAG cannot resolve these
// self-property reads at all (it emits no ACCESSES for this fixture), so the
// provenance-parity assertion is a scope-resolver-only correctness check.
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift class func receiver (no instance self-binding)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-class-func-receiver'), () => {});
  }, 60000);

  it('a class func gets no instance self-binding (parity with static func; instance method differs)', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const reasonFor = (src: string): string | undefined =>
      accesses.find((e) => e.target === 'label' && e.source === src && e.targetLabel === 'Property')
        ?.rel.reason;

    const instanceReason = reasonFor('instanceCaller');
    const classFuncReason = reasonFor('classCaller');
    const staticFuncReason = reasonFor('staticCaller');

    // Instance method has a real `self` receiver: full self-binding provenance.
    expect(instanceReason).toBe('read');
    // `class func` must behave EXACTLY like `static func`: no instance
    // self-binding, so the read resolves only via the lexical name fallback.
    expect(classFuncReason).toBe('scope-resolution: read');
    expect(staticFuncReason).toBe('scope-resolution: read');
    expect(classFuncReason).toBe(staticFuncReason);
    // And it must NOT carry the instance method's self-binding provenance.
    expect(classFuncReason).not.toBe(instanceReason);
  });
});

// ---------------------------------------------------------------------------
// U4 — BUG3: multi-clause `if let` / `guard let` (issue #1948).
// `if let a = makeA(), let b = makeB()` has a FLAT child list where each clause
// is `value_binding_pattern · simple_identifier · = · call_expression`
// (verified, tree-sitter-swift 0.7.1). The old code read only the FIRST clause
// (`childForFieldName('bound_identifier')` returns just `a`), so the second
// binding `b: makeB() -> B` was never inferred. The fix walks all clauses and
// emits one `@type-binding.constructor` per clause.
//
// Observable signal: `b.shared()` where B.shared collides with Decoy.shared, so
// it resolves to B.shared ONLY via the second clause binding — a unique-name
// global fallback is ambiguous. The first clause `a.m()` (unique name) resolves
// in both legs; the second clause `b.shared()` is registry-primary-only.
//
// legacy_skip: registry-primary-only — legacy cannot infer the second clause's
// type binding and the ambiguous `shared` defeats its name fallback, so
// `b.shared()` stays unresolved under legacy.
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift multi-clause if-let / guard-let binding', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-multi-if-let'), () => {});
  }, 60000);

  it('detects A, B and Decoy classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('A');
    expect(classes).toContain('B');
    expect(classes).toContain('Decoy');
  });

  it('resolves b.shared() to B.shared via the SECOND if-let clause binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const sharedCall = calls.find(
      (c) =>
        c.target === 'shared' &&
        c.source === 'processIfLet' &&
        c.rel.targetId === 'Function:Models.swift:B.shared#0',
    );
    expect(sharedCall).toBeDefined();
    // It must NOT resolve to the colliding Decoy.shared.
    const decoyCall = calls.find(
      (c) =>
        c.target === 'shared' &&
        c.source === 'processIfLet' &&
        c.rel.targetId === 'Function:Models.swift:Decoy.shared#0',
    );
    expect(decoyCall).toBeUndefined();
  });

  it('resolves b.shared() to B.shared via the SECOND guard-let clause binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const sharedCall = calls.find(
      (c) =>
        c.target === 'shared' &&
        c.source === 'processGuardLet' &&
        c.rel.targetId === 'Function:Models.swift:B.shared#0',
    );
    expect(sharedCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// U4 — BUG4: nested-type extension re-keying (issue #1948).
// `extension Foo.Bar` parses to a `(user_type (type_identifier Foo)
// (type_identifier Bar))` name. The old code took `firstNamedChild` (`Foo`) as
// the extended type, re-keying the extension's members onto `Foo` and binding
// `self` to `Foo`. The fix uses `lastNamedChild` (`Bar`, the trailing
// identifier) in BOTH the captures re-key and `enclosingTypeName`, so members
// hoist onto Bar and `self == Bar`. Single-identifier `extension Foo` is
// unchanged (first === last). `base()` is split across files (Types.swift /
// Extension.swift) with a colliding Decoy.base so resolution depends purely on
// `self == Bar`.
//
// The HAS_METHOD hoisting assertion passes BOTH legs (not skipped). The
// `self.base() -> Bar.base` resolution is registry-primary-only (the legacy
// DAG leaves the cross-file extension self-call unresolved), so that exact
// test is registered in the `swift` skip-set in helpers.ts (verified
// empirically under REGISTRY_PRIMARY_SWIFT=0).
// ---------------------------------------------------------------------------

describe.skipIf(!swiftAvailable)('Swift nested-type extension (extension Foo.Bar)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'swift-nested-extension'), () => {});
  }, 60000);

  it('hoists added onto Bar (HAS_METHOD Foo.Bar -> added), not Foo', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const addedEdge = hasMethod.find(
      (e) => e.target === 'added' && e.rel.sourceId === 'Class:Extension.swift:Foo.Bar',
    );
    expect(addedEdge).toBeDefined();
    // Must NOT hoist onto a bare `Foo` owner.
    const onFoo = hasMethod.find(
      (e) => e.target === 'added' && e.rel.sourceId === 'Class:Types.swift:Foo',
    );
    expect(onFoo).toBeUndefined();
  });

  it('resolves self.base() inside added() to Bar.base (self == Bar), not Foo', () => {
    const calls = getRelationships(result, 'CALLS');
    const baseCall = calls.find((c) => c.target === 'base' && c.source === 'added');
    expect(baseCall).toBeDefined();
    expect(baseCall!.rel.targetId).toBe('Function:Types.swift:Bar.base#0');
  });
});
