/**
 * A call argument that wraps a function literal must not cost the literal's
 * whole body every time a call is nested in it (#3912 review).
 *
 * Dart's `argument`, Kotlin's `value_argument`, C#'s `argument` and PHP's
 * `argument` wrap the literal, so `operandSyntax` does not stop at it as a
 * function node. It searched the literal's body for a terminal identifier and
 * then for a second identifier leaf, and `emitCallFacts` dropped the result
 * because such an argument is no designator. Each call nested k levels deep
 * paid for the k levels below it: O(depth^2) over a nest. The terminal
 * identifier is now memoized per file, and a dropped argument returns before
 * the second-leaf search. Capture output is unchanged (the scope-capture
 * fingerprints pin every language).
 *
 * The test hook counts the subtree nodes the operand search enters. Each
 * added nesting level must add the same number, at any depth.
 */
import { describe, expect, it } from 'vitest';
import type { CaptureMatch } from 'gitnexus-shared';
import {
  getCallableFlowCaptureStats,
  resetCallableFlowCaptureStats,
} from '../../../src/core/ingestion/utils/callable-flow-captures.js';
import { emitDartScopeCaptures } from '../../../src/core/ingestion/languages/dart/captures.js';
import { emitKotlinScopeCaptures } from '../../../src/core/ingestion/languages/kotlin/index.js';
import { emitCsharpScopeCaptures } from '../../../src/core/ingestion/languages/csharp/index.js';
import { emitPhpScopeCaptures } from '../../../src/core/ingestion/languages/php/index.js';
import { emitPythonScopeCaptures } from '../../../src/core/ingestion/languages/python/index.js';
import { emitJsScopeCaptures } from '../../../src/core/ingestion/languages/javascript/index.js';
import {
  isLanguageAvailable,
  loadLanguage,
  loadParser,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

// Optional grammar cases skip where their parser cannot load.
let dartAvailable = isLanguageAvailable(SupportedLanguages.Dart);
if (dartAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Dart);
  } catch {
    dartAvailable = false;
  }
}

let kotlinAvailable = isLanguageAvailable(SupportedLanguages.Kotlin);
if (kotlinAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Kotlin);
  } catch {
    kotlinAvailable = false;
  }
}

type Emit = (source: string, filePath: string) => readonly CaptureMatch[];

/** `depth` literals passed as call arguments, each nested in the previous one. */
interface Nest {
  readonly emit: Emit;
  readonly file: string;
  readonly open: (j: number) => string;
  readonly close: string;
  readonly wrap: (body: string) => string;
}

const NESTS: Record<string, Nest> = {
  dart: {
    emit: emitDartScopeCaptures,
    file: 'lib/nest.dart',
    open: (j) => `  items.forEach((x${j}) { cs.save(x${j});\n`,
    close: '  });\n',
    wrap: (body) => `void f(Address cs, List<int> items) {\n${body}}\n`,
  },
  kotlin: {
    emit: emitKotlinScopeCaptures,
    file: 'Nest.kt',
    open: (j) => `  run({ x${j}: Int -> save(x${j})\n`,
    close: '  })\n',
    wrap: (body) => `fun f(cs: Int) {\n${body}}\n`,
  },
  csharp: {
    emit: emitCsharpScopeCaptures,
    file: 'Nest.cs',
    open: (j) => `  Run((x${j}) => { Save(x${j});\n`,
    close: '  });\n',
    wrap: (body) => `class C { void F(int cs) {\n${body}} }\n`,
  },
  php: {
    emit: emitPhpScopeCaptures,
    file: 'nest.php',
    open: (j) => `  run(function ($x${j}) { save($x${j});\n`,
    close: '  });\n',
    wrap: (body) => `<?php\nfunction f($cs) {\n${body}}\n`,
  },
};

function operandNodeVisits(nest: Nest, depth: number): number {
  let body = '';
  for (let j = 0; j < depth; j++) body += nest.open(j);
  for (let j = 0; j < depth; j++) body += nest.close;
  resetCallableFlowCaptureStats(true);
  try {
    nest.emit(nest.wrap(body), nest.file);
    return getCallableFlowCaptureStats().operandNodeVisits;
  } finally {
    resetCallableFlowCaptureStats();
  }
}

