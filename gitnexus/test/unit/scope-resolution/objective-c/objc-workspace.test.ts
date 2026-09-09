import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import {
  getObjectiveCFileFacts,
  objcFunctionQualifiedName,
  setObjectiveCFileFacts,
  type ObjCFileFacts,
} from '../../../../src/core/ingestion/languages/objective-c/facts.js';
import { populateObjectiveCCompilationUnitSiblings } from '../../../../src/core/ingestion/languages/objective-c/compilation-unit-siblings.js';
import { resolveObjectiveCImportTarget } from '../../../../src/core/ingestion/languages/objective-c/import-target.js';
import {
  loadObjectiveCResolutionConfig,
  parseModuleMap,
  parseXcconfigSearchPaths,
  type ObjectiveCResolutionConfig,
} from '../../../../src/core/ingestion/languages/objective-c/resolution-config.js';
import { objectiveCScopeResolver } from '../../../../src/core/ingestion/languages/objective-c/scope-resolver.js';
import type { ScopeResolutionIndexes } from '../../../../src/core/ingestion/model/scope-resolution-indexes.js';

const TMP = join(__dirname, '__objc_workspace_tmp__');

function touch(rel: string, contents = ''): void {
  const full = join(TMP, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, contents);
}

function config(partial: Partial<ObjectiveCResolutionConfig>): ObjectiveCResolutionConfig {
  return {
    headers: partial.headers ?? new Set(),
    headerSearchPaths: partial.headerSearchPaths ?? [],
    userHeaderSearchPaths: partial.userHeaderSearchPaths ?? [],
    frameworks: partial.frameworks ?? new Map(),
    modules: partial.modules ?? new Map(),
  };
}

