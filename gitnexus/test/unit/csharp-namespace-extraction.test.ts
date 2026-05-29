import { describe, it, expect } from 'vitest';
import { extractCsharpStructureViaScanner } from '../../src/core/ingestion/languages/csharp/namespace-siblings.js';

// Scanner fallback used on the worker path, where native tree-sitter Trees
// can't cross MessageChannels so `treeCache` is empty. It must reproduce
// the AST walk's `namespaces` / `usingStaticPaths` for the common
// line-anchored declaration forms (see namespace-siblings.ts).
describe('extractCsharpStructureViaScanner', () => {
  it('extracts a file-scoped namespace declaration', () => {
    const src = `namespace App.Models;\n\npublic class User {}`;
    expect(extractCsharpStructureViaScanner(src).namespaces).toEqual(['App.Models']);
  });

  it('extracts a block namespace declaration', () => {
    const src = `namespace App.Services\n{\n  public class Svc {}\n}`;
    expect(extractCsharpStructureViaScanner(src).namespaces).toEqual(['App.Services']);
  });

  it('extracts multiple namespaces in source order', () => {
    const src = `namespace A.One\n{\n}\nnamespace A.Two\n{\n}`;
    expect(extractCsharpStructureViaScanner(src).namespaces).toEqual(['A.One', 'A.Two']);
  });

  it('returns empty namespaces for a global (no-namespace) file', () => {
    const src = `public class Global {}\n`;
    expect(extractCsharpStructureViaScanner(src).namespaces).toEqual([]);
  });

  it('captures a plain `using static` path', () => {
    const src = `using static System.Math;\nnamespace App;`;
    const out = extractCsharpStructureViaScanner(src);
    expect(out.usingStaticPaths).toEqual(['System.Math']);
    expect(out.namespaces).toEqual(['App']);
  });

  it('captures a `global using static` path', () => {
    const src = `global using static App.Utils.Logger;\n`;
    expect(extractCsharpStructureViaScanner(src).usingStaticPaths).toEqual(['App.Utils.Logger']);
  });

  it('captures the RHS path of an aliased `using static`', () => {
    const src = `using static M = App.Utils.MathUtils;\n`;
    expect(extractCsharpStructureViaScanner(src).usingStaticPaths).toEqual(['App.Utils.MathUtils']);
  });

  it('does not treat a plain `using` directive as using-static', () => {
    const src = `using System.Collections.Generic;\nusing App.Models;\n`;
    expect(extractCsharpStructureViaScanner(src).usingStaticPaths).toEqual([]);
  });

  it('does not treat a `using var`/`using (...)` statement as using-static', () => {
    const src = `using var stream = File.Open(p);\nusing (var x = Get()) { }\n`;
    expect(extractCsharpStructureViaScanner(src).usingStaticPaths).toEqual([]);
  });

  it('ignores a `// namespace X` line comment', () => {
    const src = `// namespace Fake.Comment;\nnamespace App.Real;`;
    expect(extractCsharpStructureViaScanner(src).namespaces).toEqual(['App.Real']);
  });

  it('handles indentation before declarations', () => {
    const src = `\t\tnamespace App.Indented;\n`;
    expect(extractCsharpStructureViaScanner(src).namespaces).toEqual(['App.Indented']);
  });

  it('handles an empty file', () => {
    const out = extractCsharpStructureViaScanner('');
    expect(out.namespaces).toEqual([]);
    expect(out.usingStaticPaths).toEqual([]);
  });

  // Cross-line comment/string state: a keyword at the start of a line inside
  // a block comment or multi-line string must NOT be read as a declaration
  // (the worker path would otherwise mis-bucket the file vs the AST).
  it('skips a `namespace` line inside a block comment', () => {
    const src = `/*\nnamespace Fake.InComment;\n*/\nnamespace App.Real;`;
    expect(extractCsharpStructureViaScanner(src).namespaces).toEqual(['App.Real']);
  });

  it('skips a `using static` line inside a block comment', () => {
    const src = `/*\nusing static Fake.Helpers;\n*/\nusing static App.Real.Helpers;`;
    expect(extractCsharpStructureViaScanner(src).usingStaticPaths).toEqual(['App.Real.Helpers']);
  });

  it('skips a `namespace` line inside a raw string literal', () => {
    const src = `var sql = """\nnamespace Fake.InRaw;\n""";\nnamespace App.Real;`;
    expect(extractCsharpStructureViaScanner(src).namespaces).toEqual(['App.Real']);
  });

  it('skips a `namespace` line inside a verbatim string literal', () => {
    const src = `var s = @"\nnamespace Fake.InVerbatim;\n";\nnamespace App.Real;`;
    expect(extractCsharpStructureViaScanner(src).namespaces).toEqual(['App.Real']);
  });

  it('still reads a real declaration after a closed same-line block comment', () => {
    const src = `/* header */ class C {}\nnamespace App.Real;`;
    expect(extractCsharpStructureViaScanner(src).namespaces).toEqual(['App.Real']);
  });
});
