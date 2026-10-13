import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';
import { createRenameFixtureHelpers } from '../helpers/rename-provider-fixture.js';

const { expectRename, fixture } = createRenameFixtureHelpers();
const functions = 'def target(): return 7\ndef run(): return target()\n';

describe('Python module export-list rename safety', () => {
  it.each([
    ['old name in a list', '__all__ = ["target"]\n'],
    ['destination in a tuple', '__all__ = ("rena\\u006ded",)\n'],
    ['annotated export list', '__all__: list[str] = ["target"]\n'],
    ['unknown export list', '__all__ = discover_exports()\n'],
    ['unknown literal element', '__all__ = [export_name]\n'],
    ['augmented assignment', '__all__ = ["run"]\n__all__ += ["target"]\n'],
    ['mutation', '__all__ = ["run"]\n__all__.append("target")\n'],
    ['escaping list alias', '__all__ = ["run"]\nexports = __all__\nexports.append("target")\n'],
    [
      'mutation through a global binding',
      '__all__ = ["run"]\ndef configure():\n    global __all__\n    __all__.append("target")\n',
    ],
  ])(
    'refuses %s without changing any source',
    async (_description, exports) => {
      const content = exports + functions;
      const { root, nodes, symbol } = await fixture({ 'model.py': content });
      for (const dry_run of [true, false]) {
        expect(
          await renameSymbol(root, symbol, { new_name: 'renamed', dry_run }, nodes),
        ).toMatchObject({
          status: 'error',
          planning_status: 'unsupported',
          code: 'unsupported_occurrence',
          total_edits: 0,
          applied: false,
        });
        expect(await fs.readFile(path.join(root, 'model.py'), 'utf8')).toBe(content);
      }
    },
    60_000,
  );

  it('checks an unaliased re-export module whose local binding changes', async () => {
    const files = {
      'model.py': functions,
      'public.py': 'from model import target\n__all__ = ["target"]\n',
    };
    const { root, nodes, symbol } = await fixture(files, 'target', 'Function', 'model.py');
    for (const dry_run of [true, false]) {
      expect(
        await renameSymbol(root, symbol, { new_name: 'renamed', dry_run }, nodes),
      ).toMatchObject({
        status: 'error',
        planning_status: 'unsupported',
        code: 'unsupported_occurrence',
        total_edits: 0,
        applied: false,
      });
      for (const [file, content] of Object.entries(files))
        expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
    }
  }, 60_000);

  it('preserves unrelated module exports, local export-list shadows, and ordinary strings', async () => {
    const decoys =
      '__all__ = ("run",)\nnote = "target renamed"\n' +
      'def inspect():\n    __all__ = ["target", "renamed"]\n    return __all__\n' +
      'class Metadata:\n    __all__ = ["target", "renamed"]\n';
    const other = '__all__ = ["target", "renamed"]\ndef target(): return 99\n';
    await expectRename(
      { 'model.py': decoys + functions, 'other.py': other },
      {
        'model.py': decoys + 'def renamed(): return 7\ndef run(): return renamed()\n',
        'other.py': other,
      },
      'target',
      'Function',
      'renamed',
      'model.py',
    );
  }, 60_000);
});
