import { describe, it, expect } from 'vitest';
import { inferCallForm, extractReceiverName } from '../../src/core/ingestion/utils/call-analysis.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';
import { createSymbolTable } from '../../src/core/ingestion/symbol-table.js';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Java from 'tree-sitter-java';
import CSharp from 'tree-sitter-c-sharp';
import Kotlin from 'tree-sitter-kotlin';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import CPP from 'tree-sitter-cpp';
import PHP from 'tree-sitter-php';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { getProvider } from '../../src/core/ingestion/languages/index.js';

/**
 * Helper: parse code, run the language query, and return all @call captures
 * as { callNode, nameNode } pairs.
 */
function extractCallCaptures(
  parser: Parser,
  code: string,
  language: string,
): Array<{ callNode: SyntaxNode; nameNode: SyntaxNode; calledName: string }> {
  const provider = getProvider(language as SupportedLanguages);
  const queryStr = provider.treeSitterQueries;
  if (!queryStr) throw new Error(`No query for ${language}`);

  const tree = parser.parse(code);
  const lang = parser.getLanguage();
  const query = new Parser.Query(lang, queryStr);
  const matches = query.matches(tree.rootNode);

  const results: Array<{ callNode: SyntaxNode; nameNode: SyntaxNode; calledName: string }> = [];

  for (const match of matches) {
    const captureMap: Record<string, SyntaxNode> = {};
    for (const c of match.captures) {
      captureMap[c.name] = c.node;
    }
    if (captureMap['call'] && captureMap['call.name']) {
      results.push({
        callNode: captureMap['call'],
        nameNode: captureMap['call.name'],
        calledName: captureMap['call.name'].text,
      });
    }
  }

  return results;
}