function expectLinear(nest: Nest, perLevel: number, fixed: number): void {
  for (const depth of [8, 16, 64]) {
    expect(operandNodeVisits(nest, depth)).toBe(perLevel * depth + fixed);
  }
}

describe('a call argument wrapping a function literal is not searched again per nested call', () => {
  it.skipIf(!dartAvailable)('Dart', () => expectLinear(NESTS.dart, 14, 1));
  it.skipIf(!kotlinAvailable)('Kotlin', () => expectLinear(NESTS.kotlin, 12, 0));
  it('C#', () => expectLinear(NESTS.csharp, 12, 1));
  it('PHP', () => expectLinear(NESTS.php, 14, 1));
});

function pythonOperandNodeVisits(source: string): number {
  resetCallableFlowCaptureStats(true);
  try {
    emitPythonScopeCaptures(source, 'nest.py');
    return getCallableFlowCaptureStats().operandNodeVisits;
  } finally {
    resetCallableFlowCaptureStats();
  }
}

// A call whose callee is a call, and an assignment whose value is an
// assignment, hold the whole nest below them. The callee and the assigned
// value were searched without the per-file memo, and the second-leaf search
// had none, so level k paid for the k levels under it: 2 * depth^2 - 1 visits
// for `a()()...()` (32,767 at depth 128, now 510).
describe('a nest of calls or assignments is not searched again per level', () => {
  const depths = [8, 16, 64];

  it.each([
    {
      nest: 'a call of a call',
      source: (depth: number) => `a${'()'.repeat(depth)}\n`,
      perLevel: 4,
      fixed: -2,
    },
    {
      nest: 'an assignment chain',
      source: (depth: number) => `${'a = '.repeat(depth)}b\n`,
      perLevel: 3,
      fixed: 1,
    },
    {
      nest: 'nested named expressions',
      source: (depth: number) => `${'(a := '.repeat(depth)}f()${')'.repeat(depth)}\n`,
      perLevel: 4,
      fixed: 3,
    },
  ])('Python: $nest', ({ source, perLevel, fixed }) => {
    expect(depths.map((depth) => pythonOperandNodeVisits(source(depth)))).toEqual(
      depths.map((depth) => perLevel * depth + fixed),
    );
  });
});

function emittedOperandNodeVisits(emit: Emit, file: string, source: string): number {
  resetCallableFlowCaptureStats(true);
  try {
    emit(source, file);
    return getCallableFlowCaptureStats().operandNodeVisits;
  } finally {
    resetCallableFlowCaptureStats();
  }
}

/** `o[(o[(o[0] = 1).k] = 1).k] = 1`: each destination holds the next assignment. */
function nestedSubscriptDestination(depth: number): string {
  let target = 'o[0]';
  for (let level = 0; level < depth; level++) target = `o[(${target} = 1).k]`;
  return `${target} = 1;\n`;
}

// The second-leaf search answers "more than one identifier leaf?" and must stop
// at the second leaf it reaches. Finishing the subtree around that leaf first
// walked the whole receiver of `a.f.f…` and the whole nest under a destination
// that holds the next assignment: O(depth) per operand, O(depth^2) per nest.
describe('the second-leaf search stops at the second leaf', () => {
  const depths = [8, 16, 64];

  it.each([
    {
      shape: 'Python: a member-chain argument',
      emit: emitPythonScopeCaptures,
      file: 'chain.py',
      source: (depth: number) => `f(a${'.f'.repeat(depth)})\n`,
      perLevel: 0,
      fixed: 7,
    },
    {
      shape: 'Python: a member-chain callee',
      emit: emitPythonScopeCaptures,
      file: 'chain.py',
      source: (depth: number) => `a${'.f'.repeat(depth)}()\n`,
      perLevel: 0,
      fixed: 6,
    },
    {
      shape: 'JavaScript: a destination that holds the next assignment',
      emit: emitJsScopeCaptures,
      file: 'nest.js',
      source: nestedSubscriptDestination,
      perLevel: 14,
      fixed: 8,
    },
  ])('$shape', ({ emit, file, source, perLevel, fixed }) => {
    expect(depths.map((depth) => emittedOperandNodeVisits(emit, file, source(depth)))).toEqual(
      depths.map((depth) => perLevel * depth + fixed),
    );
  });
});
