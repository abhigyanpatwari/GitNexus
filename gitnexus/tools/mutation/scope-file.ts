/**
 * Scope file for tools/mutation/vitest.mutation.config.ts (KTD9).
 *
 * The caller of a mutation run writes a JSON file `{ "testFiles": ["test/unit/a.test.ts"] }`
 * with POSIX paths relative to the `gitnexus/` package (the prepared copy or its sandbox) and
 * names it in the {@link MUTATION_SCOPE_ENV} environment variable. The config uses the list as
 * the `include` of its single `mutation` project.
 *
 * This module is imported by the Vitest config, so it must stay free of heavy dependencies.
 */
import path from 'node:path';

/** Environment variable naming the scope file: absolute, or relative to the package dir. */
export const MUTATION_SCOPE_ENV = 'GITNEXUS_MUTATION_SCOPE';

export interface MutationScope {
  testFiles: string[];
}

const fail = (detail: string): never => {
  throw new Error(`mutation scope: ${detail}`);
};

/** Parses and validates the text of a scope file. */
export function parseMutationScope(text: string): MutationScope {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return fail(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return fail('must be a JSON object');
  }
  const testFiles: unknown = 'testFiles' in data ? data.testFiles : undefined;
  if (!Array.isArray(testFiles) || testFiles.length === 0) {
    return fail('testFiles must be a non-empty array');
  }
  const seen = new Set<string>();
  for (const entry of testFiles) {
    if (typeof entry !== 'string') return fail(`entry ${JSON.stringify(entry)} must be a string`);
    const segments = entry.split('/');
    if (
      entry.includes('\\') ||
      path.posix.isAbsolute(entry) ||
      segments.some((s) => s === '..' || s === '.' || s === '')
    ) {
      fail(`entry ${JSON.stringify(entry)} must be a package-relative POSIX path`);
    }
    if (seen.has(entry)) fail(`entry ${JSON.stringify(entry)} is listed twice`);
    seen.add(entry);
  }
  return { testFiles: [...seen] };
}

/** The scope file named by {@link MUTATION_SCOPE_ENV}, resolved against the package dir. */
export function resolveMutationScopePath(
  env: Readonly<Record<string, string | undefined>>,
  packageDir: string,
): string {
  const value = env[MUTATION_SCOPE_ENV];
  if (value === undefined || value === '') {
    return fail(`${MUTATION_SCOPE_ENV} must name the scope file of this run`);
  }
  return path.resolve(packageDir, value);
}
