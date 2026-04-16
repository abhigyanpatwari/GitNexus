import { describe, it, expect } from 'vitest';
import { createCallExtractor } from '../../src/core/ingestion/call-extractors/generic.js';
import {
  javaCallConfig,
  kotlinCallConfig,
} from '../../src/core/ingestion/call-extractors/configs/jvm.js';
import { csharpCallConfig } from '../../src/core/ingestion/call-extractors/configs/csharp.js';
import {
  typescriptCallConfig,
  javascriptCallConfig,
} from '../../src/core/ingestion/call-extractors/configs/typescript-javascript.js';
import {
  cCallConfig,
  cppCallConfig,
} from '../../src/core/ingestion/call-extractors/configs/c-cpp.js';
import { pythonCallConfig } from '../../src/core/ingestion/call-extractors/configs/python.js';
import { rubyCallConfig } from '../../src/core/ingestion/call-extractors/configs/ruby.js';
import { rustCallConfig } from '../../src/core/ingestion/call-extractors/configs/rust.js';
import { dartCallConfig } from '../../src/core/ingestion/call-extractors/configs/dart.js';
import { phpCallConfig } from '../../src/core/ingestion/call-extractors/configs/php.js';
import { swiftCallConfig } from '../../src/core/ingestion/call-extractors/configs/swift.js';
import { goCallConfig } from '../../src/core/ingestion/call-extractors/configs/go.js';
import type { CallExtractionConfig } from '../../src/core/ingestion/call-types.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Java from 'tree-sitter-java';
import CSharp from 'tree-sitter-c-sharp';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import CPP from 'tree-sitter-cpp';
import PHP from 'tree-sitter-php';
import Ruby from 'tree-sitter-ruby';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse code with a tree-sitter language and run the language's query to find
 * @call / @call.name captures.
 */
