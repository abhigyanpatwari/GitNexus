import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import CPP from 'tree-sitter-cpp';
import { stripUeMacros } from '../../src/core/ingestion/cpp-ue-preprocessor.js';

describe('stripUeMacros — detection guard', () => {
  it('returns input unchanged when no UE markers are present', () => {
    const src = `class Plain {\npublic:\n  int Get() const;\n};`;
    expect(stripUeMacros(src)).toBe(src);
  });

  it('returns input unchanged for STL-style code', () => {
    const src = `#include <vector>\nstd::vector<int> v;`;
    expect(stripUeMacros(src)).toBe(src);
  });
});

describe('stripUeMacros — length preservation', () => {
  const ueSamples: string[] = [
    `UCLASS()\nclass BRAWLUI_API UMyClass : public UObject { GENERATED_BODY() public: UFUNCTION() void Run(); };`,
    `UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Combat") int32 Health;`,
    `USTRUCT(BlueprintType)\nstruct ENGINE_API FMyData { GENERATED_BODY() float Value; };`,
    `DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FMyDelegate, int32, A, FString, B);`,
    `UE_DEPRECATED(5.0, "Use NewThing instead") void OldThing();`,
  ];

  for (const src of ueSamples) {
    it(`preserves byte length: ${src.slice(0, 40).replace(/\n/g, '\\n')}…`, () => {
      const out = stripUeMacros(src);
      expect(out.length).toBe(src.length);
    });

    it(`preserves newline positions: ${src.slice(0, 40).replace(/\n/g, '\\n')}…`, () => {
      const out = stripUeMacros(src);
      const inputNewlines: number[] = [];
      const outputNewlines: number[] = [];
      for (let i = 0; i < src.length; i++) {
        if (src.charCodeAt(i) === 0x0a) inputNewlines.push(i);
        if (out.charCodeAt(i) === 0x0a) outputNewlines.push(i);
      }
      expect(outputNewlines).toEqual(inputNewlines);
    });
  }
});

describe('stripUeMacros — macro removal', () => {
  it('elides UCLASS(...) with arguments', () => {
    const src = `UCLASS(BlueprintType, Category="Foo")\nclass UFoo {};`;
    const out = stripUeMacros(src);
    expect(out).not.toContain('UCLASS');
    expect(out).not.toContain('BlueprintType');
    expect(out).toContain('class UFoo {};');
  });

  it('elides UCLASS() with empty parens', () => {
    const src = `UCLASS()\nclass UBar {};`;
    const out = stripUeMacros(src);
    expect(out).not.toContain('UCLASS');
    expect(out).toContain('class UBar {};');
  });

  it('elides MODULE_API export macros (BRAWLUI_API style) when paired with a UE marker', () => {
    const src = `UCLASS()\nclass BRAWLUI_API UMyClass : public UObject {};`;
    const out = stripUeMacros(src);
    expect(out).not.toContain('BRAWLUI_API');
    expect(out).toContain('class');
    expect(out).toContain('UMyClass');
    expect(out).toContain('public UObject');
  });

  it('elides multiple distinct *_API tokens in same file when UE marker is present', () => {
    const src = `UCLASS()\nclass CORE_API A {};\nUCLASS()\nclass UMG_API B : public A {};`;
    const out = stripUeMacros(src);
    expect(out).not.toContain('CORE_API');
    expect(out).not.toContain('UMG_API');
    expect(out).toContain('class');
    expect(out).toContain('A {};');
  });

  it('elides GENERATED_BODY() inside class body', () => {
    const src = `class UThing { GENERATED_BODY() public: void Foo(); };`;
    const out = stripUeMacros(src);
    expect(out).not.toContain('GENERATED_BODY');
    expect(out).toContain('public:');
    expect(out).toContain('void Foo();');
  });

  it('elides UFUNCTION(...) before method declarations', () => {
    const src = `class X { UFUNCTION(BlueprintCallable, Server, Reliable) void DoThing(); };`;
    const out = stripUeMacros(src);
    expect(out).not.toContain('UFUNCTION');
    expect(out).not.toContain('BlueprintCallable');
    expect(out).toContain('void DoThing();');
  });

  it('elides UPROPERTY(...) before field declarations', () => {
    const src = `class X { UPROPERTY(EditAnywhere) int32 Health; };`;
    const out = stripUeMacros(src);
    expect(out).not.toContain('UPROPERTY');
    expect(out).not.toContain('EditAnywhere');
    expect(out).toContain('int32 Health;');
  });

  it('elides DECLARE_DYNAMIC_MULTICAST_DELEGATE_*Params(...)', () => {
    const src = `DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FMyDelegate, int32, Value);\nclass X {};`;
    const out = stripUeMacros(src);
    expect(out).not.toContain('DECLARE_DYNAMIC_MULTICAST_DELEGATE');
    expect(out).not.toContain('FMyDelegate');
    expect(out).toContain('class X {};');
  });

  it('elides UE_DEPRECATED(...) before function declarations', () => {
    const src = `UE_DEPRECATED(5.1, "Reason") void Old();`;
    const out = stripUeMacros(src);
    expect(out).not.toContain('UE_DEPRECATED');
    expect(out).not.toContain('5.1');
    expect(out).toContain('void Old();');
  });
});

