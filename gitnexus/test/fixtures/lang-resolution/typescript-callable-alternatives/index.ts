import { runSweep, runAlias, runOr, runThen, runElse } from './sweep';

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
