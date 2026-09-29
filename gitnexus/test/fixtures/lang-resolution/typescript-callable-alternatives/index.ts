import {
  runSweep,
  runAlias,
  runOr,
  runThen,
  runElse,
  runChained,
  runParen,
  runLeft,
  runAndLeft,
  runAndRight,
} from './sweep';

type Handler = (env: unknown) => Promise<void>;

export async function aliasOnly(env: unknown) {
  const run = runAlias;
  await run(env);
}

export async function nullish(env: { __sweep?: Handler }) {
  const sweep = env.__sweep ?? runSweep;
  await sweep(env);
}

export async function logicalOr(env: { override?: Handler }) {
  const run = env.override || runOr;
  await run(env);
}

export async function ternary(env: unknown, fast: boolean) {
  const run = fast ? runThen : runElse;
  await run(env);
}

export async function chained(env: { a?: Handler; b?: Handler }) {
  const run = env.a ?? env.b ?? runChained;
  await run(env);
}

export async function parenthesized(env: { a?: Handler }) {
  const run = (env.a ?? runParen);
  await run(env);
}

export async function callableLeft(env: { fallback: Handler }) {
  const run = runLeft ?? env.fallback;
  await run(env);
}

// `a && b` yields `a` when it is falsy and `b` otherwise. A falsy value is
// never a callable, so only the right operand can be the one invoked.
export async function logicalAnd(env: unknown) {
  const run = runAndLeft && runAndRight;
  await run(env);
}
