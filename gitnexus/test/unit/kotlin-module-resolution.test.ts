/** Kotlin imports are resolved from package declarations and module exports. */
import { describe, expect, it } from 'vitest';
import type {
  BindingRef,
  ParsedFile,
  Range,
  Scope,
  ScopeId,
  SymbolDefinition,
} from 'gitnexus-shared';
import {
  buildKotlinPackageIndex,
  resolveKotlinModule,
  type KotlinPackageIndex,
} from '../../src/core/ingestion/languages/kotlin/module-resolution.js';
import type { JvmPackageFact } from '../../src/core/ingestion/languages/jvm/package-facts.js';

const RANGE: Range = { startLine: 1, startCol: 0, endLine: 1, endCol: 1 };

interface FileDeclaration {
  readonly packageName: string | null;
  readonly exports?: readonly string[];
  readonly importedBindings?: readonly string[];
}

function indexOf(declarations: Readonly<Record<string, FileDeclaration>>): KotlinPackageIndex {
  const facts = new Map<string, JvmPackageFact>();
  const parsedFiles = Object.entries(declarations).map(([filePath, declaration]) => {
    facts.set(
      filePath,
      declaration.packageName === null
        ? { status: 'unknown' }
        : { status: 'known', packageName: declaration.packageName },
    );
    return parsedFile(filePath, declaration.exports ?? [], declaration.importedBindings ?? []);
  });
  return buildKotlinPackageIndex(parsedFiles, (filePath) => facts.get(filePath));
}

function parsedFile(
  filePath: string,
  exports: readonly string[],
  importedBindings: readonly string[],
): ParsedFile {
  const moduleScope = `module:${filePath}` as ScopeId;
  const bindings = new Map<string, readonly BindingRef[]>();
  const localDefs: SymbolDefinition[] = [];

  for (const name of exports) {
    const def: SymbolDefinition = {
      nodeId: `Function:${filePath}:${name}`,
      filePath,
      type: 'Function',
      qualifiedName: name,
    };
    localDefs.push(def);
    bindings.set(name, [{ def, origin: 'local' }]);
  }
  for (const name of importedBindings) {
    bindings.set(name, [
      {
        def: {
          nodeId: `Function:dependency.kt:${name}`,
          filePath: 'dependency.kt',
          type: 'Function',
          qualifiedName: name,
        },
        origin: 'import',
      },
    ]);
  }

  const scope: Scope = {
    id: moduleScope,
    parent: null,
    kind: 'Module',
    range: RANGE,
    filePath,
    bindings,
    ownedDefs: localDefs,
    imports: [],
    typeBindings: new Map(),
  };
  return {
    filePath,
    moduleScope,
    scopes: [scope],
    parsedImports: [],
    localDefs,
    referenceSites: [],
  };
}

const WORKSPACE = indexOf({
  'app/Main.kt': { packageName: 'app', exports: ['main'] },
  'flat/UserSource.kt': { packageName: 'com.example.model', exports: ['User', 'loadUser'] },
  'odd/ToolsFile.kt': { packageName: 'com.example', exports: ['Tools'] },
  'other/Order.kt': { packageName: 'com.example.model', exports: ['Order'] },
  'vendor/Assert.kt': { packageName: 'vendor', exports: ['Assert'] },
});

describe('Kotlin declared-package imports (#2960)', () => {
  it('resolves a type even when neither directory nor file name matches', () => {
    expect(resolveKotlinModule('com.example.model.User', WORKSPACE)).toBe('flat/UserSource.kt');
  });

  it('resolves top-level functions and properties by module binding name', () => {
    expect(resolveKotlinModule('com.example.model.loadUser', WORKSPACE)).toBe('flat/UserSource.kt');
  });

  it('resolves a member import to its owning top-level declaration', () => {
    expect(resolveKotlinModule('com.example.Tools.format', WORKSPACE)).toBe('odd/ToolsFile.kt');
    expect(resolveKotlinModule('com.example.Tools.*', WORKSPACE)).toBe('odd/ToolsFile.kt');
  });

  it('expands a package wildcard to every file declaring that package', () => {
    expect(resolveKotlinModule('com.example.model.*', WORKSPACE)).toEqual([
      'flat/UserSource.kt',
      'other/Order.kt',
    ]);
  });

  it('does not resolve an external import onto a same-named local path', () => {
    expect(resolveKotlinModule('org.junit.Assert', WORKSPACE)).toBeNull();
    expect(resolveKotlinModule('vendor.Assert', WORKSPACE)).toBe('vendor/Assert.kt');
  });

  it('does not treat imported bindings as declarations of their importing file', () => {
    const index = indexOf({
      'app/Main.kt': {
        packageName: 'app',
        exports: ['main'],
        importedBindings: ['External'],
      },
    });
    expect(resolveKotlinModule('app.External', index)).toBeNull();
  });

  it('preserves the complete top-level overload candidate set', () => {
    const index = indexOf({
      'one.kt': { packageName: 'dup', exports: ['parse'] },
      'two.kt': { packageName: 'dup', exports: ['parse'] },
    });
    expect(resolveKotlinModule('dup.parse', index)).toEqual(['one.kt', 'two.kt']);
  });

  it('resolves root-package declarations but rejects unreadable package files', () => {
    const index = indexOf({
      'Root.kt': { packageName: '', exports: ['Root'] },
      'Broken.kt': { packageName: null, exports: ['Broken'] },
    });
    expect(index.filesByPackage.get('')).toEqual(['Root.kt']);
    expect(index.unreadablePackageFiles).toBe(1);
    expect(resolveKotlinModule('Root', index)).toBe('Root.kt');
    expect(resolveKotlinModule('broken.Broken', index)).toBeNull();
  });
});
