import { describe, it, expect } from 'vitest';
import { emitPythonScopeCaptures } from '../../src/core/ingestion/languages/python/captures.js';
import { pythonProvider } from '../../src/core/ingestion/languages/python.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { getLanguageFromFilename, SupportedLanguages } from 'gitnexus-shared';
import { getProviderForFile } from '../../src/core/ingestion/languages/index.js';

const notebook = JSON.stringify(
  {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { language: 'python', name: 'python3', display_name: 'Python' },
    },
    cells: [
      { cell_type: 'code', metadata: {}, source: ['def train():\n', '    pass\n'], outputs: [] },
    ],
  },
  null,
  2,
);

describe('Python notebook scope captures', () => {
  it('detects .ipynb as Python', () => {
    expect(getLanguageFromFilename('analysis.ipynb')).toBe(SupportedLanguages.Python);
    expect(getProviderForFile('n.ipynb')?.id).toBe(SupportedLanguages.Python);
  });

  it('does not parse raw JSON as Python on the full-file path', () => {
    const matches = emitPythonScopeCaptures(notebook, 'analysis.ipynb');
    const names = matches.flatMap((m) => Object.keys(m));
    expect(names.some((k) => k.includes('function'))).toBe(true);
  });

  it('returns no captures for invalid notebook JSON', () => {
    expect(emitPythonScopeCaptures('{not json', 'broken.ipynb')).toEqual([]);
  });

  it('extractParsedFile yields a Function for train', () => {
    const parsed = extractParsedFile(pythonProvider, notebook, 'analysis.ipynb');
    expect(parsed).toBeDefined();
    expect(parsed!.localDefs.some((d) => d.qualifiedName === 'train' || d.name === 'train')).toBe(
      true,
    );
  });
});