describe('stripUeMacros — non-UE files left alone', () => {
  it('does NOT strip standalone *_API identifiers when no UE marker is present', () => {
    const src = `enum class Status { REST_API = 1, HTTP_API = 2, MY_LIB_API = 3 };\nvoid handle(REST_API status);`;
    expect(stripUeMacros(src)).toBe(src);
  });

  it('does NOT strip _API tokens in a file that only mentions DECLARE_DELEGATE-like macros from non-UE codebases', () => {
    const src = `// Custom delegate framework, not UE\n#define DECLARE_HANDLER(x) void x()\nDECLARE_HANDLER(MyHandler);\nint REST_API = 0;`;
    expect(stripUeMacros(src)).toBe(src);
  });
});

describe('stripUeMacros — non-ASCII content preservation', () => {
  it('leaves non-ASCII content outside elided ranges intact and at the same .length offset', () => {
    const src = `// Comment with non-ASCII: café résumé naïve\nUCLASS()\nclass UMyClass : public UObject\n{\n  GENERATED_BODY()\n  // Trailing: 日本語 αβγ\n};`;
    const out = stripUeMacros(src);
    expect(out.length).toBe(src.length);
    expect(out).toContain('café résumé naïve');
    expect(out).toContain('日本語 αβγ');
    expect(out).toContain('class UMyClass : public UObject');
    expect(out).not.toContain('UCLASS');
    expect(out).not.toContain('GENERATED_BODY');
  });

  it('preserves newline positions when the file contains non-ASCII characters', () => {
    const src = `// café\nUPROPERTY()\nint32 Health;\n// résumé\nUFUNCTION()\nvoid Run();`;
    const out = stripUeMacros(src);
    const inputNewlines: number[] = [];
    const outputNewlines: number[] = [];
    for (let i = 0; i < src.length; i++) {
      if (src.charCodeAt(i) === 0x0a) inputNewlines.push(i);
      if (out.charCodeAt(i) === 0x0a) outputNewlines.push(i);
    }
    expect(outputNewlines).toEqual(inputNewlines);
  });
});

describe('stripUeMacros — false-positive guards', () => {
  it('does NOT strip identifiers that merely contain UCLASS as a substring', () => {
    const src = `void NotUCLASSAtAll(); int MyUCLASS = 0;`;
    const out = stripUeMacros(src);
    expect(out).toBe(src);
  });

  it('does NOT strip _API substrings inside larger identifiers', () => {
    const src = `class MY_APIName {};\nint not_my_API_thing = 0;`;
    const out = stripUeMacros(src);
    expect(out).toContain('MY_APIName');
    expect(out).toContain('not_my_API_thing');
  });

  it('does not eat parens balanced inside string literals', () => {
    const src = `UFUNCTION(meta=(DisplayName="Foo (Bar)")) void Z();`;
    const out = stripUeMacros(src);
    expect(out).not.toContain('UFUNCTION');
    expect(out).not.toContain('DisplayName');
    expect(out).toContain('void Z();');
  });

  it('handles UCLASS with deeply nested parens in arguments', () => {
    const src = `UCLASS(meta=(Categories=("A.B", "C.D")), Within=Foo) class UDeep {};`;
    const out = stripUeMacros(src);
    expect(out).not.toContain('UCLASS');
    expect(out).not.toContain('Categories');
    expect(out).toContain('class UDeep {};');
  });

  it('leaves Qt macros alone (only UE markers stripped)', () => {
    const src = `class QFoo { Q_OBJECT public: void Bar(); };`;
    const out = stripUeMacros(src);
    expect(out).toContain('Q_OBJECT');
  });
});

