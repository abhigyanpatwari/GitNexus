/**
 * #2687 — `const X = <arrow | function-expression>` must emit exactly ONE graph
 * node: the `Function` node that carries the CALLS edges. Before the fix it also
 * emitted an edgeless `Const:<file>:X` twin at the same line, which made every
 * `impact`/`context` call on that name come back `status: "ambiguous"` with a
 * top-level `impactedCount: 0` — indistinguishable from a real "nothing depends
 * on this".
 *
 * Root cause: the parse-worker duplicate suppression is order-dependent. Only
 * the value branch (`Const`/`Static`/`Variable`) consults
 * `processedDefinitionNodes`; function-like labels merely register into it. And
 * tree-sitter yields the `@definition.const` match BEFORE `@definition.function`
 * for the same `lexical_declaration` (the const pattern completes at `@name`,
 * the function pattern needs the trailing arrow/function-expression value), so
 * the twin was emitted first and never suppressed.
 *
 * The over-suppression guards below matter as much as the twin assertions: a
 * genuine non-callable `const`, an object-literal service (#1718), a `var`
 * binding, and the non-function initializers must all keep their value nodes.
 *
 * Mirrors the sibling suppression case in `c-cpp-typedef-legacy-parse.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { parseFilesWithWorkers } from '../helpers/worker-parse.js';

const parseNodes = async (path: string, content: string) => {
  const { graph } = await parseFilesWithWorkers([{ path, content }]);
  return graph.nodes;
};

type ParsedNode = Awaited<ReturnType<typeof parseNodes>>[number];

/** Sorted labels of every node carrying `name` — length doubles as the node count. */
const labelsOf = (nodes: readonly ParsedNode[], name: string): string[] =>
  nodes
    .filter((node) => node.properties.name === name)
    .map((node) => node.label)
    .sort();

describe('#2687 export-const function twin', () => {
  it('emits one Function node for a bare const arrow', async () => {
    const nodes = await parseNodes('src/bare.ts', 'const Bare = () => 1;\n');

    expect(labelsOf(nodes, 'Bare')).toEqual(['Function']);
    // The twin was `Const:<file>:Bare` at the same line — assert the id is gone.
    expect(nodes.filter((node) => node.id === 'Const:src/bare.ts:Bare')).toHaveLength(0);
  });

  it('emits one Function node for an exported const arrow', async () => {
    const nodes = await parseNodes('src/exported.ts', 'export const Exported = () => 2;\n');

    expect(labelsOf(nodes, 'Exported')).toEqual(['Function']);
  });

  it('emits one Function node for a bare const function-expression', async () => {
    const nodes = await parseNodes(
      'src/bare-fn.ts',
      'const BareFnExpr = function () {\n  return 3;\n};\n',
    );

    expect(labelsOf(nodes, 'BareFnExpr')).toEqual(['Function']);
  });

  it('emits one Function node for an exported const function-expression', async () => {
    const nodes = await parseNodes(
      'src/exported-fn.ts',
      'export const ExportedFnExpr = function () {\n  return 4;\n};\n',
    );

    expect(labelsOf(nodes, 'ExportedFnExpr')).toEqual(['Function']);
  });

  it('emits one Function node for an exported component in a .tsx file', async () => {
    // The reporter's shape: `export const Button = (props) => …` in a React file.
    const nodes = await parseNodes(
      'src/ui/button.tsx',
      'export const Button = (props: { label: string }) => {\n  return props.label;\n};\n',
    );

    expect(labelsOf(nodes, 'Button')).toEqual(['Function']);
  });

  it('emits one Function node for a let-bound arrow', async () => {
    // `let` shares the `lexical_declaration` pattern, so it twinned too.
    const nodes = await parseNodes('src/let.ts', 'let mutable = () => 1;\n');

    expect(labelsOf(nodes, 'mutable')).toEqual(['Function']);
  });

  it('keeps the Const node for a non-callable const', async () => {
    const nodes = await parseNodes('src/config.ts', 'export const CONFIG = { a: 1 };\n');

    expect(labelsOf(nodes, 'CONFIG')).toEqual(['Const']);
  });

  it('keeps the Const node for an object-literal service (#1718)', async () => {
    // `receiver-bound-calls.ts` Case 5 bridges `fooService.getUser()` through
    // this exact `Const:<file>:fooService` node id.
    const nodes = await parseNodes(
      'src/service.ts',
      'export const fooService = {\n  getUser(id: string) {\n    return id;\n  },\n};\n',
    );

    expect(labelsOf(nodes, 'fooService')).toEqual(['Const']);
  });

  it('keeps the Const node for a non-function initializer', async () => {
    const nodes = await parseNodes(
      'src/ternary.ts',
      'function A() {\n  return 1;\n}\nfunction B() {\n  return 2;\n}\nconst ternary = A ?? B;\n',
    );

    expect(labelsOf(nodes, 'ternary')).toEqual(['Const']);
  });

  it('keeps the Variable node for a var-bound function-expression', async () => {
    // `var` has no matching `@definition.function` pattern, so nothing claims
    // the name and the value node must survive untouched.
    const nodes = await parseNodes('src/var.ts', 'var legacy = function () {\n  return 3;\n};\n');

    expect(labelsOf(nodes, 'legacy')).toEqual(['Variable']);
  });

  it('suppresses only the callable name in a multi-name declaration', async () => {
    // Both declarators share ONE `lexical_declaration`, so a suppression keyed
    // by definition-node start index alone would wrongly delete `a`.
    const nodes = await parseNodes('src/multi.ts', 'const a = 1,\n  b = () => {};\n');

    expect(labelsOf(nodes, 'a')).toEqual(['Const']);
    expect(labelsOf(nodes, 'b')).toEqual(['Function']);
  });
});
