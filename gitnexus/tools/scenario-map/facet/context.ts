/**
 * Context of a test for the scenario map (Layer 2, U5, R5, KTD6, design §2 "Context").
 *
 * Design §2: the context is the enclosing hooks, `vi.mock`/`vi.spyOn`/`vi.stubEnv`, env writes
 * and wrapper-call arguments, reusing Layer 0's context closure, and two tests must have exactly
 * equal contexts for any repeat or row verdict. Layer 0 (tools/test-dupes, U2) already hashes that
 * closure into `CaseRecord.contextHash`: enclosing hooks and describe-level statements (module
 * mocks, spies and env writes there included), wrapper-call arguments, loop heads, if-tests and
 * every declaration the case reaches. This module reuses that hash as is and adds only the two
 * parts Layer 0 keeps out of it, because Layer 0 folds them into its identity key instead:
 *  - setup inside the test body: the body's top-level statements matching Layer 0's own
 *    `ENV_OR_MOCK` pattern (`process.env`, `vi.mock`/`doMock`/`spyOn`/`stubGlobal`/`stubEnv`),
 *    exact code;
 *  - the test call's own options: its modifiers other than `each`/`for` (`fails`, `concurrent`,
 *    `skipIf(...)` …, sorted), their arguments other than the `each` table, and call arguments
 *    other than the title and the callback (an options object or a timeout).
 * A `vi.mock` nested in a body or callback needs nothing extra: Vitest 5 throws on hoisted mock
 * calls outside the module top level, so every running file's `vi.mock` sits in the top frame
 * Layer 0 already hashes.
 *
 * Every instance of one call site shares its context. Row values (`it.each`/`test.for` rows,
 * `for…of` elements) are inputs, recorded by the input facet (U6), not context.
 *
 * Library only; checks.ts joins the context hash with the checks fingerprint for Layer 1.
 */
import { createHash } from 'node:crypto';
import { generate } from '@babel/generator';
import * as t from '@babel/types';
import { ENV_OR_MOCK, shapeOf, type CaseRecord } from '../../test-dupes/test-dupes.js';

/** Modifiers that repeat a test call; their rows are instance inputs, not context. */
const ROW_MODIFIERS = new Set(['each', 'for']);

export interface TestContext {
  /** Layer 0's `CaseRecord.contextHash` (U2), reused unchanged. */
  layer0: string;
  /** Top-level body statements that mock, spy or write the environment, exact code. */
  bodySetup: string[];
  /** The call's own modifiers (sorted), then modifier and call arguments, exact code. */
  callOptions: string[];
  /** sha1 over the three parts; two tests share a context exactly when their hashes are equal. */
  hash: string;
}

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');
const codeOf = (node: t.Node): string => generate(node, { comments: false, compact: true }).code;

function bodySetupOf(record: CaseRecord): string[] {
  const body = record.fn.body;
  const statements: t.Node[] = t.isBlockStatement(body) ? body.body : [body];
  return statements.map(codeOf).filter((code) => ENV_OR_MOCK.test(code));
}

function callOptionsOf(record: CaseRecord): string[] {
  const shape = shapeOf(record.call.callee);
  const modifiers = (shape?.mods ?? []).filter((mod) => !ROW_MODIFIERS.has(mod)).sort();
  const modifierArgs = (shape?.modArgs ?? []).filter((arg) => arg !== record.each);
  const callArgs = record.call.arguments.slice(1).filter((arg) => arg !== record.fn);
  return [
    ...modifiers.map((mod) => `.${mod}`),
    ...modifierArgs.map((arg) => `mod:${codeOf(arg)}`),
    ...callArgs.map((arg) => `arg:${codeOf(arg)}`),
  ];
}

const memo = new WeakMap<CaseRecord, TestContext>();

/** The context of a test call; every instance of the call shares it. */
export function contextOf(record: CaseRecord): TestContext {
  const cached = memo.get(record);
  if (cached !== undefined) return cached;
  const bodySetup = bodySetupOf(record);
  const callOptions = callOptionsOf(record);
  const hash = sha1(
    [
      `layer0:${record.contextHash}`,
      ...bodySetup.map((code) => `body:${code}`),
      ...callOptions.map((option) => `call:${option}`),
    ].join('\0'),
  );
  const context: TestContext = { layer0: record.contextHash, bodySetup, callOptions, hash };
  memo.set(record, context);
  return context;
}
