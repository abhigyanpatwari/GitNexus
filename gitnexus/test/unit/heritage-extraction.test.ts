import { describe, it, expect } from 'vitest';
import { createHeritageExtractor } from '../../src/core/ingestion/heritage-extractors/generic.js';
import { rubyHeritageConfig } from '../../src/core/ingestion/heritage-extractors/configs/ruby.js';
import { goHeritageConfig } from '../../src/core/ingestion/heritage-extractors/configs/go.js';
import type {
  HeritageExtractionConfig,
  HeritageExtractorContext,
} from '../../src/core/ingestion/heritage-types.js';
import type { CaptureMap } from '../../src/core/ingestion/language-provider.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { getProvider } from '../../src/core/ingestion/languages/index.js';

// ---------------------------------------------------------------------------
// Mock AST node helpers
// ---------------------------------------------------------------------------

interface MockNode {
  type: string;
  text: string;
  parent?: MockNode | null;
  children?: MockNode[];
  childForFieldName?: (name: string) => MockNode | undefined;
}

/** Create a minimal mock SyntaxNode for capture map entries. */
function makeNode(text: string, type = 'identifier', parent?: MockNode): MockNode {
  return { type, text, parent: parent ?? null };
}

/** Create a mock field_declaration node (Go struct fields). */
function makeGoFieldDecl(opts: { hasName: boolean; typeName: string }): MockNode {
  const nameNode = opts.hasName ? makeNode('MyField', 'field_identifier') : undefined;
  const fieldDecl: MockNode = {
    type: 'field_declaration',
    text: '',
    childForFieldName: (name: string) => (name === 'name' ? nameNode : undefined),
  };
  const typeNode = makeNode(opts.typeName, 'type_identifier', fieldDecl);
  return typeNode;
}

/** Build a CaptureMap from partial entries. */
function buildCaptureMap(entries: Record<string, MockNode | undefined>): CaptureMap {
  return entries as unknown as CaptureMap;
}

/** Default context for testing. */
function ctx(filePath = 'Test.java', language = SupportedLanguages.Java): HeritageExtractorContext {
  return { filePath, language };
}

// ---------------------------------------------------------------------------
// Factory construction
// ---------------------------------------------------------------------------

