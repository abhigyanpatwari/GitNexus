import { describe, expect, it } from 'vitest';
import {
  extractTrpcRoutes,
  shouldScanForTrpcRoutes,
} from '../../src/core/ingestion/route-extractors/trpc.js';

const FILE = 'src/server/trpc/routers/user.ts';

const paths = (source: string) =>
  extractTrpcRoutes(FILE, source).map((r) => r.httpMethod + ' ' + r.routePath);

describe('extractTrpcRoutes', () => {
  it('same-named procedures in sibling nested routers keep distinct full paths', () => {
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
    expect(paths(source)).toEqual(['GET /trpc/admin.users.list', 'GET /trpc/billing.users.list']);
  });

  it('a merge prefix keeps exactly one dot boundary (post. -> post.list)', () => {
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

  it('a preceding t.merge does not prefix a later t.router appRouter', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      "t.merge('post.', postRouter);",
      'export const appRouter = t.router({',
      '  health: publicProcedure.query(() => null),',
      '});',
    ].join('\n');
    expect(paths(source)).toEqual(['GET /trpc/health']);
  });

  it('bare router() import style still nests sibling routers', () => {
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
    expect(paths(source)).toEqual(['GET /trpc/admin.users.list', 'GET /trpc/billing.users.list']);
  });

  it('an all-dot merge prefix is treated as no prefix', () => {
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

  it('a file whose only procedure-ish name is unrelated emits nothing', () => {
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

  it('a comment or string tRPC marker plus fooProcedure emits nothing', () => {
    const source = [
      '// leftover: import { initTRPC } from "@trpc/server"',
      'const handlers = { ping: fooProcedure.query(() => null) }',
    ].join('\n');
    expect(extractTrpcRoutes(FILE, source)).toEqual([]);
  });

  it('chained key/terminal across lines still emit, and the key resets after its object closes', () => {
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
    const emitted = extractTrpcRoutes(FILE, source);
    expect(emitted.map((r) => r.httpMethod + ' ' + r.routePath)).toEqual([
      'GET /trpc/user.list',
      'POST /trpc/user.create',
    ]);
    // list: key on line 6, `.query(` terminal on line 8. create: key+terminal
    // share line 9, so the number is unchanged.
    expect(emitted.map((r) => r.lineNumber)).toEqual([8, 9]);
  });

  it('compact one-line routers still emit a procedure key', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      'export const appRouter = t.router({ health: publicProcedure.query(() => null) });',
    ].join('\n');
    const compact = extractTrpcRoutes(FILE, source);
    expect(compact.map((r) => r.httpMethod + ' ' + r.routePath)).toEqual(['GET /trpc/health']);
    // key and `.query(` share the export line — same number as before.
    expect(compact.map((r) => r.lineNumber)).toEqual([4]);
  });

  it('does not treat .query( inside a comment as the procedure terminal', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      '',
      'export const appRouter = t.router({',
      '  health: publicProcedure',
      '    // leftover note: .query(',
      '    .query(() => null),',
      '});',
    ].join('\n');
    const emitted = extractTrpcRoutes(FILE, source);
    expect(emitted.map((r) => r.httpMethod + ' ' + r.routePath)).toEqual(['GET /trpc/health']);
    expect(emitted[0]?.lineNumber).toBe(8);
  });

  it('gates and extracts terminals with whitespace before the opening paren', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      '',
      'export const appRouter = t.router({',
      '  health: publicProcedure.query (() => null),',
      '});',
    ].join('\n');
    expect(paths(source)).toEqual(['GET /trpc/health']);
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
    // health must be /trpc/health (top level), NOT /trpc/admin.health — a skewed
    // depth counter from the string/comment braces would mis-nest it.
    expect(paths(source)).toEqual(['POST /trpc/admin.error', 'GET /trpc/health']);
  });

  it('prettier multiline z.object input still emits the list route', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const protectedProcedure = t.procedure;',
      '',
      'export const userRouter = t.router({',
      '  list: protectedProcedure',
      '    .input(',
      '      z.object({',
      '        id: z.string(),',
      '      }),',
      '    )',
      '    .query(() => null),',
      '});',
    ].join('\n');
    const emitted = extractTrpcRoutes(FILE, source);
    expect(emitted.map((r) => r.httpMethod + ' ' + r.routePath)).toEqual(['GET /trpc/user.list']);
    // key on line 6; `.query(` after the prettier-broken `.input(z.object)` is 12.
    expect(emitted[0]?.lineNumber).toBe(12);
  });

  it('compact nested admin.list one-liner emits the nested path', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      'export const appRouter = t.router({ admin: t.router({ list: publicProcedure.query(() => null) }) });',
    ].join('\n');
    expect(paths(source)).toEqual(['GET /trpc/admin.list']);
  });

  it('quoted kebab-case router and procedure keys emit the dotted path', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      'export const appRouter = t.router({',
      "  'admin-panel': t.router({",
      "    'list-users': publicProcedure.query(() => null),",
      '  }),',
      '});',
    ].join('\n');
    expect(paths(source)).toEqual(['GET /trpc/admin-panel.list-users']);
  });

  it("quoted 'create' key emits a POST create route", () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      'export const appRouter = t.router({',
      "  'create': publicProcedure.mutation(() => null),",
      '});',
    ].join('\n');
    expect(paths(source)).toEqual(['POST /trpc/create']);
  });

  it('does not treat a commented-out create key as the current procedure', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      '',
      'export const appRouter = t.router({',
      '  list: publicProcedure',
      '    // leftover: create: publicProcedure.query(',
      '    .query(() => null),',
      '});',
    ].join('\n');
    expect(paths(source)).toEqual(['GET /trpc/list']);
  });

  it('db.query inside .input is not a GET terminal; create stays POST', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      '',
      'export const appRouter = t.router({',
      '  create: publicProcedure.input(z.custom(async v => db.query(v))).mutation(handler),',
      '});',
    ].join('\n');
    expect(paths(source)).toEqual(['POST /trpc/create']);
  });

  it('lowercase procedure builder still emits the create route', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const procedure = t.procedure;',
      'export const appRouter = t.router({',
      '  create: procedure.mutation(() => null),',
      '});',
    ].join('\n');
    expect(paths(source)).toEqual(['POST /trpc/create']);
    expect(extractTrpcRoutes(FILE, source)[0]?.methodName).toBe('create');
  });

  it('identifier callback is the handler name; inline arrows keep the procedure key', () => {
    const ident = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      'export const appRouter = t.router({',
      '  create: publicProcedure.mutation(handler),',
      '});',
    ].join('\n');
    expect(extractTrpcRoutes(FILE, ident)).toEqual([
      expect.objectContaining({
        routePath: '/trpc/create',
        methodName: 'handler',
        httpMethod: 'POST',
      }),
    ]);

    const multiline = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      'export const appRouter = t.router({',
      '  create: publicProcedure.mutation(',
      '    handler',
      '  ),',
      '});',
    ].join('\n');
    expect(extractTrpcRoutes(FILE, multiline)[0]?.methodName).toBe('handler');

    const arrow = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      'export const appRouter = t.router({',
      '  create: publicProcedure.mutation(async () => null),',
      '});',
    ].join('\n');
    expect(extractTrpcRoutes(FILE, arrow)[0]?.methodName).toBe('create');

    const member = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      'export const appRouter = t.router({',
      '  create: publicProcedure.mutation(handlers.create),',
      '});',
    ].join('\n');
    expect(extractTrpcRoutes(FILE, member)[0]?.methodName).toBe('create');
  });

  it('nested db.transaction().query inside .input is not a GET terminal; create stays POST', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      '',
      'export const appRouter = t.router({',
      '  create: publicProcedure.input(v => db.transaction().query(v)).mutation(handler),',
      '});',
    ].join('\n');
    expect(paths(source)).toEqual(['POST /trpc/create']);
  });

  it('defaults.merge is not a tRPC router prefix', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      "const options = defaults.merge('internal', overrides);",
      '',
      'export const appRouter = t.router({',
      '  list: publicProcedure.query(() => null),',
      '});',
    ].join('\n');
    const emitted = paths(source);
    expect(emitted).not.toContain('GET /trpc/internal.list');
    // appRouter is the root binding (no prefix); must not pick up 'internal'.
    expect(emitted).toEqual(['GET /trpc/list']);
  });

  it('regex literal braces do not pop a nested admin router', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      '',
      'export const appRouter = t.router({',
      '  admin: t.router({',
      '    foo: publicProcedure.query(() => /}/.test(value)),',
      '    bar: publicProcedure.query(() => null),',
      '  }),',
      '});',
    ].join('\n');
    expect(paths(source)).toEqual(['GET /trpc/admin.foo', 'GET /trpc/admin.bar']);
  });

  it('regex after if (ok) does not pop a nested admin router', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      '',
      'export const appRouter = t.router({',
      '  admin: t.router({',
      '    foo: publicProcedure.query(() => { if (ok) /}/.test(value) }),',
      '    bar: publicProcedure.query(() => null),',
      '  }),',
      '});',
    ].join('\n');
    expect(paths(source)).toEqual(['GET /trpc/admin.foo', 'GET /trpc/admin.bar']);
  });

  it('grouping and call parens still treat / as division', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      '',
      'export const appRouter = t.router({',
      '  admin: t.router({',
      '    foo: publicProcedure.query(() => (a + b) / c),',
      '    bar: publicProcedure.query(() => foo(ok) / x),',
      '    baz: publicProcedure.query(() => null),',
      '  }),',
      '});',
    ].join('\n');
    expect(paths(source)).toEqual([
      'GET /trpc/admin.foo',
      'GET /trpc/admin.bar',
      'GET /trpc/admin.baz',
    ]);
  });

  it('regex after return does not pop a nested admin router', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      '',
      'export const appRouter = t.router({',
      '  admin: t.router({',
      '    foo: publicProcedure.query(() => { return /}/.test(value) }),',
      '    bar: publicProcedure.query(() => null),',
      '  }),',
      '});',
    ].join('\n');
    expect(paths(source)).toEqual(['GET /trpc/admin.foo', 'GET /trpc/admin.bar']);
  });

  it('regex after return persists across a newline', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      '',
      'export const appRouter = t.router({',
      '  admin: t.router({',
      '    foo: publicProcedure.query(() => {',
      '      return',
      '        /}/.test(value)',
      '    }),',
      '    bar: publicProcedure.query(() => null),',
      '  }),',
      '});',
    ].join('\n');
    expect(paths(source)).toEqual(['GET /trpc/admin.foo', 'GET /trpc/admin.bar']);
  });

  it('bare router() userRouter binding still prefixes user, not the filename', () => {
    const source = [
      "import { router, publicProcedure } from '../trpc';",
      '',
      'export const userRouter = router({',
      '  list: publicProcedure.query(() => null),',
      '});',
    ].join('\n');
    expect(
      extractTrpcRoutes('src/server/trpc/routers/account.ts', source).map(
        (r) => r.httpMethod + ' ' + r.routePath,
      ),
    ).toEqual(['GET /trpc/user.list']);
  });

  it('createTRPCRouter appRouter binding in root.ts does not prefix with app', () => {
    const source = [
      "import { initTRPC } from '@trpc/server';",
      'const t = initTRPC.create();',
      'const publicProcedure = t.procedure;',
      'export const appRouter = createTRPCRouter({',
      '  health: publicProcedure.query(() => null),',
      '});',
    ].join('\n');
    expect(
      extractTrpcRoutes('src/server/trpc/root.ts', source).map(
        (r) => r.httpMethod + ' ' + r.routePath,
      ),
    ).toEqual(['GET /trpc/health']);
  });
});

describe('shouldScanForTrpcRoutes', () => {
  it('matches a repo-root routers/ file after slash-normalizing', () => {
    expect(shouldScanForTrpcRoutes('routers/foo.ts')).toBe(true);
    expect(shouldScanForTrpcRoutes('src/server/api/routers/user.ts')).toBe(true);
    expect(shouldScanForTrpcRoutes('src/lib/utils.ts')).toBe(false);
  });
});
