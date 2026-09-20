import { describe, expect, it } from 'vitest';
import { extractTrpcRoutes } from '../../src/core/ingestion/route-extractors/trpc.js';
import { calculateEntryPointScore } from '../../src/core/ingestion/entry-point-scoring.js';

const FILE = 'src/server/trpc/routers/user.ts';

const paths = (source: string) =>
  extractTrpcRoutes(FILE, source).map((r) => r.httpMethod + ' ' + r.routePath);

describe('extractTrpcRoutes (PR #3339 review fixes)', () => {
  it('I3: same-named procedures in sibling nested routers keep distinct full paths', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      '',
      'export const appRouter = t.router({',
      '  admin: t.router({',
      '    users: t.router({',
      '      list: publicProcedure.query(() => null),',
      '    }),',
      '  }),',
      '  billing: t.router({',
      '    users: t.router({',
      '      list: publicProcedure.query(() => null),',
      '    }),',
      '  }),',
      '});',
    ].join('\n');
    expect(paths(source)).toEqual([
      'GET /trpc/app.admin.users.list',
      'GET /trpc/app.billing.users.list',
    ]);
  });

  it('B1: a merge prefix keeps exactly one dot boundary (post. -> post.list)', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      '',
      "export const appRouter = t.merge('post.', t.router({",
      '  list: publicProcedure.query(() => null),',
      '}));',
    ].join('\n');
    expect(paths(source)).toEqual(['GET /trpc/post.list']);
  });

  it('I3: bare router() import style still nests sibling routers', () => {
    const source = [
      "import { router, publicProcedure } from '../trpc';",
      '',
      'export const appRouter = router({',
      '  admin: router({',
      '    users: router({',
      '      list: publicProcedure.query(() => null),',
      '    }),',
      '  }),',
      '  billing: router({',
      '    users: router({',
      '      list: publicProcedure.query(() => null),',
      '    }),',
      '  }),',
      '});',
    ].join('\n');
    expect(paths(source)).toEqual([
      'GET /trpc/user.admin.users.list',
      'GET /trpc/user.billing.users.list',
    ]);
  });

  it('B1: an all-dot merge prefix is treated as no prefix', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      '',
      "export const appRouter = t.merge('..', t.router({",
      '  list: publicProcedure.query(() => null),',
      '}));',
    ].join('\n');
    expect(paths(source)).toEqual(['GET /trpc/list']);
  });

  it('I10: a file whose only procedure-ish name is unrelated emits nothing', () => {
    // Pre-fix, /\b\w*Procedure\w*\b matched myProcedure/ProcedureBuilder and
    // this file emitted a phantom route; the allowlist rejects it.
    const source = [
      "import { ProcedureBuilder } from './internals';",
      'const myProcedure = (fn: () => unknown) => fn;',
      '',
      'export const routes = {',
      '  list: myProcedure.query(() => null),',
      '};',
    ].join('\n');
    expect(extractTrpcRoutes(FILE, source)).toEqual([]);
  });

  it('I10: chained key/terminal across lines still emit, and the key resets after its object closes', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const protectedProcedure = t.procedure;',
      '',
      'export const userRouter = t.router({',
      '  list: protectedProcedure',
      '    .input((v) => v)',
      '    .query(() => null),',
      '  create: protectedProcedure.mutation(() => null),',
      '});',
    ].join('\n');
    expect(paths(source)).toEqual(['GET /trpc/user.list', 'POST /trpc/user.create']);
  });

  it('braces inside strings and comments do not skew the nesting stack', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      '',
      'export const appRouter = t.router({',
      '  admin: t.router({',
      '    // a lone closing brace in a comment: }',
      '    error: publicProcedure.mutation(() => {',
      "      throw new Error('brace } inside string');",
      '    }),',
      '  }),',
      '  health: publicProcedure.query(() => null),',
      '});',
    ].join('\n');
    // health must be app.health (top level), NOT app.admin.health — a skewed
    // depth counter from the string/comment braces would mis-nest it.
    expect(paths(source)).toEqual(['POST /trpc/app.admin.error', 'GET /trpc/app.health']);
  });
});

describe('entry-point scoring regression (I1)', () => {
  it('does not crash on a .js router path whose framework detection returns null', () => {
    // '/server/routers/' passes the scoring isTrpcRouter regex but, after B3,
    // detectFrameworkFromPath returns null for it (no '/trpc/' segment). The
    // pre-fix non-optional '.framework' access crashed right here.
    const jsResult = calculateEntryPointScore(
      'settingsRouter',
      'javascript',
      true,
      0,
      3,
      'src/server/routers/settings.js',
    );
    expect(Number.isFinite(jsResult.score)).toBe(true);
  });

  it('still grants the tRPC utility-penalty exemption to /trpc/routers/ TS files', () => {
    const tsResult = calculateEntryPointScore(
      'settingsRouter',
      'typescript',
      true,
      0,
      3,
      'src/server/trpc/routers/settings.ts',
    );
    expect(Number.isFinite(tsResult.score)).toBe(true);
  });
});
