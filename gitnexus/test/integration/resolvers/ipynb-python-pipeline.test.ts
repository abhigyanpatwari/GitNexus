/**
 * Jupyter notebooks are indexed as Python by extracting code cells.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getNodesByLabel,
  getNodesByLabelFull,
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
} from './helpers.js';
import { extractNotebookPython } from '../../../src/core/ingestion/ipynb-extractor.js';

function pythonNotebook(cells: Array<{ source: string | string[]; language?: string }>): string {
  return JSON.stringify(
    {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
        language_info: { name: 'python' },
      },
      cells: cells.map((c) => ({
        cell_type: 'code',
        metadata: c.language ? { language: c.language } : {},
        source: c.source,
        outputs: [],
      })),
    },
    null,
    2,
  );
}

describe('Jupyter notebook Python pipeline', () => {
  it('keeps class methods out of notebook module bindings', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ipynb-scope-'));
    try {
      const declarations = 'class Box:\n    def target(self):\n        return 1\n';
      writeFixtureRepo(root, {
        'lib.py': 'def target():\n    return 2\n',
        'unbound.ipynb': pythonNotebook([
          { source: declarations },
          { source: 'def unbound_caller():\n    return target()\n' },
        ]),
        'imported.ipynb': pythonNotebook([
          { source: 'from lib import target\n' },
          { source: declarations },
          { source: 'def imported_caller():\n    return target()\n' },
        ]),
      });
      const result = await runPipelineFromRepo(root, () => {}, { skipGraphPhases: true });
      const calls = getRelationships(result, 'CALLS').filter((edge) => edge.target === 'target');
      expect(calls.filter((edge) => edge.rel.targetId.includes('Box.target'))).toEqual([]);
      expect(
        calls
          .filter((edge) => edge.source === 'imported_caller')
          .map((edge) => edge.targetFilePath),
      ).toEqual(['lib.py']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it('indexes notebook functions, imports sibling py, and skip-fails closed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ipynb-'));
    try {
      writeFixtureRepo(root, {
        'lib.py': 'def helper():\n    return 1\n',
        'analysis.ipynb': pythonNotebook([
          { source: ['from lib import helper\n'] },
          { source: ['def train():\n', '    return helper()\n'] },
        ]),
        'broken.ipynb': '{not json',
        'julia.ipynb': JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {
            kernelspec: { language: 'julia', name: 'julia', display_name: 'Julia' },
          },
          cells: [
            { cell_type: 'code', metadata: {}, source: ['function train() end\n'], outputs: [] },
          ],
        }),
      });
      const result = await runPipelineFromRepo(root, () => {}, { skipGraphPhases: true });
      const functions = getNodesByLabel(result, 'Function');
      expect(functions).toContain('train');
      expect(functions).toContain('helper');
      const train = getNodesByLabelFull(result, 'Function').find((n) => n.name === 'train');
      expect(train?.properties.filePath.replace(/\\/g, '/')).toMatch(/analysis\.ipynb$/);
      const extracted = extractNotebookPython(
        fs.readFileSync(path.join(root, 'analysis.ipynb'), 'utf8'),
      )!;
      expect(train?.properties.startLine).toBe(extracted.segments[1].jsonStartLine);
      const imports = getRelationships(result, 'IMPORTS');
      expect(
        imports.some(
          (e) =>
            e.sourceFilePath.replace(/\\/g, '/').endsWith('analysis.ipynb') &&
            (e.target === 'helper' || e.targetFilePath.replace(/\\/g, '/').endsWith('lib.py')),
        ),
      ).toBe(true);
      expect(
        getNodesByLabelFull(result, 'Function').filter(
          (n) =>
            n.properties.filePath.replace(/\\/g, '/').endsWith('julia.ipynb') && n.name === 'train',
        ),
      ).toHaveLength(0);
      expect(
        getNodesByLabelFull(result, 'Function').filter((n) =>
          n.properties.filePath.replace(/\\/g, '/').endsWith('broken.ipynb'),
        ),
      ).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