function staleFacts(filePath: string): ObjCFileFacts {
  return {
    providerVersion: 'test',
    grammarPackage: 'test',
    grammarVersion: 'test',
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

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('Objective-C workspace scan', () => {
  it('finds source headers and skips build / Cocoa output trees', () => {
    touch('Headers/Widget.h');
    touch('src/foo.h');
    touch('DerivedData/ModuleCache/gen.h');
    touch('Pods/AFNetworking/AFNetworking.h');
    touch('build/config.h');
    const scanned = loadObjectiveCResolutionConfig(TMP);
    expect(scanned.headers).toContain('Headers/Widget.h');
    expect(scanned.headers).toContain('src/foo.h');
    expect(scanned.headers).not.toContain('DerivedData/ModuleCache/gen.h');
    expect(scanned.headers).not.toContain('Pods/AFNetworking/AFNetworking.h');
    expect(scanned.headers).not.toContain('build/config.h');
    expect(scanned.userHeaderSearchPaths).toContain('Headers');
  });

  it('records in-repo frameworks and module maps', () => {
    touch('MyKit.framework/Headers/Widget.h', '@interface Widget\n@end\n');
    touch(
      'MyKit.framework/Modules/module.modulemap',
      'framework module MyKit {\n  umbrella header "Widget.h"\n  export *\n}\n',
    );
    const scanned = loadObjectiveCResolutionConfig(TMP);
    expect(scanned.frameworks.get('MyKit')).toBe('MyKit.framework/Headers');
    expect(scanned.modules.get('MyKit')).toBe('MyKit.framework/Headers/Widget.h');
  });

  it('reads HEADER_SEARCH_PATHS from xcconfig and ignores SDK roots', () => {
    touch(
      'App.xcconfig',
      [
        'HEADER_SEARCH_PATHS = $(SRCROOT)/Vendor/Headers $(SDKROOT)/usr/include $(inherited)',
        'USER_HEADER_SEARCH_PATHS = "Private Headers"',
        '',
      ].join('\n'),
    );
    const scanned = loadObjectiveCResolutionConfig(TMP);
    expect(scanned.headerSearchPaths).toEqual(['Vendor/Headers']);
    expect(scanned.userHeaderSearchPaths).toEqual(['Private Headers']);
  });

  it('clears stale file facts at the start of a workspace pass', () => {
    setObjectiveCFileFacts(staleFacts('stale.m'));
    expect(getObjectiveCFileFacts('stale.m')).toBeDefined();
    objectiveCScopeResolver.loadResolutionConfig?.(TMP);
    expect(getObjectiveCFileFacts('stale.m')).toBeUndefined();
  });
});

describe('Objective-C xcconfig / module map parsers', () => {
  it('joins continuation lines and drops inherited tokens', () => {
    expect(
      parseXcconfigSearchPaths('HEADER_SEARCH_PATHS = \\\n  $(PROJECT_DIR)/A \\\n  $(inherited)\n'),
    ).toEqual({ headerSearchPaths: ['A'], userHeaderSearchPaths: [] });
  });

  it('resolves module umbrellas relative to the map directory', () => {
    expect(
      parseModuleMap(
        'framework module MyKit { umbrella header "../Headers/MyKit.h" }',
        'MyKit.framework/Modules',
      ),
    ).toEqual([['MyKit', 'MyKit.framework/Headers/MyKit.h']]);
  });
});

describe('Objective-C workspace import resolution', () => {
  const fromFile = 'Sources/main.m';

  it('keeps the pre-workspace quoted suffix answers when no config is supplied', () => {
    const files = new Set([
      'Vendor/Widget.h',
      'Headers/Widget.h',
      'Sources/Local.h',
      'Sources/main.m',
    ]);
    expect(resolveObjectiveCImportTarget('Widget.h', fromFile, files)).toBe('Vendor/Widget.h');
    expect(resolveObjectiveCImportTarget('./Local.h', fromFile, files)).toBe('Sources/Local.h');
    expect(resolveObjectiveCImportTarget('<Foundation/Foundation.h>', fromFile, files)).toBeNull();
    expect(resolveObjectiveCImportTarget('Foundation', fromFile, files)).toBeNull();
  });

  it('resolves a quoted header that is only in the scanned header set', () => {
    const files = new Set(['Sources/main.m']);
    const workspace = config({ headers: new Set(['Headers/Widget.h']) });
    expect(resolveObjectiveCImportTarget('Widget.h', fromFile, files, workspace)).toBe(
      'Headers/Widget.h',
    );
    expect(resolveObjectiveCImportTarget('Widget.h', fromFile, files)).toBeNull();
  });

  it('resolves quoted imports through user header search paths', () => {
    const files = new Set(['Sources/main.m']);
    const workspace = config({
      headers: new Set(['Vendor/Headers/Helper.h']),
      userHeaderSearchPaths: ['Vendor/Headers'],
    });
    expect(resolveObjectiveCImportTarget('Helper.h', fromFile, files, workspace)).toBe(
      'Vendor/Headers/Helper.h',
    );
  });

  it('resolves in-repo angle-bracket framework headers and keeps system decoys closed', () => {
    const files = new Set(['Sources/main.m', 'Headers/Foundation.h']);
    const workspace = config({
      headers: new Set([
        'MyKit.framework/Headers/Widget.h',
        'Headers/Foundation.h',
        'Headers/Foundation/Foundation.h',
      ]),
      userHeaderSearchPaths: ['Headers'],
      frameworks: new Map([['MyKit', 'MyKit.framework/Headers']]),
    });
    expect(resolveObjectiveCImportTarget('<MyKit/Widget.h>', fromFile, files, workspace)).toBe(
      'MyKit.framework/Headers/Widget.h',
    );
    expect(
      resolveObjectiveCImportTarget('<Foundation/Foundation.h>', fromFile, files, workspace),
    ).toBeNull();
    expect(resolveObjectiveCImportTarget('Foundation.h', fromFile, files, workspace)).toBe(
      'Headers/Foundation.h',
    );
  });

  it('resolves @import through an in-repo module map only', () => {
    const files = new Set(['Sources/main.m']);
    const workspace = config({
      headers: new Set(['MyKit.framework/Headers/MyKit.h']),
      modules: new Map([['MyKit', 'MyKit.framework/Headers/MyKit.h']]),
    });
    expect(resolveObjectiveCImportTarget('MyKit', fromFile, files, workspace)).toBe(
      'MyKit.framework/Headers/MyKit.h',
    );
    expect(resolveObjectiveCImportTarget('Foundation', fromFile, files, workspace)).toBeNull();
  });

  it('accepts a raw header Set the way the C bench threads resolutionConfig', () => {
    const files = new Set(['Sources/main.m']);
    expect(
      resolveObjectiveCImportTarget('Widget.h', fromFile, files, new Set(['Headers/Widget.h'])),
    ).toBe('Headers/Widget.h');
  });
});

describe('Objective-C compilation-unit siblings', () => {
  it('shares defs between same-directory header and implementation only', () => {
    const headerDef = def('header-run', 'Classes/Foo.h', 'FooRun');
    const implDef = def('impl-helper', 'Classes/Foo.m', 'FooHelper');
    const otherDef = def('other', 'Classes/Bar.m', 'BarOnly');
    const parsedFiles = [
      parsed('Classes/Foo.h', 'module:foo-h', headerDef),
      parsed('Classes/Foo.m', 'module:foo-m', implDef),
      parsed('Classes/Bar.m', 'module:bar-m', otherDef),
    ];
    const indexes = siblingIndexes(parsedFiles);
    populateObjectiveCCompilationUnitSiblings(parsedFiles, indexes);
    expect(indexes.bindingAugmentations.get('module:foo-m')?.get('FooRun')?.[0]?.def.nodeId).toBe(
      'header-run',
    );
    expect(
      indexes.bindingAugmentations.get('module:foo-h')?.get('FooHelper')?.[0]?.def.nodeId,
    ).toBe('impl-helper');
    expect(indexes.bindingAugmentations.get('module:bar-m')?.get('FooRun')).toBeUndefined();
  });

  it('pairs a header and implementation that declare the same class across directories', () => {
    const headerPath = 'Headers/Widget.h';
    const implPath = 'Sources/Widget.m';
    setObjectiveCFileFacts({
      ...staleFacts(headerPath),
      containers: [
        {
          kind: 'class',
          declarationRole: 'interface',
          name: 'Widget',
          qualifiedName: 'objc:class:Widget',
          nodeId: 'Class:objc:class:Widget',
          label: 'Class',
          filePath: headerPath,
          startLine: 1,
          endLine: 3,
          protocols: [],
        },
      ],
    });
    setObjectiveCFileFacts({
      ...staleFacts(implPath),
      containers: [
        {
          kind: 'class',
          declarationRole: 'implementation',
          name: 'Widget',
          qualifiedName: 'objc:class:Widget',
          nodeId: 'Class:objc:class:Widget',
          label: 'Class',
          filePath: implPath,
          startLine: 1,
          endLine: 5,
          protocols: [],
        },
      ],
    });
    const headerDef = def('widget-iface', headerPath, 'WidgetIface');
    const implDef = def('widget-impl', implPath, 'WidgetImpl');
    const parsedFiles = [
      parsed(headerPath, 'module:h', headerDef, {
        kind: 'objective-c',
        facts: getObjectiveCFileFacts(headerPath),
      }),
      parsed(implPath, 'module:m', implDef, {
        kind: 'objective-c',
        facts: getObjectiveCFileFacts(implPath),
      }),
    ];
    const indexes = siblingIndexes(parsedFiles);
    populateObjectiveCCompilationUnitSiblings(parsedFiles, indexes);
    expect(indexes.bindingAugmentations.get('module:m')?.get('WidgetIface')?.[0]?.def.nodeId).toBe(
      'widget-iface',
    );
  });

  it('does not expose file-static C functions to compilation-unit siblings', () => {
    const headerPath = 'Classes/Foo.h';
    const implPath = 'Classes/Foo.m';
    const staticQn = objcFunctionQualifiedName('hiddenHelper', 'internal', implPath);
    const staticDef: SymbolDefinition = {
      nodeId: `Function:${staticQn}`,
      filePath: implPath,
      type: 'Function',
      qualifiedName: staticQn,
    };
    const exportedDef = def('exported-run', implPath, 'FooRun');
    setObjectiveCFileFacts({
      ...staleFacts(implPath),
      functions: [
        {
          name: 'hiddenHelper',
          linkage: 'internal',
          qualifiedName: staticQn,
          nodeId: staticDef.nodeId,
          filePath: implPath,
          startLine: 1,
          endLine: 1,
          parameterTypes: [],
        },
      ],
    });
    const parsedFiles = [
      parsed(headerPath, 'module:foo-h', def('header-run', headerPath, 'FooIface'), {
        kind: 'objective-c',
        facts: staleFacts(headerPath),
      }),
      {
        filePath: implPath,
        moduleScope: 'module:foo-m',
        scopes: [],
        parsedImports: [],
        localDefs: [staticDef, exportedDef],
        referenceSites: [],
        captureSideChannel: { kind: 'objective-c', facts: getObjectiveCFileFacts(implPath) },
      },
    ];
    const indexes = siblingIndexes(parsedFiles);
    populateObjectiveCCompilationUnitSiblings(parsedFiles, indexes);

    expect(indexes.bindingAugmentations.get('module:foo-h')?.get('hiddenHelper')).toBeUndefined();
    expect(indexes.bindingAugmentations.get('module:foo-h')?.get(staticQn)).toBeUndefined();
    expect(indexes.bindingAugmentations.get('module:foo-h')?.get('FooRun')?.[0]?.def.nodeId).toBe(
      'exported-run',
    );
    expect(objectiveCScopeResolver.isFileLocalDef?.(staticDef)).toBe(true);
    expect(objectiveCScopeResolver.isFileLocalDef?.(exportedDef)).toBe(false);
  });

  it('does not mix a class and a same-named protocol into one visibility group', () => {
    const classPath = 'Headers/Foo.h';
    const protocolPath = 'Protocols/Foo.h';
    setObjectiveCFileFacts({
      ...staleFacts(classPath),
      containers: [
        {
          kind: 'class',
          declarationRole: 'interface',
          name: 'Foo',
          qualifiedName: 'objc:class:Foo',
          nodeId: 'Class:objc:class:Foo',
          label: 'Class',
          filePath: classPath,
          startLine: 1,
          endLine: 3,
          protocols: [],
        },
      ],
    });
    setObjectiveCFileFacts({
      ...staleFacts(protocolPath),
      containers: [
        {
          kind: 'protocol',
          declarationRole: 'interface',
          name: 'Foo',
          qualifiedName: 'objc:protocol:Foo',
          nodeId: 'Protocol:objc:protocol:Foo',
          label: 'Protocol',
          filePath: protocolPath,
          startLine: 1,
          endLine: 3,
          protocols: [],
        },
      ],
    });
    const parsedFiles = [
      parsed(classPath, 'module:class', def('class-only', classPath, 'classOnly'), {
        kind: 'objective-c',
        facts: getObjectiveCFileFacts(classPath),
      }),
      parsed(protocolPath, 'module:proto', def('proto-only', protocolPath, 'protoOnly'), {
        kind: 'objective-c',
        facts: getObjectiveCFileFacts(protocolPath),
      }),
    ];
    const indexes = siblingIndexes(parsedFiles);
    populateObjectiveCCompilationUnitSiblings(parsedFiles, indexes);

    expect(indexes.bindingAugmentations.get('module:proto')?.get('classOnly')).toBeUndefined();
    expect(indexes.bindingAugmentations.get('module:class')?.get('protoOnly')).toBeUndefined();
  });
});

function def(nodeId: string, filePath: string, name: string): SymbolDefinition {
  return { nodeId, filePath, type: 'Function', qualifiedName: name };
}

function parsed(
  filePath: string,
  moduleScope: string,
  localDef: SymbolDefinition,
  captureSideChannel?: unknown,
): ParsedFile {
  return {
    filePath,
    moduleScope,
    scopes: [],
    parsedImports: [],
    localDefs: [localDef],
    referenceSites: [],
    captureSideChannel,
  };
}

function siblingIndexes(parsedFiles: readonly ParsedFile[]): ScopeResolutionIndexes {
  return {
    moduleScopes: {
      byFilePath: new Map(parsedFiles.map((file) => [file.filePath, file.moduleScope])),
    },
    imports: new Map(),
    bindings: new Map(),
    bindingAugmentations: new Map(),
  } as unknown as ScopeResolutionIndexes;
}
