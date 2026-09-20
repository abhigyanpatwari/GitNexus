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
    expect(paths(source)).toEqual([
      'GET /trpc/app.admin.users.list',
      'GET /trpc/app.billing.users.list',
    ]);
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
    expect(paths(source)).toEqual([
      'GET /trpc/user.admin.users.list',
      'GET /trpc/user.billing.users.list',
    ]);
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
    expect(compact.map((r) => r.httpMethod + ' ' + r.routePath)).toEqual(['GET /trpc/app.health']);
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
    expect(emitted.map((r) => r.httpMethod + ' ' + r.routePath)).toEqual(['GET /trpc/app.health']);
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
    expect(paths(source)).toEqual(['GET /trpc/app.health']);
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
    expect(paths(source)).toEqual(['GET /trpc/app.admin.list']);
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
    expect(paths(source)).toEqual(['GET /trpc/app.admin-panel.list-users']);
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
    expect(paths(source)).toEqual(['POST /trpc/app.create']);
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
    expect(paths(source)).toEqual(['GET /trpc/app.list']);
  });

  it('createTRPCRouter appRouter binding in root.ts supplies the app prefix', () => {
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
    ).toEqual(['GET /trpc/app.health']);
  });
});

describe('shouldScanForTrpcRoutes', () => {
  it('matches a repo-root routers/ file after slash-normalizing', () => {
    expect(shouldScanForTrpcRoutes('routers/foo.ts')).toBe(true);
    expect(shouldScanForTrpcRoutes('src/server/api/routers/user.ts')).toBe(true);
    expect(shouldScanForTrpcRoutes('src/lib/utils.ts')).toBe(false);
  });
});