describe('inferCallForm', () => {
  const parser = new Parser();

  describe('TypeScript', () => {
    it('detects free call', () => {
      parser.setLanguage(TypeScript.typescript);
      const captures = extractCallCaptures(parser, 'doStuff()', SupportedLanguages.TypeScript);
      const match = captures.find(c => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects member call', () => {
      parser.setLanguage(TypeScript.typescript);
      const captures = extractCallCaptures(parser, 'user.save()', SupportedLanguages.TypeScript);
      const match = captures.find(c => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });
  });

  describe('Python', () => {
    it('detects free call', () => {
      parser.setLanguage(Python);
      const captures = extractCallCaptures(parser, 'print_result()', SupportedLanguages.Python);
      const match = captures.find(c => c.calledName === 'print_result');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects member call', () => {
      parser.setLanguage(Python);
      const captures = extractCallCaptures(parser, 'self.save()', SupportedLanguages.Python);
      const match = captures.find(c => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });
  });

  describe('Java', () => {
    it('detects free call (no object)', () => {
      parser.setLanguage(Java);
      const code = `class Foo { void run() { doStuff(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Java);
      const match = captures.find(c => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects member call (with object)', () => {
      parser.setLanguage(Java);
      const code = `class Foo { void run() { user.save(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Java);
      const match = captures.find(c => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });
  });

  describe('C#', () => {
    it('detects free call', () => {
      parser.setLanguage(CSharp);
      const code = `class Foo { void Run() { DoStuff(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.CSharp);
      const match = captures.find(c => c.calledName === 'DoStuff');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects member call', () => {
      parser.setLanguage(CSharp);
      const code = `class Foo { void Run() { user.Save(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.CSharp);
      const match = captures.find(c => c.calledName === 'Save');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });
  });

  describe('Go', () => {
    it('detects free call', () => {
      parser.setLanguage(Go);
      const code = `package main\nfunc main() { doStuff() }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Go);
      const match = captures.find(c => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects member call via selector', () => {
      parser.setLanguage(Go);
      const code = `package main\nfunc main() { user.Save() }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Go);
      const match = captures.find(c => c.calledName === 'Save');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });
  });

  describe('Rust', () => {
    it('detects free call', () => {
      parser.setLanguage(Rust);
      const code = `fn main() { do_stuff(); }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Rust);
      const match = captures.find(c => c.calledName === 'do_stuff');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects member call via field_expression', () => {
      parser.setLanguage(Rust);
      const code = `fn main() { user.save(); }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Rust);
      const match = captures.find(c => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });

    it('detects scoped call as free (Foo::new)', () => {
      parser.setLanguage(Rust);
      const code = `fn main() { Foo::new(); }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Rust);
      const match = captures.find(c => c.calledName === 'new');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });
  });

  describe('C++', () => {
    it('detects free call', () => {
      parser.setLanguage(CPP);
      const code = `void main() { doStuff(); }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.CPlusPlus);
      const match = captures.find(c => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects member call via field_expression', () => {
      parser.setLanguage(CPP);
      const code = `void main() { obj.run(); }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.CPlusPlus);
      const match = captures.find(c => c.calledName === 'run');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });
  });

  describe('PHP', () => {
    it('detects free function call', () => {
      parser.setLanguage(PHP.php);
      const code = `<?php doStuff(); ?>`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.PHP);
      const match = captures.find(c => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects member call', () => {
      parser.setLanguage(PHP.php);
      const code = `<?php $user->save(); ?>`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.PHP);
      const match = captures.find(c => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });

    it('detects static call as member', () => {
      parser.setLanguage(PHP.php);
      const code = `<?php Foo::bar(); ?>`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.PHP);
      const match = captures.find(c => c.calledName === 'bar');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });
  });

  describe('Kotlin', () => {
    it('detects free call', () => {
      parser.setLanguage(Kotlin);
      const code = `fun main() { doStuff() }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Kotlin);
      const match = captures.find(c => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects member call via navigation_expression', () => {
      parser.setLanguage(Kotlin);
      const code = `fun main() { user.save() }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Kotlin);
      const match = captures.find(c => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });

    it('Foo() is a free call (constructor_invocation only in heritage context)', () => {
      parser.setLanguage(Kotlin);
      const code = `fun main() { val x = Foo() }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Kotlin);
      const match = captures.find(c => c.calledName === 'Foo');
      expect(match).toBeDefined();
      // Kotlin Foo() is syntactically a call_expression, not constructor_invocation
      // Constructor discrimination happens in Phase 2 via symbol kind matching
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects constructor_invocation in heritage delegation as constructor', () => {
      parser.setLanguage(Kotlin);
      const code = `open class Base\nclass Derived : Base()`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Kotlin);
      const match = captures.find(c => c.calledName === 'Base');
      // constructor_invocation is captured by heritage queries, not call queries
      // If it happens to be captured, it should be 'constructor'
      if (match) {
        expect(inferCallForm(match.callNode, match.nameNode)).toBe('constructor');
      }
    });
  });
});

describe('extractReceiverName', () => {
  const parser = new Parser();

  describe('TypeScript', () => {
    it('extracts simple identifier receiver', () => {
      parser.setLanguage(TypeScript.typescript);
      const captures = extractCallCaptures(parser, 'user.save()', SupportedLanguages.TypeScript);
      const match = captures.find(c => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('user');
    });

    it('extracts "this" as receiver', () => {
      parser.setLanguage(TypeScript.typescript);
      const code = `class Foo { run() { this.save(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.TypeScript);
      const match = captures.find(c => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('this');
    });

    it('returns undefined for chained call receiver', () => {
      parser.setLanguage(TypeScript.typescript);
      const captures = extractCallCaptures(parser, 'getUser().save()', SupportedLanguages.TypeScript);
      const match = captures.find(c => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBeUndefined();
    });

    it('returns undefined for free call', () => {
      parser.setLanguage(TypeScript.typescript);
      const captures = extractCallCaptures(parser, 'doStuff()', SupportedLanguages.TypeScript);
      const match = captures.find(c => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBeUndefined();
    });

    it('extracts receiver from optional chain call user?.save()', () => {
      parser.setLanguage(TypeScript.typescript);
      const captures = extractCallCaptures(parser, 'user?.save()', SupportedLanguages.TypeScript);
      const match = captures.find(c => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('user');
    });

    it('extracts "this" from optional chain call this?.save()', () => {
      parser.setLanguage(TypeScript.typescript);
      const code = `class Foo { run() { this?.save(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.TypeScript);
      const match = captures.find(c => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('this');
    });
  });

  describe('Python', () => {
    it('extracts simple identifier receiver', () => {
      parser.setLanguage(Python);
      const captures = extractCallCaptures(parser, 'user.save()', SupportedLanguages.Python);
      const match = captures.find(c => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('user');
    });

    it('extracts "self" as receiver', () => {
      parser.setLanguage(Python);
      const captures = extractCallCaptures(parser, 'self.save()', SupportedLanguages.Python);
      const match = captures.find(c => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('self');
    });
  });

  describe('Java', () => {
    it('extracts receiver from method_invocation', () => {
      parser.setLanguage(Java);
      const code = `class Foo { void run() { user.save(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Java);
      const match = captures.find(c => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('user');
    });
  });

  describe('Go', () => {
    it('extracts receiver from selector_expression', () => {
      parser.setLanguage(Go);
      const code = `package main\nfunc main() { user.Save() }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Go);
      const match = captures.find(c => c.calledName === 'Save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('user');
    });
  });

  describe('Rust', () => {
    it('extracts receiver from field_expression', () => {
      parser.setLanguage(Rust);
      const code = `fn main() { user.save(); }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Rust);
      const match = captures.find(c => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('user');
    });
  });

  describe('C#', () => {
    it('extracts receiver from member_access_expression', () => {
      parser.setLanguage(CSharp);
      const code = `class Foo { void Run() { user.Save(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.CSharp);
      const match = captures.find(c => c.calledName === 'Save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('user');
    });

    it('captures null-conditional user?.Save() and extracts receiver', () => {
      parser.setLanguage(CSharp);
      const code = `class Foo { void Run() { user?.Save(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.CSharp);
      const match = captures.find(c => c.calledName === 'Save');
      // C# conditional_access_expression (user?.Save()) is now captured via member_binding_expression
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
      expect(extractReceiverName(match!.nameNode)).toBe('user');
    });
  });

  describe('Kotlin', () => {
    it('extracts receiver from navigation_expression', () => {
      parser.setLanguage(Kotlin);
      const code = `fun main() { user.save() }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Kotlin);
      const match = captures.find(c => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('user');
    });

    it('extracts receiver from safe navigation user?.save()', () => {
      parser.setLanguage(Kotlin);
      const code = `fun main() { user?.save() }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Kotlin);
      const match = captures.find(c => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('user');
    });
  });
});

describe('ownerId on SymbolDefinition', () => {
  it('is set for Method symbols via symbolTable.add()', () => {
    const st = createSymbolTable();
    st.add('src/foo.ts', 'save', 'Method:src/foo.ts:save', 'Method', {
      parameterCount: 1,
      ownerId: 'Class:src/foo.ts:User',
    });

    const def = st.lookupExactFull('src/foo.ts', 'save');
    expect(def).toBeDefined();
    expect(def!.ownerId).toBe('Class:src/foo.ts:User');
    expect(def!.parameterCount).toBe(1);
  });

  it('is undefined for Function symbols (no owner)', () => {
    const st = createSymbolTable();
    st.add('src/foo.ts', 'helper', 'Function:src/foo.ts:helper', 'Function');

    const def = st.lookupExactFull('src/foo.ts', 'helper');
    expect(def).toBeDefined();
    expect(def!.ownerId).toBeUndefined();
  });

  it('propagates ownerId through lookupFuzzy', () => {
    const st = createSymbolTable();
    st.add('src/foo.ts', 'save', 'Method:src/foo.ts:save', 'Method', {
      ownerId: 'Class:src/foo.ts:User',
    });

    const defs = st.lookupFuzzy('save');
    expect(defs).toHaveLength(1);
    expect(defs[0].ownerId).toBe('Class:src/foo.ts:User');
  });
});
