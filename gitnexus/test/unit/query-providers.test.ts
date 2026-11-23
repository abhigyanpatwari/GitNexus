import { afterEach, assert, expect, it, vi } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import {
  getQueryProvider,
  getQueryProviderForFile,
  isIndexedSourceFile,
  providerNonInitializingImportReasons,
} from '../../src/core/ingestion/languages/query-providers.js';

it('exposes the same query hooks and recognizes every provider extension', () => {
  for (const id of Object.values(SupportedLanguages)) {
    const full = getProvider(id);
    const query = getQueryProvider(id);
    expect(query.callCompatibility).toBe(full.callCompatibility);
    expect(query.typeImportAttribution).toBe(full.typeImportAttribution);
    expect(query.notExportedIsFilePrivate).toBe(full.notExportedIsFilePrivate);
    expect(query.additionalIndexedExtensions).toBe(full.additionalIndexedExtensions);
    expect(query.nonInitializingImportReasons).toBe(full.nonInitializingImportReasons);
    for (const reason of full.nonInitializingImportReasons ?? []) {
      expect(providerNonInitializingImportReasons).toContain(reason);
    }
    for (const ext of full.extensions) {
      expect(getQueryProviderForFile('source' + ext), id + ' ' + ext).toBe(query);
      expect(getQueryProviderForFile('source' + ext.toUpperCase())).toBe(query);
    }
    for (const ext of full.additionalIndexedExtensions ?? []) {
      expect(isIndexedSourceFile('source' + ext.toUpperCase())).toBe(true);
    }
  }
});

it('recognizes indexed templates, standalone sources and extensionless filenames', () => {
  for (const file of [
    'a.COPYBOOK',
    'a.JOB',
    'a.jcl',
    'a.PROC',
    'x.EJS',
    'x.HTML',
    'x.HTM',
    'x.HBS',
    'form.BLADE.PHP',
    'pkg/Gemfile',
  ]) {
    expect(isIndexedSourceFile(file), file).toBe(true);
  }
  for (const file of ['README.md', 'tasks.json', 'model.pyi', 'x.hbs.backup']) {
    expect(isIndexedSourceFile(file), file).toBe(false);
  }
  expect(getQueryProviderForFile('form.BLADE.PHP')).toBeNull();
  expect(getQueryProviderForFile('a.JOB')).toBeNull();
});

afterEach(() => {
  vi.doUnmock('../../src/core/ingestion/languages/index.js');
  vi.doUnmock('../../src/core/ingestion/languages/typescript/file-private-exports.js');
  vi.doUnmock('../../src/core/ingestion/languages/python.js');
});

it.each([
  ['"""No explicit __all__ here."""', 'Public', true],
  ['"""__all__"""', 'Public', true],
  ['# no __all__', '_Hidden', false],
  ['note = "no __all__"', 'Public', true],
  ['__all__ = []', 'Public', false],
  ['__all__ = ["_Hidden"]', '_Hidden', true],
  ['__all__ = names()', 'Public', undefined],
  ['globals()["__all__"] = names()', 'Public', undefined],
  ['globals().update({"__all__": names()})', 'Public', undefined],
  ['def __getattr__(name):\n    if name == "__all__": return names()', 'Public', undefined],
  ['exec("__all__ = []")', 'Public', undefined],
] as const)('classifies wildcard import of %s (%s)', async (declaration, name, expected) => {
  const readOwner = vi.fn(async () => declaration + '\nclass Public: pass\nclass _Hidden: pass\n');
  const attribution = getQueryProviderForFile('model.py')?.typeImportAttribution;
  assert(attribution);
  const classify = await attribution.createClassifier({
    ownerPath: 'model.py',
    name,
    readOwner,
  });
  for (const importer of ['a.py', 'b.py']) {
    expect(await classify(importer, 'from model import *', new Set(['model.py']))).toBe(expected);
  }
  expect(readOwner).toHaveBeenCalledTimes(1);
});

it('classifies query inputs without initializing ingestion or the syntax parsers', async () => {
  vi.resetModules();
  const eager = () => {
    throw new Error('loaded a parser or ingestion provider during dispatch');
  };
  vi.doMock('../../src/core/ingestion/languages/index.js', eager);
  vi.doMock('../../src/core/ingestion/languages/typescript/file-private-exports.js', eager);
  vi.doMock('../../src/core/ingestion/languages/python.js', eager);
  const { getQueryProviderForFile, isIndexedSourceFile } =
    await import('../../src/core/ingestion/languages/query-providers.js');
  expect(isIndexedSourceFile('readme.md')).toBe(false);
  expect(getQueryProviderForFile('lib.ts')?.id).toBe(SupportedLanguages.TypeScript);
  expect(getQueryProviderForFile('model.py')?.callCompatibility).toBeDefined();
});
