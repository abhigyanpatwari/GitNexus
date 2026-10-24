import { describe, expect, it, vi } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import {
  runPostParseHooks,
  type LanguageProvider,
  type PostParseContext,
} from '../../src/core/ingestion/language-provider.js';

type PostParseProvider = Pick<LanguageProvider, 'postParse'>;

const makeCtx = (): PostParseContext => ({
  graph: createKnowledgeGraph(),
  model: createSemanticModel(),
  repoPath: '/repo',
});

const lookup =
  (providers: Partial<Record<SupportedLanguages, PostParseProvider>>) =>
  (language: SupportedLanguages): PostParseProvider | undefined =>
    providers[language];

describe('runPostParseHooks', () => {
  it('(1) fires hooks only for present languages', async () => {
    const r = vi.fn();
    const python = vi.fn();
    const java = vi.fn();

    await runPostParseHooks(
      new Set([SupportedLanguages.R, SupportedLanguages.Python]),
      lookup({
        [SupportedLanguages.R]: { postParse: r },
        [SupportedLanguages.Python]: { postParse: python },
        [SupportedLanguages.Java]: { postParse: java },
      }),
      makeCtx(),
    );

    expect(r).toHaveBeenCalledTimes(1);
    expect(python).toHaveBeenCalledTimes(1);
    expect(java).not.toHaveBeenCalled();
  });

  it('(2) passes the identical ctx object to every hook', async () => {
    const ctx = makeCtx();
    const r = vi.fn();
    const python = vi.fn();

    await runPostParseHooks(
      new Set([SupportedLanguages.R, SupportedLanguages.Python]),
      lookup({
        [SupportedLanguages.R]: { postParse: r },
        [SupportedLanguages.Python]: { postParse: python },
      }),
      ctx,
    );

    expect(r.mock.calls[0][0]).toBe(ctx);
    expect(python.mock.calls[0][0]).toBe(ctx);
  });

  it('(3) runs in language-id order, independent of Set insertion order', async () => {
    const order: string[] = [];
    const providers = {
      [SupportedLanguages.R]: { postParse: () => void order.push('r') },
      [SupportedLanguages.Python]: { postParse: () => void order.push('python') },
      [SupportedLanguages.Java]: { postParse: () => void order.push('java') },
    };

    await runPostParseHooks(
      new Set([SupportedLanguages.R, SupportedLanguages.Java, SupportedLanguages.Python]),
      lookup(providers),
      makeCtx(),
    );
    const forward = [...order];
    order.length = 0;
    await runPostParseHooks(
      new Set([SupportedLanguages.Python, SupportedLanguages.Java, SupportedLanguages.R]),
      lookup(providers),
      makeCtx(),
    );

    expect(forward).toEqual(['java', 'python', 'r']);
    expect(order).toEqual(forward);
  });

  it('(4) awaits async hooks sequentially: the next starts only after the previous resolves', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const run = runPostParseHooks(
      new Set([SupportedLanguages.Java, SupportedLanguages.Python]),
      lookup({
        [SupportedLanguages.Java]: {
          postParse: async () => {
            events.push('java:start');
            await firstGate;
            events.push('java:end');
          },
        },
        [SupportedLanguages.Python]: {
          postParse: async () => {
            events.push('python:start');
          },
        },
      }),
      makeCtx(),
    );

    // Let every microtask that can run, run: the second hook must still be waiting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['java:start']);

    releaseFirst();
    await run;
    expect(events).toEqual(['java:start', 'java:end', 'python:start']);
  });

  it('(5) skips a provider without postParse and a language with no provider', async () => {
    const r = vi.fn();

    await runPostParseHooks(
      new Set([SupportedLanguages.Java, SupportedLanguages.Python, SupportedLanguages.R]),
      lookup({
        [SupportedLanguages.Java]: {},
        [SupportedLanguages.R]: { postParse: r },
      }),
      makeCtx(),
    );

    expect(r).toHaveBeenCalledTimes(1);
  });

  it('(6) calls nothing for an empty language set', async () => {
    const providerFor = vi.fn();

    await runPostParseHooks(new Set(), providerFor, makeCtx());

    expect(providerFor).not.toHaveBeenCalled();
  });

  it('(7) is fail-closed: a rejecting hook rejects the run and later hooks do not run', async () => {
    const later = vi.fn();
    const boom = new Error('post-parse failed');

    await expect(
      runPostParseHooks(
        new Set([SupportedLanguages.Java, SupportedLanguages.Python]),
        lookup({
          [SupportedLanguages.Java]: {
            postParse: async () => {
              throw boom;
            },
          },
          [SupportedLanguages.Python]: { postParse: later },
        }),
        makeCtx(),
      ),
    ).rejects.toBe(boom);

    expect(later).not.toHaveBeenCalled();
  });
});