describe('createHeritageExtractor', () => {
  it('creates an extractor from a minimal config', () => {
    const extractor = createHeritageExtractor(SupportedLanguages.Java);
    expect(extractor).toBeDefined();
    expect(extractor.language).toBe(SupportedLanguages.Java);
    expect(typeof extractor.extract).toBe('function');
  });

  it('creates an extractor from a language enum (default config)', () => {
    const languages: SupportedLanguages[] = [
      SupportedLanguages.Java,
      SupportedLanguages.Kotlin,
      SupportedLanguages.CSharp,
      SupportedLanguages.TypeScript,
      SupportedLanguages.JavaScript,
      SupportedLanguages.CPlusPlus,
      SupportedLanguages.C,
      SupportedLanguages.Python,
      SupportedLanguages.Rust,
      SupportedLanguages.Dart,
      SupportedLanguages.PHP,
      SupportedLanguages.Swift,
    ];
    for (const lang of languages) {
      const extractor = createHeritageExtractor(lang);
      expect(extractor.language, `${lang} extractor should have correct language`).toBe(lang);
      expect(typeof extractor.extract).toBe('function');
      expect(extractor.extractFromCall).toBeUndefined();
    }
  });

  it('creates an extractor from full config with custom hooks', () => {
    const configs: HeritageExtractionConfig[] = [goHeritageConfig, rubyHeritageConfig];
    for (const cfg of configs) {
      expect(
        () => createHeritageExtractor(cfg),
        `config for ${cfg.language} must construct cleanly`,
      ).not.toThrow();
    }
  });

  it('sets extractFromCall when callBasedHeritage is configured', () => {
    const extractor = createHeritageExtractor(rubyHeritageConfig);
    expect(extractor.extractFromCall).toBeDefined();
    expect(typeof extractor.extractFromCall).toBe('function');
  });

  it('does not set extractFromCall for default language extractors', () => {
    const extractor = createHeritageExtractor(SupportedLanguages.Java);
    expect(extractor.extractFromCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Generic extraction from captures
// ---------------------------------------------------------------------------

describe('HeritageExtractor.extract', () => {
  const extractor = createHeritageExtractor(SupportedLanguages.Java);

  it('returns empty array when heritage.class is not present', () => {
    const captures = buildCaptureMap({});
    expect(extractor.extract(captures, ctx())).toEqual([]);
  });

  it('returns empty array when heritage.class is present but no extends/implements/trait', () => {
    const captures = buildCaptureMap({
      'heritage.class': makeNode('MyClass'),
    });
    expect(extractor.extract(captures, ctx())).toEqual([]);
  });

  it('extracts extends heritage', () => {
    const captures = buildCaptureMap({
      'heritage.class': makeNode('Child'),
      'heritage.extends': makeNode('Parent'),
    });
    const result = extractor.extract(captures, ctx());
    expect(result).toEqual([{ className: 'Child', parentName: 'Parent', kind: 'extends' }]);
  });

  it('extracts implements heritage', () => {
    const captures = buildCaptureMap({
      'heritage.class': makeNode('MyClass'),
      'heritage.implements': makeNode('MyInterface'),
    });
    const result = extractor.extract(captures, ctx());
    expect(result).toEqual([
      { className: 'MyClass', parentName: 'MyInterface', kind: 'implements' },
    ]);
  });

  it('extracts trait-impl heritage', () => {
    const rustExtractor = createHeritageExtractor(SupportedLanguages.Rust);
    const captures = buildCaptureMap({
      'heritage.class': makeNode('MyStruct'),
      'heritage.trait': makeNode('Display'),
    });
    const result = rustExtractor.extract(captures, ctx('main.rs', SupportedLanguages.Rust));
    expect(result).toEqual([{ className: 'MyStruct', parentName: 'Display', kind: 'trait-impl' }]);
  });

  it('extracts both extends and implements from same match', () => {
    const captures = buildCaptureMap({
      'heritage.class': makeNode('MyClass'),
      'heritage.extends': makeNode('BaseClass'),
      'heritage.implements': makeNode('ISerializable'),
    });
    const result = extractor.extract(captures, ctx());
    expect(result).toEqual([
      { className: 'MyClass', parentName: 'BaseClass', kind: 'extends' },
      { className: 'MyClass', parentName: 'ISerializable', kind: 'implements' },
    ]);
  });

  it('extracts all three heritage kinds from same match', () => {
    const captures = buildCaptureMap({
      'heritage.class': makeNode('MyStruct'),
      'heritage.extends': makeNode('Base'),
      'heritage.implements': makeNode('IFace'),
      'heritage.trait': makeNode('Trait'),
    });
    const result = extractor.extract(captures, ctx());
    expect(result).toEqual([
      { className: 'MyStruct', parentName: 'Base', kind: 'extends' },
      { className: 'MyStruct', parentName: 'IFace', kind: 'implements' },
      { className: 'MyStruct', parentName: 'Trait', kind: 'trait-impl' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Go: shouldSkipExtends (named field detection)
// ---------------------------------------------------------------------------

describe('Go HeritageExtractor — shouldSkipExtends', () => {
  const extractor = createHeritageExtractor(goHeritageConfig);

  it('extracts anonymous struct embedding (no field name)', () => {
    const typeNode = makeGoFieldDecl({ hasName: false, typeName: 'Animal' });
    const captures = buildCaptureMap({
      'heritage.class': makeNode('Dog'),
      'heritage.extends': typeNode as unknown as CaptureMap[string],
    });
    const result = extractor.extract(captures, ctx('main.go', SupportedLanguages.Go));
    expect(result).toEqual([{ className: 'Dog', parentName: 'Animal', kind: 'extends' }]);
  });

  it('skips named struct fields (Breed string)', () => {
    const typeNode = makeGoFieldDecl({ hasName: true, typeName: 'string' });
    const captures = buildCaptureMap({
      'heritage.class': makeNode('Dog'),
      'heritage.extends': typeNode as unknown as CaptureMap[string],
    });
    const result = extractor.extract(captures, ctx('main.go', SupportedLanguages.Go));
    expect(result).toEqual([]);
  });

  it('extracts heritage when extends node has no parent', () => {
    const orphanNode = makeNode('Embedded', 'type_identifier');
    orphanNode.parent = null;
    const captures = buildCaptureMap({
      'heritage.class': makeNode('Foo'),
      'heritage.extends': orphanNode as unknown as CaptureMap[string],
    });
    const result = extractor.extract(captures, ctx('main.go', SupportedLanguages.Go));
    expect(result).toEqual([{ className: 'Foo', parentName: 'Embedded', kind: 'extends' }]);
  });
});

// ---------------------------------------------------------------------------
// Ruby: call-based heritage (include/extend/prepend)
// ---------------------------------------------------------------------------

describe('Ruby HeritageExtractor — call-based heritage', () => {
  const extractor = createHeritageExtractor(rubyHeritageConfig);

  /** Build a mock call node for include/extend/prepend. */
  function makeCallNode(
    argNodes: MockNode[],
    enclosingType: 'class' | 'module' | null,
    enclosingName: string | null,
  ): MockNode {
    const argList: MockNode = {
      type: 'argument_list',
      text: '',
      children: argNodes,
    };
    const classNameNode = enclosingName ? makeNode(enclosingName, 'constant') : undefined;
    const enclosingNode: MockNode | null =
      enclosingType && enclosingName
        ? {
            type: enclosingType,
            text: '',
            parent: null,
            childForFieldName: (name: string) => (name === 'name' ? classNameNode : undefined),
          }
        : null;

    const bodyNode: MockNode = {
      type: 'body_statement',
      text: '',
      parent: enclosingNode,
    };
    if (enclosingNode) enclosingNode.children = [bodyNode];

    const callNode: MockNode = {
      type: 'call',
      text: '',
      parent: bodyNode,
      childForFieldName: (name: string) => (name === 'arguments' ? argList : undefined),
    };
    return callNode;
  }

  function makeConstantArg(name: string): MockNode {
    return makeNode(name, 'constant');
  }

  function makeScopeResolutionArg(name: string): MockNode {
    return makeNode(name, 'scope_resolution');
  }

  const rubyCtx = ctx('app.rb', SupportedLanguages.Ruby);

  it('returns null for non-heritage call names', () => {
    const callNode = makeCallNode([makeConstantArg('Foo')], 'class', 'Bar');
    expect(extractor.extractFromCall!('puts', callNode as any, rubyCtx)).toBeNull();
  });

  it('extracts include heritage with single constant arg', () => {
    const callNode = makeCallNode([makeConstantArg('Serializable')], 'class', 'User');
    const result = extractor.extractFromCall!('include', callNode as any, rubyCtx);
    expect(result).toEqual([{ className: 'User', parentName: 'Serializable', kind: 'include' }]);
  });

  it('extracts extend heritage with scope_resolution arg', () => {
    const callNode = makeCallNode(
      [makeScopeResolutionArg('ActiveSupport::Concern')],
      'class',
      'Post',
    );
    const result = extractor.extractFromCall!('extend', callNode as any, rubyCtx);
    expect(result).toEqual([
      { className: 'Post', parentName: 'ActiveSupport::Concern', kind: 'extend' },
    ]);
  });

  it('extracts prepend heritage', () => {
    const callNode = makeCallNode([makeConstantArg('Instrumented')], 'class', 'Service');
    const result = extractor.extractFromCall!('prepend', callNode as any, rubyCtx);
    expect(result).toEqual([{ className: 'Service', parentName: 'Instrumented', kind: 'prepend' }]);
  });

  it('extracts include inside a module', () => {
    const callNode = makeCallNode([makeConstantArg('Helpers')], 'module', 'AppHelper');
    const result = extractor.extractFromCall!('include', callNode as any, rubyCtx);
    expect(result).toEqual([{ className: 'AppHelper', parentName: 'Helpers', kind: 'include' }]);
  });

  it('extracts multiple constant args as separate heritage items', () => {
    const args = [makeConstantArg('Mod1'), makeConstantArg('Mod2'), makeConstantArg('Mod3')];
    const callNode = makeCallNode(args, 'class', 'MyClass');
    const result = extractor.extractFromCall!('include', callNode as any, rubyCtx);
    expect(result).toEqual([
      { className: 'MyClass', parentName: 'Mod1', kind: 'include' },
      { className: 'MyClass', parentName: 'Mod2', kind: 'include' },
      { className: 'MyClass', parentName: 'Mod3', kind: 'include' },
    ]);
  });

  it('returns empty array when no enclosing class/module', () => {
    const argList: MockNode = {
      type: 'argument_list',
      text: '',
      children: [makeConstantArg('Foo')],
    };
    const callNode: MockNode = {
      type: 'call',
      text: '',
      parent: null,
      childForFieldName: (name: string) => (name === 'arguments' ? argList : undefined),
    };
    const result = extractor.extractFromCall!('include', callNode as any, rubyCtx);
    expect(result).toEqual([]);
  });

  it('skips non-constant/non-scope_resolution args', () => {
    const args = [
      makeConstantArg('Mod1'),
      makeNode('some_var', 'identifier'), // not constant or scope_resolution
      makeConstantArg('Mod2'),
    ];
    const callNode = makeCallNode(args, 'class', 'MyClass');
    const result = extractor.extractFromCall!('include', callNode as any, rubyCtx);
    expect(result).toEqual([
      { className: 'MyClass', parentName: 'Mod1', kind: 'include' },
      { className: 'MyClass', parentName: 'Mod2', kind: 'include' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Language-specific config validation
// ---------------------------------------------------------------------------

describe('HeritageExtraction language configs', () => {
  it('Go config has shouldSkipExtends hook', () => {
    expect(goHeritageConfig.language).toBe(SupportedLanguages.Go);
    expect(goHeritageConfig.shouldSkipExtends).toBeDefined();
    expect(typeof goHeritageConfig.shouldSkipExtends).toBe('function');
  });

  it('Ruby config has callBasedHeritage', () => {
    expect(rubyHeritageConfig.language).toBe(SupportedLanguages.Ruby);
    expect(rubyHeritageConfig.callBasedHeritage).toBeDefined();
    expect(rubyHeritageConfig.callBasedHeritage!.callNames).toEqual(
      new Set(['include', 'extend', 'prepend']),
    );
  });

  it('default language extractors have no custom hooks', () => {
    const defaultLanguages: SupportedLanguages[] = [
      SupportedLanguages.Java,
      SupportedLanguages.Kotlin,
      SupportedLanguages.CSharp,
      SupportedLanguages.TypeScript,
      SupportedLanguages.JavaScript,
      SupportedLanguages.CPlusPlus,
      SupportedLanguages.C,
      SupportedLanguages.Python,
      SupportedLanguages.Rust,
      SupportedLanguages.Dart,
      SupportedLanguages.PHP,
      SupportedLanguages.Swift,
    ];
    for (const lang of defaultLanguages) {
      const extractor = createHeritageExtractor(lang);
      expect(extractor.language).toBe(lang);
      expect(extractor.extractFromCall, `${lang} should not have extractFromCall`).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Provider wiring — every tree-sitter provider MUST have heritageExtractor
// ---------------------------------------------------------------------------

describe('heritageExtractor on LanguageProvider', () => {
  it('all tree-sitter providers have heritageExtractor defined', () => {
    const languages: SupportedLanguages[] = [
      SupportedLanguages.TypeScript,
      SupportedLanguages.JavaScript,
      SupportedLanguages.Python,
      SupportedLanguages.Java,
      SupportedLanguages.Kotlin,
      SupportedLanguages.Go,
      SupportedLanguages.Rust,
      SupportedLanguages.CSharp,
      SupportedLanguages.C,
      SupportedLanguages.CPlusPlus,
      SupportedLanguages.PHP,
      SupportedLanguages.Ruby,
      SupportedLanguages.Swift,
      SupportedLanguages.Dart,
      SupportedLanguages.Vue,
    ];
    for (const lang of languages) {
      const provider = getProvider(lang);
      expect(provider.heritageExtractor, `${lang} should have a heritageExtractor`).toBeDefined();
    }
  });
});