function extractCallCaptures(
  parser: Parser,
  code: string,
  language: SupportedLanguages,
): Array<{
  callNode: SyntaxNode;
  nameNode: SyntaxNode | undefined;
  calledName: string | undefined;
}> {
  const provider = getProvider(language);
  const queryStr = provider.treeSitterQueries;
  if (!queryStr) throw new Error(`No query for ${language}`);

  const tree = parser.parse(code);
  const lang = parser.getLanguage();
  const query = new Parser.Query(lang, queryStr);
  const matches = query.matches(tree.rootNode);

  const results: Array<{
    callNode: SyntaxNode;
    nameNode: SyntaxNode | undefined;
    calledName: string | undefined;
  }> = [];

  for (const match of matches) {
    const captureMap: Record<string, SyntaxNode> = {};
    for (const c of match.captures) {
      captureMap[c.name] = c.node;
    }
    if (captureMap['call']) {
      results.push({
        callNode: captureMap['call'],
        nameNode: captureMap['call.name'],
        calledName: captureMap['call.name']?.text,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Factory construction tests
// ---------------------------------------------------------------------------

describe('createCallExtractor', () => {
  it('constructs all currently registered language configs', () => {
    const configs: CallExtractionConfig[] = [
      javaCallConfig,
      kotlinCallConfig,
      csharpCallConfig,
      typescriptCallConfig,
      javascriptCallConfig,
      cCallConfig,
      cppCallConfig,
      pythonCallConfig,
      rubyCallConfig,
      rustCallConfig,
      dartCallConfig,
      phpCallConfig,
      swiftCallConfig,
      goCallConfig,
    ];
    for (const cfg of configs) {
      expect(
        () => createCallExtractor(cfg),
        `config for ${cfg.language} must construct cleanly`,
      ).not.toThrow();
    }
  });

  it('preserves language on the extractor', () => {
    const extractor = createCallExtractor(javaCallConfig);
    expect(extractor.language).toBe(SupportedLanguages.Java);
  });

  it('returns null when no callNameNode and no language seed', () => {
    const extractor = createCallExtractor(typescriptCallConfig);
    // A minimal stub SyntaxNode — extract should return null since
    // there's no callNameNode and no language-specific hook
    const stub = { type: 'call_expression' } as unknown as SyntaxNode;
    expect(extractor.extract(stub, undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LanguageProvider.callExtractor wiring
// ---------------------------------------------------------------------------

describe('callExtractor on LanguageProvider', () => {
  it('all tree-sitter providers have callExtractor defined', () => {
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
      expect(provider.callExtractor, `${lang} should have a callExtractor`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Generic extraction via @call.name
// ---------------------------------------------------------------------------

describe('generic call extraction', () => {
  const parser = new Parser();

  describe('TypeScript', () => {
    const extractor = createCallExtractor(typescriptCallConfig);

    it('extracts free function call', () => {
      parser.setLanguage(TypeScript.typescript);
      const captures = extractCallCaptures(parser, 'doStuff()', SupportedLanguages.TypeScript);
      const match = captures.find((c) => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      expect(result).not.toBeNull();
      expect(result!.calledName).toBe('doStuff');
      expect(result!.callForm).toBe('free');
      expect(result!.receiverName).toBeUndefined();
    });

    it('extracts member call with receiver', () => {
      parser.setLanguage(TypeScript.typescript);
      const captures = extractCallCaptures(parser, 'user.save()', SupportedLanguages.TypeScript);
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      expect(result).not.toBeNull();
      expect(result!.calledName).toBe('save');
      expect(result!.callForm).toBe('member');
      expect(result!.receiverName).toBe('user');
    });

    it('extracts constructor call', () => {
      parser.setLanguage(TypeScript.typescript);
      const captures = extractCallCaptures(parser, 'new User()', SupportedLanguages.TypeScript);
      const match = captures.find((c) => c.calledName === 'User');
      expect(match).toBeDefined();
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      expect(result).not.toBeNull();
      expect(result!.calledName).toBe('User');
      expect(result!.callForm).toBe('constructor');
    });

    it('extracts argCount', () => {
      parser.setLanguage(TypeScript.typescript);
      const captures = extractCallCaptures(parser, 'foo(a, b, c)', SupportedLanguages.TypeScript);
      const match = captures.find((c) => c.calledName === 'foo');
      expect(match).toBeDefined();
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      expect(result).not.toBeNull();
      expect(result!.argCount).toBe(3);
    });

    it('does not set typeAsReceiverHeuristic', () => {
      parser.setLanguage(TypeScript.typescript);
      const captures = extractCallCaptures(parser, 'User.find()', SupportedLanguages.TypeScript);
      const match = captures.find((c) => c.calledName === 'find');
      expect(match).toBeDefined();
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      expect(result!.typeAsReceiverHeuristic).toBeFalsy();
    });
  });

  describe('Python', () => {
    const extractor = createCallExtractor(pythonCallConfig);

    it('extracts free function call', () => {
      parser.setLanguage(Python);
      const captures = extractCallCaptures(parser, 'do_stuff()', SupportedLanguages.Python);
      const match = captures.find((c) => c.calledName === 'do_stuff');
      expect(match).toBeDefined();
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      expect(result).not.toBeNull();
      expect(result!.calledName).toBe('do_stuff');
      expect(result!.callForm).toBe('free');
    });

    it('extracts member call', () => {
      parser.setLanguage(Python);
      const captures = extractCallCaptures(parser, 'user.save()', SupportedLanguages.Python);
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      expect(result).not.toBeNull();
      expect(result!.callForm).toBe('member');
      expect(result!.receiverName).toBe('user');
    });
  });

  describe('Java', () => {
    const extractor = createCallExtractor(javaCallConfig);

    it('extracts free function call', () => {
      parser.setLanguage(Java);
      const captures = extractCallCaptures(
        parser,
        'class A { void m() { doStuff(); } }',
        SupportedLanguages.Java,
      );
      const match = captures.find((c) => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      expect(result).not.toBeNull();
      expect(result!.calledName).toBe('doStuff');
      expect(result!.callForm).toBe('free');
    });

    it('extracts member call with receiver', () => {
      parser.setLanguage(Java);
      const captures = extractCallCaptures(
        parser,
        'class A { void m() { user.save(); } }',
        SupportedLanguages.Java,
      );
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      expect(result).not.toBeNull();
      expect(result!.callForm).toBe('member');
      expect(result!.receiverName).toBe('user');
    });

    it('sets typeAsReceiverHeuristic', () => {
      parser.setLanguage(Java);
      const captures = extractCallCaptures(
        parser,
        'class A { void m() { User.find(); } }',
        SupportedLanguages.Java,
      );
      const match = captures.find((c) => c.calledName === 'find');
      expect(match).toBeDefined();
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      expect(result).not.toBeNull();
      expect(result!.typeAsReceiverHeuristic).toBe(true);
    });
  });

  describe('C#', () => {
    const extractor = createCallExtractor(csharpCallConfig);

    it('extracts member call with receiver and typeAsReceiverHeuristic', () => {
      parser.setLanguage(CSharp);
      const captures = extractCallCaptures(
        parser,
        'class A { void M() { Console.WriteLine(); } }',
        SupportedLanguages.CSharp,
      );
      const match = captures.find((c) => c.calledName === 'WriteLine');
      expect(match).toBeDefined();
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      expect(result).not.toBeNull();
      expect(result!.calledName).toBe('WriteLine');
      expect(result!.callForm).toBe('member');
      expect(result!.receiverName).toBe('Console');
      expect(result!.typeAsReceiverHeuristic).toBe(true);
    });

    it('sets typeAsReceiverHeuristic flag even for lowercase receivers', () => {
      parser.setLanguage(CSharp);
      const captures = extractCallCaptures(
        parser,
        'class A { void M() { logger.Info(); } }',
        SupportedLanguages.CSharp,
      );
      const match = captures.find((c) => c.calledName === 'Info');
      expect(match).toBeDefined();
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      expect(result).not.toBeNull();
      // typeAsReceiverHeuristic is set on the config/extractor level (true for C#),
      // but the uppercase check happens in parse-worker, not the extractor itself
      expect(result!.typeAsReceiverHeuristic).toBe(true);
      expect(result!.receiverName).toBe('logger');
    });
  });

  describe('Go', () => {
    const extractor = createCallExtractor(goCallConfig);

    it('extracts free function call', () => {
      parser.setLanguage(Go);
      const captures = extractCallCaptures(
        parser,
        'package main\nfunc main() { doStuff() }',
        SupportedLanguages.Go,
      );
      const match = captures.find((c) => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      expect(result).not.toBeNull();
      expect(result!.calledName).toBe('doStuff');
      expect(result!.callForm).toBe('free');
    });
  });

  describe('Rust', () => {
    const extractor = createCallExtractor(rustCallConfig);

    it('extracts free function call', () => {
      parser.setLanguage(Rust);
      const captures = extractCallCaptures(
        parser,
        'fn main() { do_stuff(); }',
        SupportedLanguages.Rust,
      );
      const match = captures.find((c) => c.calledName === 'do_stuff');
      expect(match).toBeDefined();
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      expect(result).not.toBeNull();
      expect(result!.calledName).toBe('do_stuff');
    });
  });

  describe('C++', () => {
    const extractor = createCallExtractor(cppCallConfig);

    it('extracts free function call', () => {
      parser.setLanguage(CPP);
      const captures = extractCallCaptures(
        parser,
        'void f() { doStuff(); }',
        SupportedLanguages.CPlusPlus,
      );
      const match = captures.find((c) => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      expect(result).not.toBeNull();
      expect(result!.calledName).toBe('doStuff');
      expect(result!.callForm).toBe('free');
    });
  });

  describe('PHP', () => {
    const extractor = createCallExtractor(phpCallConfig);

    it('extracts free function call', () => {
      parser.setLanguage(PHP.php);
      const captures = extractCallCaptures(parser, '<?php doStuff(); ?>', SupportedLanguages.PHP);
      const match = captures.find((c) => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      expect(result).not.toBeNull();
      expect(result!.calledName).toBe('doStuff');
    });
  });

  describe('Ruby', () => {
    const extractor = createCallExtractor(rubyCallConfig);

    it('extracts member call', () => {
      parser.setLanguage(Ruby);
      const captures = extractCallCaptures(parser, 'user.save()', SupportedLanguages.Ruby);
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      const result = extractor.extract(match!.callNode, match!.nameNode!);
      expect(result).not.toBeNull();
      expect(result!.callForm).toBe('member');
      expect(result!.receiverName).toBe('user');
    });
  });
});

// ---------------------------------------------------------------------------
// Language-specific call site extraction (Java :: method references)
// ---------------------------------------------------------------------------

describe('Java method_reference extraction', () => {
  const parser = new Parser();
  parser.setLanguage(Java);
  const extractor = createCallExtractor(javaCallConfig);

  it('extracts Type::new as constructor', () => {
    const captures = extractCallCaptures(
      parser,
      'class A { void m() { stream.map(User::new); } }',
      SupportedLanguages.Java,
    );
    // The method_reference should be captured as @call
    const match = captures.find((c) => c.callNode.type === 'method_reference');
    if (match) {
      const result = extractor.extract(match.callNode, undefined);
      expect(result).not.toBeNull();
      expect(result!.calledName).toBe('User');
      expect(result!.callForm).toBe('constructor');
    }
  });

  it('extracts Type::method as member call', () => {
    const captures = extractCallCaptures(
      parser,
      'class A { void m() { stream.map(User::getName); } }',
      SupportedLanguages.Java,
    );
    const match = captures.find((c) => c.callNode.type === 'method_reference');
    if (match) {
      const result = extractor.extract(match.callNode, undefined);
      expect(result).not.toBeNull();
      expect(result!.calledName).toBe('getName');
      expect(result!.callForm).toBe('member');
      expect(result!.receiverName).toBe('User');
      expect(result!.typeAsReceiverHeuristic).toBe(true);
    }
  });

  it('extracts this::method as member call', () => {
    const captures = extractCallCaptures(
      parser,
      'class A { void m() { stream.map(this::process); } }',
      SupportedLanguages.Java,
    );
    const match = captures.find((c) => c.callNode.type === 'method_reference');
    if (match) {
      const result = extractor.extract(match.callNode, undefined);
      expect(result).not.toBeNull();
      expect(result!.calledName).toBe('process');
      expect(result!.callForm).toBe('member');
      expect(result!.receiverName).toBe('this');
    }
  });

  it('extractLanguageCallSite returns null for non-method_reference nodes', () => {
    const captures = extractCallCaptures(
      parser,
      'class A { void m() { doStuff(); } }',
      SupportedLanguages.Java,
    );
    const match = captures.find((c) => c.calledName === 'doStuff');
    expect(match).toBeDefined();
    // Language seed should be null for regular calls
    const langSeed = extractor.extract(match!.callNode, undefined);
    expect(langSeed).toBeNull();
    // But full extraction with callNameNode should work
    const full = extractor.extract(match!.callNode, match!.nameNode!);
    expect(full).not.toBeNull();
    expect(full!.calledName).toBe('doStuff');
  });
});

// ---------------------------------------------------------------------------
// typeAsReceiverHeuristic config flag
// ---------------------------------------------------------------------------

describe('typeAsReceiverHeuristic config', () => {
  it('JVM configs set typeAsReceiverHeuristic', () => {
    expect(javaCallConfig.typeAsReceiverHeuristic).toBe(true);
    expect(kotlinCallConfig.typeAsReceiverHeuristic).toBe(true);
  });

  it('C# config sets typeAsReceiverHeuristic', () => {
    expect(csharpCallConfig.typeAsReceiverHeuristic).toBe(true);
  });

  it('other configs do not set typeAsReceiverHeuristic', () => {
    expect(typescriptCallConfig.typeAsReceiverHeuristic).toBeFalsy();
    expect(javascriptCallConfig.typeAsReceiverHeuristic).toBeFalsy();
    expect(pythonCallConfig.typeAsReceiverHeuristic).toBeFalsy();
    expect(rubyCallConfig.typeAsReceiverHeuristic).toBeFalsy();
    expect(goCallConfig.typeAsReceiverHeuristic).toBeFalsy();
    expect(rustCallConfig.typeAsReceiverHeuristic).toBeFalsy();
    expect(cCallConfig.typeAsReceiverHeuristic).toBeFalsy();
    expect(cppCallConfig.typeAsReceiverHeuristic).toBeFalsy();
    expect(phpCallConfig.typeAsReceiverHeuristic).toBeFalsy();
    expect(dartCallConfig.typeAsReceiverHeuristic).toBeFalsy();
    expect(swiftCallConfig.typeAsReceiverHeuristic).toBeFalsy();
  });
});
