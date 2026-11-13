/**
 * RUBY-04 — the bare-read check costs O(file), not O(reads x nesting depth).
 *
 * `rubyBareNameIsLocalRead` decides, for each bare identifier statement,
 * whether a parameter or local bound earlier in an enclosing scope makes it a
 * read. Climbing from every read to its method walks every enclosing block
 * again, so a nest where each of D levels reads costs O(D^2) tree steps. This
 * test counts the tree steps (every SyntaxNode navigation call, plus every
 * node an array-returning call materialises) while all reads of one file are
 * classified, at depth 16 and at depth 64. Linear work grows 4x between them;
 * the per-read climb grows about 16x. A ratio is used rather than a constant
 * so the count does not pin an implementation, only its growth.
 *
 * Two nests, each with fixed-width indentation so the source itself grows
 * linearly: every level reads the method's parameter `target` (one name, so a
 * per-name memo would also pass), and every level calls a different
 * unbound name `helper<j>` (D names, so only a per-file index stays linear).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type Parser from 'tree-sitter';
import { getRubyParser } from '../../../../src/core/ingestion/languages/ruby/query.js';
import {
  emitRubyScopeCaptures,
  rubyBareNameIsLocalRead,
  type RubyScopeBindings,
} from '../../../../src/core/ingestion/languages/ruby/captures.js';

type SyntaxNode = Parser.SyntaxNode;

/** SyntaxNode members that navigate the tree (getters and methods). */
const NAVIGATION_GETTERS = [
  'parent',
  'children',
  'namedChildren',
  'firstChild',
  'firstNamedChild',
  'lastChild',
  'lastNamedChild',
  'nextSibling',
  'nextNamedSibling',
  'previousSibling',
  'previousNamedSibling',
] as const;
const NAVIGATION_METHODS = [
  'child',
  'namedChild',
  'childForFieldName',
  'childForFieldId',
  'childrenForFieldName',
  'childrenForFieldId',
  'firstChildForIndex',
  'firstNamedChildForIndex',
  'childWithDescendant',
  'namedDescendantForIndex',
  'descendantForIndex',
  'descendantsOfType',
  'namedDescendantForPosition',
  'descendantForPosition',
  'closest',
] as const;

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

/** Counts tree steps on every node of `tree` until the test ends. */
function countTreeSteps(tree: Parser.Tree): { steps: number } {
  const counter = { steps: 0 };
  // Nodes are per-type subclasses (`ProgramNode`, …) of the binding's
  // SyntaxNode; the navigation members live on SyntaxNode.prototype.
  let proto = Object.getPrototypeOf(tree.rootNode) as Record<string, unknown> | null;
  while (proto !== null && !Object.prototype.hasOwnProperty.call(proto, 'parent')) {
    proto = Object.getPrototypeOf(proto) as Record<string, unknown> | null;
  }
  if (proto === null) throw new Error('SyntaxNode.prototype not found');
  const tally = (result: unknown): void => {
    counter.steps += 1 + (Array.isArray(result) ? result.length : 0);
  };
  for (const name of NAVIGATION_GETTERS) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (descriptor?.get === undefined) continue;
    const get = descriptor.get;
    Object.defineProperty(proto, name, {
      ...descriptor,
      get(this: unknown) {
        const result = get.call(this);
        tally(result);
        return result;
      },
    });
    restores.push(() => Object.defineProperty(proto, name, descriptor));
  }
  for (const name of NAVIGATION_METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (typeof descriptor?.value !== 'function') continue;
    const method = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(proto, name, {
      ...descriptor,
      value(this: unknown, ...args: unknown[]) {
        const result = method.apply(this, args);
        tally(result);
        return result;
      },
    });
    restores.push(() => Object.defineProperty(proto, name, descriptor));
  }
  return counter;
}

/** A method nesting `depth` blocks; level j's statement is `read(j)`. */
function nest(depth: number, read: (j: number) => string): string {
  let source = 'def m(target)\n';
  for (let j = 0; j < depth; j++) source += `  [1].each do |x${j}|\n    ${read(j)}\n`;
  for (let j = 0; j < depth; j++) source += '  end\n';
  return `${source}end\n`;
}

