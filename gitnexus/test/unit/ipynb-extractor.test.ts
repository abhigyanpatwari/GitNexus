import { describe, it, expect } from 'vitest';
import {
  extractNotebookPython,
  mapExtractLine,
  notebookPythonSnippet,
  isPythonFamilyLanguage,
} from '../../src/core/ingestion/ipynb-extractor.js';

function notebook(opts: {
  language?: string;
  languageInfo?: string;
  cells: Array<Record<string, unknown>>;
}): string {
  const kernelspec =
    opts.language === undefined
      ? undefined
      : { display_name: 'Python', language: opts.language, name: 'python' };
  const language_info = opts.languageInfo === undefined ? undefined : { name: opts.languageInfo };
  return JSON.stringify(
    {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        ...(kernelspec ? { kernelspec } : {}),
        ...(language_info ? { language_info } : {}),
      },
      cells: opts.cells,
    },
    null,
    2,
  );
}

describe('isPythonFamilyLanguage', () => {
  it('accepts python3 and ipython', () => {
    expect(isPythonFamilyLanguage('python3')).toBe(true);
    expect(isPythonFamilyLanguage('IPython')).toBe(true);
    expect(isPythonFamilyLanguage('julia')).toBe(false);
  });
});

describe('extractNotebookPython', () => {
  it('maps source that is serialized before cell_type', () => {
    const content = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { language: 'python', name: 'python3', display_name: 'Python' } },
      cells: [
        {
          source: ['def train():\n', '    pass\n'],
          cell_type: 'code',
          metadata: {},
          outputs: [],
        },
      ],
    });
    const result = extractNotebookPython(content);
    expect(result?.pythonSource).toContain('def train');
    expect(result?.segments).toHaveLength(1);
  });

  it('extracts def train from a Python v4 notebook', () => {
    const content = notebook({
      language: 'python',
      cells: [
        {
          cell_type: 'code',
          metadata: {},
          source: ['def train():\n', '    pass\n'],
          outputs: [],
        },
      ],
    });
    const result = extractNotebookPython(content);
    expect(result).not.toBeNull();
    expect(result!.pythonSource).toContain('def train():');
    expect(result!.segments).toHaveLength(1);
    const defJsonLine = content.split('\n').findIndex((l) => l.includes('def train'));
    expect(result!.segments[0].jsonStartLine).toBe(defJsonLine);
  });

  it('keeps two code cells in order with two segments', () => {
    const content = notebook({
      language: 'python',
      cells: [
        { cell_type: 'code', metadata: {}, source: ['x = 1\n'], outputs: [] },
        {
          cell_type: 'code',
          metadata: {},
          source: ['def train():\n', '    return x\n'],
          outputs: [],
        },
      ],
    });
    const result = extractNotebookPython(content);
    expect(result).not.toBeNull();
    expect(result!.pythonSource).toMatch(/x = 1\n+def train/);
    expect(result!.segments).toHaveLength(2);
    const defRow = result!.pythonSource.split('\n').findIndex((l) => l.startsWith('def train'));
    expect(defRow).toBe(result!.segments[1].extractStartLine);
    expect(mapExtractLine(defRow, result!.segments)).toBe(result!.segments[1].jsonStartLine);
  });

  it('accepts source as a single string', () => {
    const content = notebook({
      language: 'python',
      cells: [{ cell_type: 'code', metadata: {}, source: 'y = 2\n', outputs: [] }],
    });
    expect(extractNotebookPython(content)?.pythonSource).toContain('y = 2');
  });

  it('returns null for markdown-only notebooks', () => {
    const content = notebook({
      language: 'python',
      cells: [{ cell_type: 'markdown', metadata: {}, source: ['# hi\n'] }],
    });
    expect(extractNotebookPython(content)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(extractNotebookPython('{not json')).toBeNull();
  });

  it('returns null for a Julia kernelspec', () => {
    const content = notebook({
      language: 'julia',
      cells: [{ cell_type: 'code', metadata: {}, source: ['1 + 1\n'], outputs: [] }],
    });
    expect(extractNotebookPython(content)).toBeNull();
  });

  it('extracts python3 kernelspec', () => {
    const content = notebook({
      language: 'python3',
      cells: [{ cell_type: 'code', metadata: {}, source: ['a = 1\n'], outputs: [] }],
    });
    expect(extractNotebookPython(content)?.pythonSource).toContain('a = 1');
  });

  it('comments line magics in place', () => {
    const content = notebook({
      language: 'python',
      cells: [
        {
          cell_type: 'code',
          metadata: {},
          source: ['%time\n', 'x = 1\n', '!ls\n'],
          outputs: [],
        },
      ],
    });
    const result = extractNotebookPython(content);
    expect(result!.pythonSource.split('\n').filter((l) => l.length > 0)).toEqual([
      '# %time',
      'x = 1',
      '# !ls',
    ]);
  });

  it('skips a %%bash cell and still extracts later train', () => {
    const content = notebook({
      language: 'python',
      cells: [
        { cell_type: 'code', metadata: {}, source: ['%%bash\n', 'echo hi\n'], outputs: [] },
        { cell_type: 'code', metadata: {}, source: ['def train():\n', '    pass\n'], outputs: [] },
      ],
    });
    const result = extractNotebookPython(content);
    expect(result!.pythonSource).toContain('def train');
    expect(result!.pythonSource).not.toContain('echo hi');
  });

  it('maps identical duplicate cells to later JSON lines', () => {
    const src = ['print(1)\n'];
    const content = notebook({
      language: 'python',
      cells: [
        { cell_type: 'code', metadata: {}, source: src, outputs: [] },
        { cell_type: 'code', metadata: {}, source: src, outputs: [] },
      ],
    });
    const result = extractNotebookPython(content);
    expect(result!.segments).toHaveLength(2);
    expect(result!.segments[1].jsonStartLine).toBeGreaterThan(result!.segments[0].jsonStartLine);
  });

  it('skips an R-language code cell and keeps Python cells', () => {
    const content = notebook({
      language: 'python',
      cells: [
        {
          cell_type: 'code',
          metadata: { language: 'R' },
          source: ['x <- 1\n'],
          outputs: [],
        },
        { cell_type: 'code', metadata: {}, source: ['z = 3\n'], outputs: [] },
      ],
    });
    const result = extractNotebookPython(content);
    expect(result!.pythonSource).toContain('z = 3');
    expect(result!.pythonSource).not.toContain('x <- 1');
  });
});