describe('stripUeMacros — class-name extraction sanity', () => {
  it('after stripping, "class UMyClass" appears immediately after "class "', () => {
    const src = `UCLASS(BlueprintType)\nclass BRAWLUI_API UMyClass : public UObject\n{\n  GENERATED_BODY()\n};`;
    const out = stripUeMacros(src);
    const classIdx = out.indexOf('class ');
    expect(classIdx).toBeGreaterThanOrEqual(0);
    const tail = out.slice(classIdx + 'class '.length).trimStart();
    expect(tail.startsWith('UMyClass')).toBe(true);
  });
});

describe('stripUeMacros — tree-sitter extraction (end-to-end)', () => {
  /**
   * Walk the parse tree and return the captured class name(s). Works against
   * the actual tree-sitter-cpp grammar so this is a true integration check
   * for the core PR claim: the indexer now sees `UMyClass`, not `BRAWLUI_API`.
   */
  function extractClassNames(source: string): string[] {
    const parser = new Parser();
    parser.setLanguage(CPP as unknown as Parser.Language);
    const tree = parser.parse(source);
    const names: string[] = [];
    const stack: Parser.SyntaxNode[] = [tree.rootNode];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type === 'class_specifier' || node.type === 'struct_specifier') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) names.push(nameNode.text);
      }
      for (let i = node.namedChildCount - 1; i >= 0; i--) {
        const child = node.namedChild(i);
        if (child) stack.push(child);
      }
    }
    return names;
  }

  it('tree-sitter-cpp captures UMyClass as the class name (not BRAWLUI_API)', () => {
    const src = `UCLASS(BlueprintType)\nclass BRAWLUI_API UMyClass : public UObject\n{\n  GENERATED_BODY()\n public:\n  UFUNCTION()\n  void Run();\n};`;
    const out = stripUeMacros(src);
    const names = extractClassNames(out);
    expect(names).toContain('UMyClass');
    expect(names).not.toContain('BRAWLUI_API');
  });

  it('tree-sitter-cpp captures struct name correctly through USTRUCT + MODULE_API', () => {
    const src = `USTRUCT(BlueprintType)\nstruct ENGINE_API FMyData : public FBase\n{\n  GENERATED_BODY()\n  float Value;\n};`;
    const out = stripUeMacros(src);
    const names = extractClassNames(out);
    expect(names).toContain('FMyData');
    expect(names).not.toContain('ENGINE_API');
  });

  it('tree-sitter-cpp source positions are preserved across stripping (line numbers match)', () => {
    const src = `UCLASS()\nclass BRAWLUI_API UMyClass : public UObject\n{\n  GENERATED_BODY()\n public:\n  void Run();\n};`;
    const out = stripUeMacros(src);
    const parser = new Parser();
    parser.setLanguage(CPP as unknown as Parser.Language);
    const tree = parser.parse(out);
    const stack: Parser.SyntaxNode[] = [tree.rootNode];
    let runLine: number | undefined;
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type === 'function_declarator') {
        const declarator = node.childForFieldName('declarator');
        if (declarator?.text === 'Run') {
          runLine = node.startPosition.row;
          break;
        }
      }
      for (let i = node.namedChildCount - 1; i >= 0; i--) {
        const child = node.namedChild(i);
        if (child) stack.push(child);
      }
    }
    expect(runLine).toBe(5); // 0-indexed: "void Run();" is on line 6 (index 5)
  });
});