/** Every bare identifier statement, in source order. */
function bareStatements(root: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === 'identifier' && node.parent?.type === 'body_statement') out.push(node);
    for (const child of [...node.namedChildren].reverse()) pending.push(child);
  }
  return out;
}

/** Tree steps to classify every bare read of `source`, and the verdicts. */
function classify(source: string): { steps: number; verdicts: boolean[] } {
  const tree = getRubyParser().parse(source);
  const reads = bareStatements(tree.rootNode);
  const cache = new Map<number, RubyScopeBindings>();
  const counter = countTreeSteps(tree);
  const verdicts = reads.map((read) => rubyBareNameIsLocalRead(read, cache));
  const steps = counter.steps;
  while (restores.length > 0) restores.pop()?.();
  return { steps, verdicts };
}

/** Tree steps of the whole capture pass over `source` (parsed outside the count). */
function capturePass(source: string): { steps: number; groups: number } {
  const tree = getRubyParser().parse(source);
  const counter = countTreeSteps(tree);
  const groups = emitRubyScopeCaptures(source, 'nest.rb', tree).length;
  const steps = counter.steps;
  while (restores.length > 0) restores.pop()?.();
  return { steps, groups };
}

describe('Ruby bare read: classification cost is linear in nesting depth (RUBY-04)', () => {
  it.each([
    ['every level reads the parameter', (_j: number) => 'target', true],
    ['every level calls a different unbound name', (j: number) => `helper${j}`, false],
  ] as const)('%s', (_label, read, bound) => {
    const shallow = classify(nest(16, read));
    const deep = classify(nest(64, read));
    // The verdicts are the work being counted: every read must be classified.
    expect(shallow.verdicts).toEqual(Array(16).fill(bound));
    expect(deep.verdicts).toEqual(Array(64).fill(bound));
    // 4x the depth (and 4x the source): linear work grows 4x. Allow 25%.
    const growth = deep.steps / shallow.steps;
    expect(
      growth,
      `tree steps ${shallow.steps} at depth 16 -> ${deep.steps} at depth 64 (x${growth.toFixed(2)})`,
    ).toBeLessThanOrEqual(5);
  });

  // One line opening H heredocs, each body holding two interpolated blocks
  // that read the parameter: pairing a body with its opener searched the
  // body's run and the opener line per body, O(H^2) per line.
  it('the whole capture pass over a line that opens many heredocs', () => {
    const read = '      #{[1].map do\n        target\n      end}\n';
    const line = (h: number): string => {
      const openers = Array.from({ length: h }, (_, j) => `<<~A${j}`).join(', ');
      let source = `def h(target)\n  other(${openers})\n`;
      for (let j = 0; j < h; j++) source += `${read}${read}    A${j}\n`;
      return `${source}end\n`;
    };
    const shallow = capturePass(line(32));
    const deep = capturePass(line(128));
    expect(deep.groups).toBeGreaterThan(shallow.groups);
    const growth = deep.steps / shallow.steps;
    expect(
      growth,
      `capture-pass tree steps ${shallow.steps} at 32 heredocs -> ${deep.steps} at 128 (x${growth.toFixed(2)})`,
    ).toBeLessThanOrEqual(5);
  });

  // The whole Ruby capture pass over the same nest: no other per-node climb
  // or subtree search may reintroduce depth x depth work. (A block-taking
  // call with no argument list used to search its whole block for one.)
  it('the whole capture pass over a nest that reads at every level', () => {
    const shallow = capturePass(nest(16, () => 'target'));
    const deep = capturePass(nest(64, () => 'target'));
    expect(deep.groups).toBeGreaterThan(shallow.groups);
    const growth = deep.steps / shallow.steps;
    expect(
      growth,
      `capture-pass tree steps ${shallow.steps} at depth 16 -> ${deep.steps} at depth 64 (x${growth.toFixed(2)})`,
    ).toBeLessThanOrEqual(5);
  });
});