describe('mapExtractLine', () => {
  it('maps a second-cell extract row onto that cell JSON line', () => {
    const content = notebook({
      language: 'python',
      cells: [
        { cell_type: 'markdown', metadata: {}, source: ['# intro\n'] },
        { cell_type: 'code', metadata: {}, source: ['a = 1\n'], outputs: [] },
        { cell_type: 'code', metadata: {}, source: ['def train():\n', '    pass\n'], outputs: [] },
      ],
    });
    const extracted = extractNotebookPython(content)!;
    const trainSeg = extracted.segments[1];
    const mapped = mapExtractLine(trainSeg.extractStartLine, extracted.segments);
    expect(mapped).toBe(trainSeg.jsonStartLine);
    expect(mapped).toBeGreaterThan(extracted.segments[0].jsonStartLine);
  });
});

describe('notebookPythonSnippet', () => {
  it('returns Python def train not JSON cell_type', () => {
    const content = notebook({
      language: 'python',
      cells: [
        { cell_type: 'code', metadata: {}, source: ['def train():\n', '    pass\n'], outputs: [] },
      ],
    });
    const extracted = extractNotebookPython(content)!;
    const snippet = notebookPythonSnippet(
      content,
      extracted.segments[0].jsonStartLine,
      extracted.segments[0].jsonEndLine,
    );
    expect(snippet).toContain('def train');
    expect(snippet).not.toContain('cell_type');
  });
});

describe('extractNotebookPython edge cases', () => {
  it('skips a code cell without source and keeps later Python', () => {
    const content = notebook({
      language: 'python',
      cells: [
        { cell_type: 'code', metadata: {}, source: ['def ok():\n', '    pass\n'], outputs: [] },
        { cell_type: 'code', metadata: {}, outputs: [] },
        { cell_type: 'code', metadata: {}, source: ['def train():\n', '    pass\n'], outputs: [] },
      ],
    });
    const result = extractNotebookPython(content);
    expect(result!.pythonSource).toContain('def ok');
    expect(result!.pythonSource).toContain('def train');
  });

  it('returns null when language_info is julia without kernelspec', () => {
    const content = notebook({
      languageInfo: 'julia',
      cells: [{ cell_type: 'code', metadata: {}, source: ['1 + 1\n'], outputs: [] }],
    });
    expect(extractNotebookPython(content)).toBeNull();
  });

  it('maps coordinates to the last cells array when the key is duplicated', () => {
    const decoy = JSON.stringify(
      [{ cell_type: 'code', metadata: {}, source: ['def decoy():\n', '    pass\n'], outputs: [] }],
      null,
      2,
    );
    const real = JSON.stringify(
      [{ cell_type: 'code', metadata: {}, source: ['def real():\n', '    pass\n'], outputs: [] }],
      null,
      2,
    );
    const content = `{
  "nbformat": 4,
  "nbformat_minor": 5,
  "metadata": { "kernelspec": { "language": "python", "name": "python3", "display_name": "Python" } },
  "cells": ${decoy},
  "cells": ${real}
}`;
    const result = extractNotebookPython(content);
    expect(result!.pythonSource).toContain('def real');
    expect(result!.pythonSource).not.toContain('decoy');
    const realLine = content.split('\n').findIndex((l) => l.includes('def real'));
    expect(result!.segments[0].jsonStartLine).toBe(realLine);
  });
});
