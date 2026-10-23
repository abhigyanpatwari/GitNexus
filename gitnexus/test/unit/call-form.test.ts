import { describe, it, expect, type TestContext } from 'vitest';
import type { MixedChainStep } from 'gitnexus-shared';
import {
  inferCallForm,
  extractReceiverName,
  extractReceiverNode,
  extractMixedChain,
} from '../../src/core/ingestion/utils/call-analysis.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';
import { createSymbolTable } from '../../src/core/ingestion/model/symbol-table.js';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Java from 'tree-sitter-java';
import CSharp from 'tree-sitter-c-sharp/bindings/node/index.js';
import { requireVendoredGrammar } from '../../src/core/tree-sitter/vendored-grammars.js';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import CPP from 'tree-sitter-cpp';
import PHP from 'tree-sitter-php';
import Ruby from 'tree-sitter-ruby';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { getProvider } from '../../src/core/ingestion/languages/index.js';

// Vendored grammar — loaded from vendor/ by absolute path, never node_modules (#2111).
const Kotlin = requireVendoredGrammar('tree-sitter-kotlin');
// Swift is optional: a host without its prebuild skips the Swift rows rather
// than failing to collect every other language's tests.
const Swift = isLanguageAvailable(SupportedLanguages.Swift)
  ? requireVendoredGrammar('tree-sitter-swift')
  : undefined;

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
      const match = captures.find((c) => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects member call', () => {
      parser.setLanguage(TypeScript.typescript);
      const captures = extractCallCaptures(parser, 'user.save()', SupportedLanguages.TypeScript);
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });
  });

  describe('Python', () => {
    it('detects free call', () => {
      parser.setLanguage(Python);
      const captures = extractCallCaptures(parser, 'print_result()', SupportedLanguages.Python);
      const match = captures.find((c) => c.calledName === 'print_result');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects member call', () => {
      parser.setLanguage(Python);
      const captures = extractCallCaptures(parser, 'self.save()', SupportedLanguages.Python);
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });
  });

  describe('Java', () => {
    it('detects free call (no object)', () => {
      parser.setLanguage(Java);
      const code = `class Foo { void run() { doStuff(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Java);
      const match = captures.find((c) => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects member call (with object)', () => {
      parser.setLanguage(Java);
      const code = `class Foo { void run() { user.save(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Java);
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });
  });

  describe('C#', () => {
    it('detects free call', () => {
      parser.setLanguage(CSharp);
      const code = `class Foo { void Run() { DoStuff(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.CSharp);
      const match = captures.find((c) => c.calledName === 'DoStuff');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects member call', () => {
      parser.setLanguage(CSharp);
      const code = `class Foo { void Run() { user.Save(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.CSharp);
      const match = captures.find((c) => c.calledName === 'Save');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });
  });

  describe('Go', () => {
    it('detects free call', () => {
      parser.setLanguage(Go);
      const code = `package main\nfunc main() { doStuff() }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Go);
      const match = captures.find((c) => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects member call via selector', () => {
      parser.setLanguage(Go);
      const code = `package main\nfunc main() { user.Save() }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Go);
      const match = captures.find((c) => c.calledName === 'Save');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });
  });

  describe('Rust', () => {
    it('detects free call', () => {
      parser.setLanguage(Rust);
      const code = `fn main() { do_stuff(); }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Rust);
      const match = captures.find((c) => c.calledName === 'do_stuff');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects member call via field_expression', () => {
      parser.setLanguage(Rust);
      const code = `fn main() { user.save(); }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Rust);
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });

    it('detects scoped call as free (Foo::new)', () => {
      parser.setLanguage(Rust);
      const code = `fn main() { Foo::new(); }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Rust);
      const match = captures.find((c) => c.calledName === 'new');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });
  });

  describe('C++', () => {
    it('detects free call', () => {
      parser.setLanguage(CPP);
      const code = `void main() { doStuff(); }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.CPlusPlus);
      const match = captures.find((c) => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects member call via field_expression', () => {
      parser.setLanguage(CPP);
      const code = `void main() { obj.run(); }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.CPlusPlus);
      const match = captures.find((c) => c.calledName === 'run');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });
  });

  describe('PHP', () => {
    it('detects free function call', () => {
      parser.setLanguage(PHP.php);
      const code = `<?php doStuff(); ?>`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.PHP);
      const match = captures.find((c) => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects member call', () => {
      parser.setLanguage(PHP.php);
      const code = `<?php $user->save(); ?>`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.PHP);
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });

    it('detects static call as member', () => {
      parser.setLanguage(PHP.php);
      const code = `<?php Foo::bar(); ?>`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.PHP);
      const match = captures.find((c) => c.calledName === 'bar');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });
  });

  describe('Kotlin', () => {
    it('detects free call', () => {
      parser.setLanguage(Kotlin);
      const code = `fun main() { doStuff() }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Kotlin);
      const match = captures.find((c) => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects member call via navigation_expression', () => {
      parser.setLanguage(Kotlin);
      const code = `fun main() { user.save() }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Kotlin);
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('member');
    });

    it('Foo() is a free call (constructor_invocation only in heritage context)', () => {
      parser.setLanguage(Kotlin);
      const code = `fun main() { val x = Foo() }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Kotlin);
      const match = captures.find((c) => c.calledName === 'Foo');
      expect(match).toBeDefined();
      // Kotlin Foo() is syntactically a call_expression, not constructor_invocation
      // Constructor discrimination happens in Phase 2 via symbol kind matching
      expect(inferCallForm(match!.callNode, match!.nameNode)).toBe('free');
    });

    it('detects constructor_invocation in heritage delegation as constructor', () => {
      parser.setLanguage(Kotlin);
      const code = `open class Base\nclass Derived : Base()`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Kotlin);
      const match = captures.find((c) => c.calledName === 'Base');
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
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('user');
    });

    it('extracts "this" as receiver', () => {
      parser.setLanguage(TypeScript.typescript);
      const code = `class Foo { run() { this.save(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.TypeScript);
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('this');
    });

    it('returns undefined for chained call receiver', () => {
      parser.setLanguage(TypeScript.typescript);
      const captures = extractCallCaptures(
        parser,
        'getUser().save()',
        SupportedLanguages.TypeScript,
      );
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBeUndefined();
    });

    it('returns undefined for free call', () => {
      parser.setLanguage(TypeScript.typescript);
      const captures = extractCallCaptures(parser, 'doStuff()', SupportedLanguages.TypeScript);
      const match = captures.find((c) => c.calledName === 'doStuff');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBeUndefined();
    });

    it('extracts receiver from optional chain call user?.save()', () => {
      parser.setLanguage(TypeScript.typescript);
      const captures = extractCallCaptures(parser, 'user?.save()', SupportedLanguages.TypeScript);
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('user');
    });

    it('extracts "this" from optional chain call this?.save()', () => {
      parser.setLanguage(TypeScript.typescript);
      const code = `class Foo { run() { this?.save(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.TypeScript);
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('this');
    });
  });

  describe('Python', () => {
    it('extracts simple identifier receiver', () => {
      parser.setLanguage(Python);
      const captures = extractCallCaptures(parser, 'user.save()', SupportedLanguages.Python);
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('user');
    });

    it('extracts "self" as receiver', () => {
      parser.setLanguage(Python);
      const captures = extractCallCaptures(parser, 'self.save()', SupportedLanguages.Python);
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('self');
    });
  });

  describe('Java', () => {
    it('extracts receiver from method_invocation', () => {
      parser.setLanguage(Java);
      const code = `class Foo { void run() { user.save(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Java);
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('user');
    });
  });

  describe('Go', () => {
    it('extracts receiver from selector_expression', () => {
      parser.setLanguage(Go);
      const code = `package main\nfunc main() { user.Save() }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Go);
      const match = captures.find((c) => c.calledName === 'Save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('user');
    });
  });

  describe('Rust', () => {
    it('extracts receiver from field_expression', () => {
      parser.setLanguage(Rust);
      const code = `fn main() { user.save(); }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Rust);
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('user');
    });
  });

  describe('C#', () => {
    it('extracts receiver from member_access_expression', () => {
      parser.setLanguage(CSharp);
      const code = `class Foo { void Run() { user.Save(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.CSharp);
      const match = captures.find((c) => c.calledName === 'Save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('user');
    });

    it('captures null-conditional user?.Save() and extracts receiver', () => {
      parser.setLanguage(CSharp);
      const code = `class Foo { void Run() { user?.Save(); } }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.CSharp);
      const match = captures.find((c) => c.calledName === 'Save');
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
      const match = captures.find((c) => c.calledName === 'save');
      expect(match).toBeDefined();
      expect(extractReceiverName(match!.nameNode)).toBe('user');
    });

    it('extracts receiver from safe navigation user?.save()', () => {
      parser.setLanguage(Kotlin);
      const code = `fun main() { user?.save() }`;
      const captures = extractCallCaptures(parser, code, SupportedLanguages.Kotlin);
      const match = captures.find((c) => c.calledName === 'save');
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

  it('propagates ownerId through a free Function registration', () => {
    // Post-A4 Unit 4, Method is no longer in FREE_CALLABLE_TYPES so this test
    // exercises ownerId propagation through the free-callable index using
    // a Function label. Method-with-ownerId propagation is covered via
    // methodsByName in method-registry.test.ts.
    const st = createSymbolTable();
    st.add('src/foo.ts', 'save', 'Function:src/foo.ts:save', 'Function', {
      ownerId: 'Class:src/foo.ts:User',
    });

    const defs = st.lookupCallableByName('save');
    expect(defs).toHaveLength(1);
    expect(defs[0].ownerId).toBe('Class:src/foo.ts:User');
  });
});

// ---------------------------------------------------------------------------
// extractMixedChain: callee and receiver spellings the chain walk has to read
// ---------------------------------------------------------------------------

/** First leaf whose text is `name`, depth-first. */
function findLeaf(node: SyntaxNode, name: string): SyntaxNode | undefined {
  if (node.namedChildCount === 0) return node.text === name ? node : undefined;
  for (const child of node.namedChildren) {
    const hit = findLeaf(child, name);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** What `extractMixedChain` reads off the receiver of the call to `member`. */
function receiverChainOf(language: Parser.Language, code: string, member: string) {
  const parser = new Parser();
  parser.setLanguage(language);
  const nameNode = findLeaf(parser.parse(code).rootNode, member);
  const receiver = nameNode === undefined ? undefined : extractReceiverNode(nameNode);
  if (receiver === undefined) throw new Error(`no receiver for ${member} in: ${code}`);
  return extractMixedChain(receiver);
}

const call = (name: string): MixedChainStep => ({ kind: 'call', name });
const field = (name: string): MixedChainStep => ({ kind: 'field', name });

interface ChainRow {
  readonly label: string;
  /** `undefined` when an optional grammar did not load on this host. */
  readonly language: Parser.Language | undefined;
  readonly code: string;
  readonly member: string;
  readonly expected: ReturnType<typeof extractMixedChain>;
}

/** A row whose grammar did not load is reported skipped, never passed. */
function expectChainRow(row: ChainRow, { skip }: TestContext): void {
  if (row.language === undefined) return skip(`grammar not available: ${row.label}`);
  expect(receiverChainOf(row.language, row.code, row.member)).toEqual(row.expected);
}

describe('extractMixedChain', () => {
  // Explicit type arguments inside the callee node (#3498 RC3). The step must be
  // named for the member, and Rust's wrapper must not hide the inner receiver.
  const typeArgumentRows: readonly ChainRow[] = [
    {
      label: 'C# generic method',
      language: CSharp,
      code: 'class A { void M() { svc.GetTyped<User>().Save(); } }',
      member: 'Save',
      expected: { chain: [call('GetTyped')], baseReceiverName: 'svc' },
    },
    {
      label: 'C# generic method then a field',
      language: CSharp,
      code: 'class A { void M() { svc.GetTyped<User>().Address.Save(); } }',
      member: 'Save',
      expected: { chain: [call('GetTyped'), field('Address')], baseReceiverName: 'svc' },
    },
    {
      label: 'C++ template method through ->',
      language: CPP,
      code: 'void f() { svc->getTyped<User>()->save(); }',
      member: 'save',
      expected: { chain: [call('getTyped')], baseReceiverName: 'svc' },
    },
    {
      label: 'C++ template method through .',
      language: CPP,
      code: 'void f() { svc.getTyped<User>().save(); }',
      member: 'save',
      expected: { chain: [call('getTyped')], baseReceiverName: 'svc' },
    },
    {
      label: 'C++ dependent template method',
      language: CPP,
      code: 'void f() { svc->template getTyped<User>()->save(); }',
      member: 'save',
      expected: { chain: [call('getTyped')], baseReceiverName: 'svc' },
    },
    {
      label: 'Rust turbofish method',
      language: Rust,
      code: 'fn f() { svc.get_typed::<User>().save(); }',
      member: 'save',
      expected: { chain: [call('get_typed')], baseReceiverName: 'svc' },
    },
    {
      label: 'Rust turbofish free function has no base, so nothing is minted',
      language: Rust,
      code: 'fn f() { get_typed::<User>().save(); }',
      member: 'save',
      expected: { chain: [call('get_typed')], baseReceiverName: undefined },
    },
    {
      label: 'C# generic free call has no base, so nothing is minted',
      language: CSharp,
      code: 'class A { void M() { GetTyped<User>().Save(); } }',
      member: 'Save',
      expected: { chain: [call('GetTyped')], baseReceiverName: undefined },
    },
    {
      label: 'C++ qualified template function has no base, so nothing is minted',
      language: CPP,
      code: 'void f() { ns::getTyped<User>()->save(); }',
      member: 'save',
      expected: { chain: [call('getTyped')], baseReceiverName: undefined },
    },
    {
      label: 'Java type arguments sit beside the name (control)',
      language: Java,
      code: 'class A { void m() { svc.<User>getTyped().save(); } }',
      member: 'save',
      expected: { chain: [call('getTyped')], baseReceiverName: 'svc' },
    },
  ];

  it.for(typeArgumentRows)('$label', expectChainRow);

  // Wrappers that denote exactly their operand (#3498 RC4): C#'s null-forgiving
  // `svc!` and Swift's single-element tuple, which is how Swift spells `(x)`.
  // A wrapper that changes the value (`i++`, a real tuple) must stay the base.
  const wrapperRows: readonly ChainRow[] = [
    {
      label: 'C# null-forgiving base',
      language: CSharp,
      code: 'class A { void M() { svc!.GetUser().Save(); } }',
      member: 'Save',
      expected: { chain: [call('GetUser')], baseReceiverName: 'svc' },
    },
    {
      label: 'C# postfix increment is not peeled',
      language: CSharp,
      code: 'class A { void M() { i++.GetUser().Save(); } }',
      member: 'Save',
      expected: { chain: [call('GetUser')], baseReceiverName: 'i++' },
    },
    {
      label: 'Swift parenthesized await',
      language: Swift,
      code: 'func f() async { (await svc.getUserAsync()).save() }',
      member: 'save',
      expected: { chain: [call('getUserAsync'), { kind: 'await' }], baseReceiverName: 'svc' },
    },
    {
      label: 'Swift parenthesized base',
      language: Swift,
      code: 'func f() { (svc).getUser().save() }',
      member: 'save',
      expected: { chain: [call('getUser')], baseReceiverName: 'svc' },
    },
    {
      label: 'Swift labelled one-element tuple is not peeled',
      language: Swift,
      code: 'func f() { (x: svc).getUser().save() }',
      member: 'save',
      expected: { chain: [call('getUser')], baseReceiverName: '(x: svc)' },
    },
    {
      label: 'Swift two-element tuple is not peeled',
      language: Swift,
      code: 'func f() { (a, b).save() }',
      member: 'save',
      expected: undefined,
    },
    {
      label: 'Rust one-element tuple keeps its trailing comma and is not peeled',
      language: Rust,
      code: 'fn f() { (svc,).get_user().save(); }',
      member: 'save',
      expected: { chain: [call('get_user')], baseReceiverName: '(svc,)' },
    },
  ];

  it.for(wrapperRows)('$label', expectChainRow);

  // C# null-conditional access (#3498 RC5): the receiver sits in the
  // `condition` field and the member in a binding child, as a callee and as a
  // receiver.
  const conditionalRows: readonly ChainRow[] = [
    {
      label: 'C# null-conditional call',
      language: CSharp,
      code: 'class A { void M() { svc?.GetUser().Save(); } }',
      member: 'Save',
      expected: { chain: [call('GetUser')], baseReceiverName: 'svc' },
    },
    {
      label: 'C# null-conditional call on both hops',
      language: CSharp,
      code: 'class A { void M() { svc?.GetUser()?.Save(); } }',
      member: 'Save',
      expected: { chain: [call('GetUser')], baseReceiverName: 'svc' },
    },
    {
      label: 'C# null-conditional call then a field',
      language: CSharp,
      code: 'class A { void M() { svc?.GetUser().Address.Save(); } }',
      member: 'Save',
      expected: { chain: [call('GetUser'), field('Address')], baseReceiverName: 'svc' },
    },
    {
      label: 'C# null-conditional generic call',
      language: CSharp,
      code: 'class A { void M() { svc?.GetTyped<User>().Save(); } }',
      member: 'Save',
      expected: { chain: [call('GetTyped')], baseReceiverName: 'svc' },
    },
    {
      label: 'C# null-conditional field',
      language: CSharp,
      code: 'class A { void M() { user?.Address.Save(); } }',
      member: 'Save',
      expected: { chain: [field('Address')], baseReceiverName: 'user' },
    },
    {
      label: 'C# null-conditional element',
      language: CSharp,
      code: 'class A { void M() { repos?[0].Save(); } }',
      member: 'Save',
      expected: { chain: [{ kind: 'index' }], baseReceiverName: 'repos' },
    },
    {
      label: 'C# null-conditional element call names no member',
      language: CSharp,
      code: 'class A { void M() { handlers?[0]().Save(); } }',
      member: 'Save',
      expected: undefined,
    },
  ];

  it.for(conditionalRows)('$label', expectChainRow);

  // Subscripts spelled as other node types (#3498 RC8): Ruby's
  // `element_reference`, and Swift's call with a bracketed argument list.
  const subscriptRows: readonly ChainRow[] = [
    {
      label: 'Ruby element reference',
      language: Ruby,
      code: 'def f(repos)\n  repos[0].save\nend\n',
      member: 'save',
      expected: { chain: [{ kind: 'index' }], baseReceiverName: 'repos' },
    },
    {
      label: 'Ruby element reference of a call',
      language: Ruby,
      code: 'def f(svc)\n  svc.get_users[0].save\nend\n',
      member: 'save',
      expected: { chain: [call('get_users'), { kind: 'index' }], baseReceiverName: 'svc' },
    },
    {
      label: 'Swift bracketed subscript',
      language: Swift,
      code: 'func f() { repos[0].save() }',
      member: 'save',
      expected: { chain: [{ kind: 'index' }], baseReceiverName: 'repos' },
    },
    {
      label: 'Swift subscript of a property is a field then an index',
      language: Swift,
      code: 'func f() { holder.users[0].save() }',
      member: 'save',
      expected: { chain: [field('users'), { kind: 'index' }], baseReceiverName: 'holder' },
    },
    {
      label: 'Swift subscript of a call result',
      language: Swift,
      code: 'func f() { svc.getUsers()[0].save() }',
      member: 'save',
      expected: { chain: [call('getUsers'), { kind: 'index' }], baseReceiverName: 'svc' },
    },
    {
      label: 'Swift parenthesized call stays a call',
      language: Swift,
      code: 'func f() { svc.getUser(0).save() }',
      member: 'save',
      expected: { chain: [call('getUser')], baseReceiverName: 'svc' },
    },
    {
      label: 'Swift trailing-closure call stays a call',
      language: Swift,
      code: 'func f() { svc.getUsers { $0 }.save() }',
      member: 'save',
      expected: { chain: [call('getUsers')], baseReceiverName: 'svc' },
    },
    // Kotlin shares `call_suffix → value_arguments`; its subscripts are
    // `indexing_expression`, so its calls must never read as index steps.
    {
      label: 'Kotlin parenthesized call stays a call',
      language: Kotlin,
      code: 'fun f() { svc.getUser(0).save() }',
      member: 'save',
      expected: { chain: [call('getUser')], baseReceiverName: 'svc' },
    },
    {
      label: 'Kotlin generic call stays a call',
      language: Kotlin,
      code: 'fun f() { svc.getTyped<User>().save() }',
      member: 'save',
      expected: { chain: [call('getTyped')], baseReceiverName: 'svc' },
    },
  ];

  it.for(subscriptRows)('$label', expectChainRow);
});
