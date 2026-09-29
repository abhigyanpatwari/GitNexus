/**
 * `resolveGoRouteHandler` (#3402): gin/echo handler designators resolved across
 * the files of a Go package, unique-or-decline at every step.
 *
 * The model is built the way the parse phase leaves it: a Method's `ownerId` is
 * the worker's `Struct:<methodFile>:<Receiver>` id, keyed on the method's own
 * file — not the struct's node id when the struct lives in a sibling file.
 */
import { describe, expect, it } from 'vitest';
import { createSemanticModel } from '../../src/core/ingestion/model/index.js';
import { resolveGoRouteHandler } from '../../src/core/ingestion/languages/go/route-handler.js';
import type { ExtractedDecoratorRoute } from '../../src/core/ingestion/workers/parse-worker.js';
import { generateId } from '../../src/lib/utils.js';

const ROUTER = 'app/router/router.go';

type Model = ReturnType<typeof createSemanticModel>;

const struct = (model: Model, file: string, name: string) =>
  model.symbols.add(file, name, `Struct:${file}:${name}`, 'Struct');

/** A method as the worker registers it: owner keyed on the METHOD's file. */
const method = (model: Model, file: string, receiver: string, name: string) =>
  model.symbols.add(file, name, `Method:${file}:${receiver}.${name}`, 'Method', {
    ownerId: generateId('Struct', `${file}:${receiver}`),
  });

const fn = (model: Model, file: string, name: string, returnType?: string) =>
  model.symbols.add(file, name, `Function:${file}:${name}`, 'Function', { returnType });

const route = (overrides: Partial<ExtractedDecoratorRoute>): ExtractedDecoratorRoute => ({
  filePath: ROUTER,
  routePath: '/x',
  httpMethod: 'GET',
  decoratorName: 'GET',
  lineNumber: 1,
  source: 'gin-route',
  ...overrides,
});

const resolve = (
  model: Model,
  overrides: Partial<ExtractedDecoratorRoute>,
  imports: Readonly<Record<string, readonly string[]>> = {},
) =>
  resolveGoRouteHandler(route(overrides), {
    model,
    importTargetsFor: (_from, localName) => imports[localName] ?? [],
  });

describe('resolveGoRouteHandler', () => {
  it('resolves a constructor-built receiver to a method declared in a sibling file (issue #3402)', () => {
    const model = createSemanticModel();
    struct(model, 'app/router/types.go', 'MatchHandler');
    fn(model, 'app/router/types.go', 'NewMatchHandler', '*MatchHandler');
    method(model, 'app/router/match_handler.go', 'MatchHandler', 'UnfinalizeRoundHandle');

    expect(
      resolve(model, {
        handlerName: 'matchHandler.UnfinalizeRoundHandle',
        handlerReceiver: { kind: 'constructor', name: 'NewMatchHandler' },
      }),
    ).toBe('Method:app/router/match_handler.go:MatchHandler.UnfinalizeRoundHandle');
  });

  it('reads the first result of a (T, error) constructor', () => {
    const model = createSemanticModel();
    struct(model, 'app/router/h.go', 'H');
    fn(model, 'app/router/h.go', 'NewH', '(*H, error)');
    method(model, 'app/router/h.go', 'H', 'Do');

    expect(
      resolve(model, {
        handlerName: 'h.Do',
        handlerReceiver: { kind: 'constructor', name: 'NewH' },
      }),
    ).toBe('Method:app/router/h.go:H.Do');
  });

  it('declines a constructor whose result type lives in another package', () => {
    const model = createSemanticModel();
    fn(model, 'app/router/h.go', 'NewH', '*other.H');
    method(model, 'app/router/h.go', 'H', 'Do');

    expect(
      resolve(model, {
        handlerName: 'h.Do',
        handlerReceiver: { kind: 'constructor', name: 'NewH' },
      }),
    ).toBeUndefined();
  });

  it('resolves a type hint through an import qualifier', () => {
    const model = createSemanticModel();
    struct(model, 'app/handlers/auth.go', 'Auth');
    method(model, 'app/handlers/auth.go', 'Auth', 'Login');

    expect(
      resolve(
        model,
        {
          handlerName: 'h.Login',
          handlerReceiver: { kind: 'type', name: 'Auth', qualifier: 'hs' },
        },
        { hs: ['app/handlers/auth.go', 'app/handlers/util.go'] },
      ),
    ).toBe('Method:app/handlers/auth.go:Auth.Login');
  });

  it('resolves a package function through its import', () => {
    const model = createSemanticModel();
    fn(model, 'app/handlers/health.go', 'Health');
    fn(model, 'app/other/health.go', 'Health');

    expect(
      resolve(
        model,
        {
          handlerName: 'handlers.Health',
          handlerReceiver: { kind: 'module', qualifier: 'handlers' },
        },
        { handlers: ['app/handlers/health.go'] },
      ),
    ).toBe('Function:app/handlers/health.go:Health');
  });

  it('declines a module handler whose import is not in the workspace', () => {
    const model = createSemanticModel();
    fn(model, 'app/router/x.go', 'Wrap');

    expect(
      resolve(model, {
        handlerName: 'gin.Wrap',
        handlerReceiver: { kind: 'module', qualifier: 'gin' },
      }),
    ).toBeUndefined();
  });

  it('resolves a bare function in the route package only', () => {
    const model = createSemanticModel();
    fn(model, 'app/router/health.go', 'Health');
    fn(model, 'app/other/health.go', 'Health');

    expect(resolve(model, { handlerName: 'Health' })).toBe('Function:app/router/health.go:Health');
  });

  it('falls back to a unique package method when the receiver type is unknown', () => {
    const model = createSemanticModel();
    method(model, 'app/router/a.go', 'A', 'List');
    method(model, 'app/elsewhere/b.go', 'B', 'List');

    expect(resolve(model, { handlerName: 'h.List' })).toBe('Method:app/router/a.go:A.List');
  });

  it('declines an ambiguous name when the receiver type is unknown (AE2)', () => {
    const model = createSemanticModel();
    method(model, 'app/router/auth.go', 'AuthHandler', 'Login');
    method(model, 'app/router/auth.go', 'AdminAuthHandler', 'Login');

    expect(resolve(model, { handlerName: 'h.Login' })).toBeUndefined();
  });

  it('ignores _test.go siblings when judging uniqueness', () => {
    const model = createSemanticModel();
    method(model, 'app/router/auth.go', 'AuthHandler', 'Login');
    method(model, 'app/router/auth_test.go', 'fakeHandler', 'Login');

    expect(resolve(model, { handlerName: 'h.Login' })).toBe(
      'Method:app/router/auth.go:AuthHandler.Login',
    );
  });

  describe('a failed hint never falls back to a name-only match', () => {
    it.each([
      ['the hinted type is not in the package', () => {}],
      [
        'two structs share the hinted name',
        (model: Model) => {
          struct(model, 'app/router/t1.go', 'T');
          struct(model, 'app/router/t2.go', 'T');
        },
      ],
      [
        'the hinted type has no such method',
        (model: Model) => {
          struct(model, 'app/router/t.go', 'T');
        },
      ],
    ])('declines when %s', (_label, arrange) => {
      const model = createSemanticModel();
      arrange(model);
      method(model, 'app/router/other.go', 'Other', 'Do');

      expect(
        resolve(model, { handlerName: 'h.Do', handlerReceiver: { kind: 'type', name: 'T' } }),
      ).toBeUndefined();
    });
  });
});
