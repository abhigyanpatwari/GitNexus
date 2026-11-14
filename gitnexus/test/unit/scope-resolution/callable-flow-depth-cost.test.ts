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
