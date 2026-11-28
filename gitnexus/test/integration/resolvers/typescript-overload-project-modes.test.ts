import { describe, expect, it } from 'vitest';
import { useFixture } from './helpers.js';

describe('nullish calls in files included by multiple TypeScript projects', () => {
  const shared = [
    'function pick(value: string): void;',
    'function pick(value: number | null): void;',
    'function pick(value: unknown) {}',
    'export function shared() { pick(null); pick(1); }',
  ].join('\n');
  const outcomes = new Map<string, string[]>();
  useFixture(
    'ts-overload-project-modes',
    {
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [{ path: 'strict' }, { path: 'loose' }],
      }),
      'strict/tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true },
        files: ['main.ts', 'shared.ts'],
      }),
      'loose/tsconfig.json': JSON.stringify({
        compilerOptions: { strict: false },
        files: ['main.ts', 'shared.ts'],
      }),
      'strict/main.ts': "import { shared } from '../loose/shared'; export { shared };",
      'loose/main.ts': "import { shared } from '../strict/shared'; export { shared };",
      'strict/shared.ts': shared,
      'loose/shared.ts': shared,
    },
    {
      skipDerivedGraphPhases: true,
      workerPoolSize: 1,
      onScopeResolved({ parsedFiles, referenceBindings }) {
        for (const file of parsedFiles.filter((file) => file.filePath.endsWith('/shared.ts'))) {
          const calls = file.referenceSites.filter(
            (site) => site.kind === 'call' && site.name === 'pick',
          );
          outcomes.set(
            file.filePath,
            calls.map((site) => referenceBindings.get(site)?.status ?? 'missing'),
          );
        }
      },
    },
  );

  it('keeps a definite binding only when the including programs agree', () => {
    expect(outcomes.get('strict/shared.ts')).toEqual(['unresolved', 'resolved']);
    expect(outcomes.get('loose/shared.ts')).toEqual(['unresolved', 'resolved']);
  });
});
