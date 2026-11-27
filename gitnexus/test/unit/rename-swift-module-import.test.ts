/**
 * Semantic rename reads module imports through `ImportVisibility.statementsAt`
 * (`graph-rename.ts`). A Swift `import X` is stored as groups over the
 * module's files unless `GITNEXUS_DISABLE_IMPORT_GROUPS=1`; the rename plan
 * must be the same either way, also when the renamed symbol shares its name
 * with an imported module that declares nothing of that name.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const FILES: Record<string, string> = {
  'Mod/A.swift': 'public struct A {}\n',
  'Mod/B.swift': 'public struct B {}\n',
  'App/Mod.swift': 'struct Mod {\n    init() {}\n}\n',
  'App/Use.swift': 'import Mod\n\nlet first: A? = nil\nlet local = Mod()\n',
};

async function writeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-swift-module-'));
  roots.push(root);
  for (const [file, content] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  return root;
}

async function planWith(root: string, disableGroups: boolean): Promise<unknown> {
  const previous = process.env.GITNEXUS_DISABLE_IMPORT_GROUPS;
  if (disableGroups) process.env.GITNEXUS_DISABLE_IMPORT_GROUPS = '1';
  else delete process.env.GITNEXUS_DISABLE_IMPORT_GROUPS;
  try {
    const result = await runPipelineFromRepo(root, () => undefined, {
      workerPoolSize: 1,
      skipGraphPhases: true,
    });
    const nodes = [...result.graph.iterNodes()];
    const target = nodes.find(
      (node) =>
        node.properties.name === 'Mod' &&
        node.properties.filePath === 'App/Mod.swift' &&
        node.label !== 'File',
    );
    expect(target).toBeDefined();
    const plan = await renameSymbol(
      root,
      {
        uid: target!.id,
        name: target!.properties.name,
        filePath: target!.properties.filePath,
        startLine: target!.properties.startLine! + 1,
        endLine: target!.properties.endLine! + 1,
        kind: target!.label,
      },
      { new_name: 'Box', dry_run: true },
      nodes,
    );
    // The token names the checkout and the plan; compare what the plan does.
    const { plan_token: _token, ...rest } = plan as unknown as Record<string, unknown>;
    return rest;
  } finally {
    if (previous === undefined) delete process.env.GITNEXUS_DISABLE_IMPORT_GROUPS;
    else process.env.GITNEXUS_DISABLE_IMPORT_GROUPS = previous;
  }
}

describe.skipIf(!swiftAvailable)('Swift semantic rename beside a grouped module import', () => {
  it('plans the same rename with grouped and per-file module imports', async () => {
    const root = await writeFixture();
    const perFile = await planWith(root, true);
    const grouped = await planWith(root, false);
    // Both plans succeed and rename the declaration and its use, never the
    // `import Mod` line that only shares the name.
    for (const plan of [perFile, grouped]) {
      expect(plan).toMatchObject({ status: 'success', planning_status: 'ready', total_edits: 2 });
      const edits = (
        plan as { changes: { file_path: string; edits: { line: number }[] }[] }
      ).changes
        .flatMap((change) => change.edits.map((edit) => `${change.file_path}:${edit.line}`))
        .sort();
      expect(edits).toEqual(['App/Mod.swift:1', 'App/Use.swift:4']);
    }
    expect(grouped).toEqual(perFile);
  }, 120000);
});
