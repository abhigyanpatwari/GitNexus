import { describe, expect, it } from 'vitest';
import {
  clientError,
  createFaultScope,
  engineFaultOf,
  faultOf,
  markEngineFault,
  markFault,
  markPathFault,
  markQueryStage,
  queryStageOf,
  reportCaughtFault,
  reportFault,
} from '../../src/core/fault-class.js';

describe('fault-class marks', () => {
  it('leaves message, keys, JSON and stack unchanged', () => {
    const plain = Object.assign(new Error('boom'), { code: 'E_X' });
    const marked = Object.assign(new Error('boom'), { code: 'E_X' });
    const stack = marked.stack;
    expect(markFault(marked, 'server')).toBe(marked);
    expect(marked.stack).toBe(stack);
    expect(faultOf(marked)).toBe('server');
    expect(marked.message).toBe(plain.message);
    expect(marked.name).toBe('Error');
    expect(Object.keys(marked)).toEqual(Object.keys(plain));
    expect(JSON.stringify(marked)).toBe(JSON.stringify(plain));
    expect(String(marked)).toBe(String(plain));
  });

  it('keeps the first mark', () => {
    const err = markFault(new Error('x'), 'client');
    markFault(err, 'server');
    expect(faultOf(err)).toBe('client');
    const staged = markQueryStage(new Error('y'), 'prepare');
    markQueryStage(staged, 'execute');
    expect(queryStageOf(staged)).toBe('prepare');
  });

  it('follows the cause chain, nearest mark first', () => {
    const inner = markFault(new Error('inner'), 'server');
    const outer = new Error('outer', { cause: inner });
    expect(faultOf(outer)).toBe('server');
    const wrapped = markFault(new Error('wrapped', { cause: inner }), 'client');
    expect(faultOf(wrapped)).toBe('client');
    expect(queryStageOf(new Error('o', { cause: markQueryStage(new Error('i'), 'execute') }))).toBe(
      'execute',
    );
  });

  it('stops following cause after a bounded depth and on cycles', () => {
    let err: Error = markFault(new Error('root'), 'server');
    for (let i = 0; i < 6; i++) err = new Error(`level ${i}`, { cause: err });
    expect(faultOf(err)).toBeUndefined();
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(faultOf(a)).toBeUndefined();
  });

  it('does not mark frozen objects and does not throw', () => {
    const frozen = Object.freeze(new Error('frozen'));
    expect(() => markFault(frozen, 'server')).not.toThrow();
    expect(faultOf(frozen)).toBeUndefined();
  });

  it('never throws on a hostile error object', () => {
    const throwingCause = new Error('outer');
    Object.defineProperty(throwingCause, 'cause', {
      get() {
        throw new Error('cause getter');
      },
    });
    expect(faultOf(throwingCause)).toBeUndefined();
    expect(queryStageOf(throwingCause)).toBeUndefined();
    expect(markFault(throwingCause, 'client')).toBe(throwingCause);
    expect(faultOf(throwingCause)).toBe('client');

    const trap = () => {
      throw new Error('trap');
    };
    const hostile = new Proxy(new Error('proxied'), {
      getOwnPropertyDescriptor: trap,
      defineProperty: trap,
      has: trap,
      isExtensible: trap,
      get: trap,
    });
    expect(() => markFault(hostile, 'server')).not.toThrow();
    expect(faultOf(hostile)).toBeUndefined();
    expect(() => reportCaughtFault(hostile)).not.toThrow();
  });

  it('returns primitives unchanged', () => {
    expect(markFault('text', 'server')).toBe('text');
    expect(markFault(undefined, 'client')).toBeUndefined();
    expect(faultOf('text')).toBeUndefined();
    expect(faultOf(null)).toBeUndefined();
  });

  it('clientError is a plain Error marked client', () => {
    const cause = new Error('c');
    const err = clientError('bad input', { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('Error');
    expect(err.message).toBe('bad input');
    expect(err.cause).toBe(cause);
    expect(faultOf(err)).toBe('client');
  });
});

describe('fault scope', () => {
  it('is empty until something is reported', async () => {
    const scope = createFaultScope();
    await scope.run(async () => undefined);
    expect(scope.fault()).toBeUndefined();
  });

  it('prefers server over client', async () => {
    const scope = createFaultScope();
    await scope.run(async () => {
      reportFault('client');
      await Promise.resolve();
      reportFault('server');
      reportFault('client');
    });
    expect(scope.fault()).toBe('server');
  });

  it('isolates two parallel calls', async () => {
    const a = createFaultScope();
    const b = createFaultScope();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
    await Promise.all([
      a.run(async () => {
        await tick();
        reportFault('server');
      }),
      b.run(async () => {
        await tick();
        reportFault('client');
      }),
    ]);
    expect(a.fault()).toBe('server');
    expect(b.fault()).toBe('client');
  });

  it('ignores reports outside a scope', () => {
    expect(() => reportFault('server')).not.toThrow();
    expect(() => reportCaughtFault(new Error('x'))).not.toThrow();
  });

  it('reportCaughtFault uses the mark and defaults to server', async () => {
    const scope = createFaultScope();
    scope.run(() => reportCaughtFault(clientError('x')));
    expect(scope.fault()).toBe('client');
    const unmarked = createFaultScope();
    unmarked.run(() => reportCaughtFault(new Error('x')));
    expect(unmarked.fault()).toBe('server');
  });

  it('reportCaughtFault with clientQuery classifies a staged error as client', () => {
    const staged = markFault(markQueryStage(new Error('Parser exception'), 'prepare'), 'server');
    const query = createFaultScope();
    query.run(() => reportCaughtFault(staged, { clientQuery: true }));
    expect(query.fault()).toBe('client');

    const internal = createFaultScope();
    internal.run(() => reportCaughtFault(staged));
    expect(internal.fault()).toBe('server');

    const unstaged = createFaultScope();
    unstaged.run(() =>
      reportCaughtFault(markFault(new Error('pool exhausted'), 'server'), { clientQuery: true }),
    );
    expect(unstaged.fault()).toBe('server');
  });

  it('reportCaughtFault with clientQuery takes the engine class of a staged engine error', () => {
    const classify = (err: unknown) => {
      const scope = createFaultScope();
      scope.run(() => reportCaughtFault(err, { clientQuery: true }));
      return scope.fault();
    };
    const engineError = (fault: 'client' | 'server') =>
      markFault(markEngineFault(markQueryStage(new Error('engine'), 'execute'), fault), 'server');
    expect(classify(engineError('server'))).toBe('server');
    expect(classify(engineError('client'))).toBe('client');
    // An error the adapter raised at that stage (a timeout) has no engine class.
    expect(classify(markFault(markQueryStage(new Error('timed out'), 'execute'), 'server'))).toBe(
      'client',
    );
  });

  it("reportCaughtFault with missingParameter makes an uncategorized engine error the caller's", () => {
    const classify = (err: unknown, missingParameter: boolean) => {
      const scope = createFaultScope();
      scope.run(() => reportCaughtFault(err, { clientQuery: true, missingParameter }));
      return scope.fault();
    };
    const engineError = (fault: 'client' | 'server' | 'unrecognized') =>
      markFault(markEngineFault(markQueryStage(new Error('engine'), 'execute'), fault), 'server');
    expect(classify(engineError('unrecognized'), true)).toBe('client');
    expect(classify(engineError('unrecognized'), false)).toBe('server');
    // A recognized category keeps its class either way.
    expect(classify(engineError('server'), true)).toBe('server');
    expect(classify(engineError('client'), false)).toBe('client');
    expect(engineFaultOf(engineError('unrecognized'))).toBe('server');
  });

  it('reads the engine class from the error itself, not from its cause', () => {
    const engine = markEngineFault(new Error('Connection exception: read-only'), 'server');
    const wrapper = new Error('Write operations are not allowed.', { cause: engine });
    expect(engineFaultOf(engine)).toBe('server');
    expect(engineFaultOf(wrapper)).toBeUndefined();
    expect(engineFaultOf('text')).toBeUndefined();
    expect(engineFaultOf(null)).toBeUndefined();
  });
});

describe('path error marks', () => {
  const withCode = (code: string) => Object.assign(new Error(code), { code });

  it.each([
    'ENOENT',
    'ENOTDIR',
    'EISDIR',
    'ENAMETOOLONG',
    'ELOOP',
    'EINVAL',
    'ERR_INVALID_ARG_VALUE',
  ])('%s from a caller path is a client fault', async (code) => {
    const err = withCode(code);
    expect(markPathFault(err)).toBe(err);
    expect(faultOf(err)).toBe('client');
  });

  it.each(['EACCES', 'EPERM', 'EIO', 'EMFILE', 'ENFILE', 'EBUSY'])(
    '%s stays unmarked, so it is a server fault',
    (code) => {
      expect(faultOf(markPathFault(withCode(code)))).toBeUndefined();
    },
  );

  it('an error without a code, a non-object and a throwing code getter stay unmarked', () => {
    expect(faultOf(markPathFault(new Error('no code')))).toBeUndefined();
    expect(markPathFault(undefined)).toBeUndefined();
    const hostile = new Error('hostile');
    Object.defineProperty(hostile, 'code', {
      get() {
        throw new Error('code getter');
      },
    });
    expect(() => markPathFault(hostile)).not.toThrow();
    expect(faultOf(hostile)).toBeUndefined();
  });
});
