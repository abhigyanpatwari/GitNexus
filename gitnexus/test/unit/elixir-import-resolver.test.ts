import { describe, expect, it } from 'vitest';
import { elixirImportConfig } from '../../src/core/ingestion/import-resolvers/configs/elixir.js';
import { createImportResolver } from '../../src/core/ingestion/import-resolvers/resolver-factory.js';

describe('Elixir import resolver', () => {
  it('expands grouped aliases into their individual module files', () => {
    const resolve = createImportResolver(elixirImportConfig);
    expect(
      resolve('Prefix.{One, Two}', 'lib/app.ex', {
        allFileList: ['lib/prefix/one.ex', 'lib/prefix/two.ex'],
      }),
    ).toEqual({ kind: 'files', files: ['lib/prefix/one.ex', 'lib/prefix/two.ex'] });
  });

  it('prefers an exact root module candidate regardless of file-list order', () => {
    const resolve = createImportResolver(elixirImportConfig);
    for (const allFileList of [
      ['apps/umbrella/lib/my_app/user.ex', 'lib/my_app/user.ex'],
      ['lib/my_app/user.ex', 'apps/umbrella/lib/my_app/user.ex'],
    ]) {
      expect(resolve('MyApp.User', 'lib/app.ex', { allFileList })).toEqual({
        kind: 'files',
        files: ['lib/my_app/user.ex'],
      });
    }
  });
});
