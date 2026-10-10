import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript-language-service';
import { renameSymbol, type RenameSymbol } from '../../src/mcp/local/rename/rename-plan.js';

describe('configured TypeScript semantic rename', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-rename-'));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function fixture(files: Record<string, string>, config = 'tsconfig.json') {
    await fs.writeFile(
      path.join(root, config),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'CommonJS',
          allowJs: true,
          checkJs: true,
          jsx: 'preserve',
          skipLibCheck: true,
        },
        include: ['**/*'],
      }),
    );
    for (const [file, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), text);
    }
  }
  const method = (name: string, startLine: number, endLine = startLine): RenameSymbol => ({
    name,
    kind: 'Method',
    filePath: 'model.ts',
    startLine,
    endLine,
  });

  // Independent direct compiler oracle: compare every span and replacement,
  // not just counts or text matches. It does not use the production planner.
  function oracle(file: string, position: number, newName: string, config = 'tsconfig.json') {
    const cfg = ts.readConfigFile(path.join(root, config), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
    const host: ts.LanguageServiceHost = {
      ...ts.sys,
      getCurrentDirectory: () => root,
      getCompilationSettings: () => parsed.options,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getScriptFileNames: () => parsed.fileNames,
      getScriptVersion: () => '0',
      getScriptSnapshot: (filename) => {
        const text = ts.sys.readFile(filename);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    };
    const service = ts.createLanguageService(host);
    try {
      return service
        .findRenameLocations(path.join(root, file), position, false, false, {
          providePrefixAndSuffixTextForRename: true,
        })!
        .map((location) => ({
          file_path: path.relative(root, location.fileName).split(path.sep).join('/'),
          start: location.textSpan.start,
          length: location.textSpan.length,
          new_text: `${location.prefixText ?? ''}${newName}${location.suffixText ?? ''}`,
        }))
        .sort((a, b) => a.file_path.localeCompare(b.file_path) || a.start - b.start);
    } finally {
      service.dispose();
    }
  }
  function diagnostics(config = 'tsconfig.json') {
    const cfg = ts.readConfigFile(path.join(root, config), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
      .map((d) => `${d.code}:${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
      .sort();
  }
  async function assertOracle(symbol: RenameSymbol, newName: string, config?: string) {
    const source = await fs.readFile(path.join(root, symbol.filePath), 'utf8');
    const offset =
      source
        .split('\n')
        .slice(0, symbol.startLine - 1)
        .join('\n').length + (symbol.startLine > 1 ? 1 : 0);
    const position = source.indexOf(symbol.name, offset);
    const expected = oracle(symbol.filePath, position, newName, config);
    const baseline = diagnostics(config);
    const preview = await renameSymbol(root, symbol, { new_name: newName, tsconfig_path: config });
    expect(preview.status, JSON.stringify(preview)).toBe('success');
    expect(preview.coverage).toMatchObject({
      name: 'typescript',
      version: '5.9.3',
      scope: 'project',
      tsconfig_path: config ?? 'tsconfig.json',
    });
    expect(
      preview.changes.flatMap((file) =>
        file.edits.map((edit) => ({
          file_path: file.file_path,
          start: edit.start,
          length: edit.length,
          new_text: edit.new_text,
        })),
      ),
    ).toEqual(expected);
    expect(preview).toMatchObject({
      graph_edits: 0,
      text_search_edits: 0,
      text_search: 'not_used',
      semantic_edits: expected.length,
    });
    const applied = await renameSymbol(root, symbol, {
      new_name: newName,
      tsconfig_path: config,
      dry_run: false,
    });
    expect(applied).toMatchObject({
      status: 'success',
      applied: true,
      total_edits: expected.length,
    });
    expect(diagnostics(config)).toEqual(baseline);
    return preview;
  }

  it('finds map iteration callers while preserving an unrelated close method and prose without rg', async () => {
    await fixture({
      'model.ts':
        'export class SyncCsvWriter {\n  close() {}\n}\nexport class PdgEmitSink { close() {} }\n',
      'caller.ts':
        'import { SyncCsvWriter, PdgEmitSink } from "./model";\nconst writers = new Map<string, SyncCsvWriter>();\nfor (const w of writers.values()) { w.close(); w.close(); }\nnew PdgEmitSink().close(); // close\nconst title = "close";\n',
    });
    vi.stubEnv('PATH', '');
    const result = await assertOracle(method('close', 2), 'finish');
    expect(result.total_edits).toBe(3);
    expect(await fs.readFile(path.join(root, 'caller.ts'), 'utf8')).toContain(
      'new PdgEmitSink().close(); // close\nconst title = "close";',
    );
  });

  it('keeps a hook key beside this.resolve and follows base and derived overrides', async () => {
    await fixture({
      'model.ts':
        'export class ScopeTreeHarvester {\n  resolve(n: number) { return n; }\n  hooks = { resolve: (n: number) => this.resolve(n) };\n}\nexport class Derived extends ScopeTreeHarvester {\n  override resolve(n: number) { return super.resolve(n); }\n}\nnew Derived().resolve(1); // resolve\n',
    });
    await assertOracle(method('resolve', 2), 'lookup');
    const text = await fs.readFile(path.join(root, 'model.ts'), 'utf8');
    expect(text).toContain('hooks = { resolve: (n: number) => this.lookup(n) }');
    expect(text).toContain('override lookup');
  });

  it('preserves compiler affixes for barrels, shorthand and destructuring', async () => {
    await fixture({
      'model.ts':
        'export const target = 1;\nconst obj = { target };\nconst { target: local } = obj;\n',
      'barrel.ts': 'export { target } from "./model";\n',
      'caller.ts': 'import { target } from "./barrel";\nconst result = target;\n',
    });
    const result = await assertOracle(
      { name: 'target', kind: 'Const', filePath: 'model.ts', startLine: 1, endLine: 1 },
      'renamed',
    );
    expect(
      result.changes.flatMap((c) => c.edits).some((e) => e.new_text.includes(' as target')),
    ).toBe(true);
    expect(await fs.readFile(path.join(root, 'model.ts'), 'utf8')).toContain('{ target: renamed }');
    expect(await fs.readFile(path.join(root, 'caller.ts'), 'utf8')).toContain(
      'const result = target;',
    );
  });

  it('requires a config choice and allows an explicit nonstandard config', async () => {
    await fixture({
      'model.ts': 'export function target() {}',
      'test.ts': 'import { target } from "./model"; target();',
    });
    await fs.writeFile(
      path.join(root, 'tsconfig.test.json'),
      JSON.stringify({ extends: './tsconfig.json' }),
    );
    const symbol = { name: 'target', kind: 'Function', filePath: 'model.ts', startLine: 1 };
    const ambiguous = await renameSymbol(root, symbol, { new_name: 'changed', dry_run: false });
    expect(ambiguous).toMatchObject({
      planning_status: 'blocked',
      applied: false,
      code: 'ambiguous_project',
      candidates: ['tsconfig.json', 'tsconfig.test.json'],
    });
    await fs.rename(path.join(root, 'tsconfig.test.json'), path.join(root, 'custom-project.json'));
    await assertOracle(symbol, 'changed', 'custom-project.json');
  });

  it.each([
    ['main.js', 'jsconfig.json', '$target', 'δelta'],
    ['main.jsx', 'jsconfig.json', 'δelta', '$target'],
    ['main.tsx', 'tsconfig.json', '$target', 'δelta'],
  ])('supports %s and scanner-validated identifiers', async (file, config, name, next) => {
    await fixture({ [file]: `export function ${name}() { return 1; }\n${name}();` }, config);
    await assertOracle({ name, kind: 'Function', filePath: file, startLine: 1 }, next, config);
  });

  it.each(['class', 'a-b', ' foo', 'foo ', 'close', 'foo/*x*/', '\\u0061'])(
    'rejects unsafe or unchanged new name %s',
    async (new_name) => {
      await fixture({ 'model.ts': 'class A {\nclose() {}\n}' });
      expect(
        await renameSymbol(root, method('close', 2), { new_name, dry_run: false }),
      ).toMatchObject({ planning_status: 'blocked', applied: false });
      expect(await fs.readFile(path.join(root, 'model.ts'), 'utf8')).toContain('close()');
    },
  );

  it.each([
    'missing config',
    'malformed config',
    'not member',
    'references',
    'unsupported language',
  ] as const)('refuses %s without writes', async (reason) => {
    await fixture({ 'model.ts': 'class A {\nclose() {}\n}' });
    let symbol = method('close', 2);
    if (reason === 'missing config') await fs.unlink(path.join(root, 'tsconfig.json'));
    if (reason === 'malformed config')
      await fs.writeFile(path.join(root, 'tsconfig.json'), '{ "compilerOptions":');
    if (reason === 'not member')
      await fs.writeFile(path.join(root, 'tsconfig.json'), '{ "files": [] }');
    if (reason === 'references')
      await fs.writeFile(
        path.join(root, 'tsconfig.json'),
        '{ "references": [{ "path": "./other" }], "include": ["model.ts"] }',
      );
    if (reason === 'unsupported language') symbol = { ...symbol, filePath: 'model.rs' };
    expect(await renameSymbol(root, symbol, { new_name: 'finish', dry_run: false })).toMatchObject({
      planning_status: 'unsupported',
      applied: false,
      total_edits: 0,
    });
    expect(await fs.readFile(path.join(root, 'model.ts'), 'utf8')).toContain('close()');
  });

  it.each([
    { name: 'close', kind: 'Method', filePath: 'model.ts', startLine: 2, endLine: 3 },
    { name: 'close', kind: 'Function', filePath: 'model.ts', startLine: 2, endLine: 2 },
    { name: 'close', kind: 'Method', filePath: 'model.ts', startLine: 1, endLine: 3 },
    {
      uid: 'Method:model.ts:Other.close#0',
      name: 'close',
      kind: 'Method',
      filePath: 'model.ts',
      startLine: 2,
      endLine: 2,
    },
  ])('rejects stale or mismatched declaration identity: %j', async (symbol) => {
    await fixture({ 'model.ts': 'class A {\nclose() {}\n}' });
    expect(await renameSymbol(root, symbol, { new_name: 'finish', dry_run: false })).toMatchObject({
      planning_status: 'blocked',
      code: 'stale_symbol',
      total_edits: 0,
    });
  });

  it('rejects ambiguous same-line declarations rather than choosing the first', async () => {
    await fixture({ 'model.ts': 'class A { close() {} } class B { close() {} }' });
    expect(await renameSymbol(root, method('close', 1), { new_name: 'finish' })).toMatchObject({
      planning_status: 'blocked',
      code: 'stale_symbol',
    });
  });

  it('uses the indexed owner to distinguish same-line method declarations', async () => {
    await fixture({
      'model.ts':
        'class A { close() {} } class B { close() {} }\nnew A().close(); new B().close();',
    });
    const result = await renameSymbol(
      root,
      { ...method('close', 1), uid: 'Method:model.ts:A.close#0' },
      { new_name: 'finish', dry_run: false },
    );
    expect(result).toMatchObject({ status: 'success', total_edits: 2 });
    expect(await fs.readFile(path.join(root, 'model.ts'), 'utf8')).toBe(
      'class A { finish() {} } class B { close() {} }\nnew A().finish(); new B().close();',
    );
  });

  it('preserves a UTF-8 BOM and astral characters preceding compiler spans', async () => {
    const source = '\ufeff// 🐈\r\nexport function target() {}\r\ntarget();\r\n';
    await fixture({ 'model.ts': source });
    const result = await renameSymbol(
      root,
      { name: 'target', kind: 'Function', filePath: 'model.ts', startLine: 2 },
      { new_name: 'changed', dry_run: false },
    );
    expect(result).toMatchObject({ status: 'success', total_edits: 2 });
    expect(await fs.readFile(path.join(root, 'model.ts'), 'utf8')).toBe(
      '\ufeff// 🐈\r\nexport function changed() {}\r\nchanged();\r\n',
    );
  });

  it('refuses bytes that cannot round-trip through UTF-8', async () => {
    await fixture({ 'model.ts': 'export function target() {}\n' });
    const original = Buffer.concat([
      Buffer.from('export function target() {}\n// '),
      Buffer.from([0xff]),
    ]);
    await fs.writeFile(path.join(root, 'model.ts'), original);
    expect(
      await renameSymbol(
        root,
        { name: 'target', kind: 'Function', filePath: 'model.ts', startLine: 1 },
        { new_name: 'changed', dry_run: false },
      ),
    ).toMatchObject({
      planning_status: 'unsupported',
      code: 'unsupported_encoding',
      applied: false,
    });
    expect(await fs.readFile(path.join(root, 'model.ts'))).toEqual(original);
  });

  it('refuses unsupported computed declaration syntax', async () => {
    await fixture({ 'model.ts': 'class A { ["close"]() {} }' });
    expect(
      await renameSymbol(root, method('close', 1), { new_name: 'finish', dry_run: false }),
    ).toMatchObject({ planning_status: 'blocked', code: 'stale_symbol', total_edits: 0 });
    expect(await fs.readFile(path.join(root, 'model.ts'), 'utf8')).toBe(
      'class A { ["close"]() {} }',
    );
  });

  it('rejects a semantic location outside the repository', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-dependency-'));
    try {
      const external = path.join(outside, 'outside.ts');
      await fs.writeFile(
        external,
        'import { target } from ' + JSON.stringify(path.join(root, 'model')) + '; target();',
      );
      await fixture({ 'model.ts': 'export function target() {}' });
      await fs.writeFile(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({ files: ['model.ts', external] }),
      );
      expect(
        await renameSymbol(
          root,
          { name: 'target', kind: 'Function', filePath: 'model.ts', startLine: 1 },
          { new_name: 'changed', dry_run: false },
        ),
      ).toMatchObject({ planning_status: 'blocked', applied: false });
      expect(await fs.readFile(path.join(root, 'model.ts'), 'utf8')).toBe(
        'export function target() {}',
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
