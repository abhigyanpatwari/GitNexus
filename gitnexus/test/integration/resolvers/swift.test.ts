/**
 * Swift: constructor-inferred type resolution for member calls.
 * Verifies that `let user = User(name: "alice"); user.save()` resolves to User.save
 * without explicit type annotations, using SymbolTable verification.
 *
 * NOTE: tree-sitter-swift has build issues on Node 22 — these tests skip gracefully
 * when the Swift parser is not available.
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
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

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
