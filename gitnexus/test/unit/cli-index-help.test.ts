import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import * as ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { localizeCliHelp } from '../../src/cli/help-i18n.js';
import { setCliLanguage, type SupportedCliLanguage } from '../../src/cli/i18n/index.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const cliEntry = path.join(repoRoot, 'src/cli/index.ts');

function runHelp(command: string, env: NodeJS.ProcessEnv = {}) {
  return runHelpArgs([command], env);
}

function runHelpArgs(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runRootHelp(env: NodeJS.ProcessEnv = {}) {
  return runHelpArgs([], env);
}

const allHelpCommands = [
  [],
  ['setup'],
  ['analyze'],
  ['index'],
  ['serve'],
  ['mcp'],
  ['list'],
  ['status'],
  ['doctor'],
  ['clean'],
  ['remove'],
  ['wiki'],
  ['augment'],
  ['publish'],
  ['query'],
  ['context'],
  ['impact'],
  ['cypher'],
  ['detect-changes'],
  ['eval-server'],
  ['group'],
  ['group', 'create'],
  ['group', 'add'],
  ['group', 'remove'],
  ['group', 'list'],
  ['group', 'status'],
  ['group', 'sync'],
  ['group', 'impact'],
  ['group', 'query'],
  ['group', 'contracts'],
];

function staticStringValue(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(node.left);
    const right = staticStringValue(node.right);
    if (left !== undefined && right !== undefined) return `${left}${right}`;
  }
  return undefined;
}

function extractRegisteredHelpDescriptions(): string[] {
  const descriptions = new Set<string>();
  const sourceFiles = ['src/cli/index.ts', 'src/cli/group.ts'];

  for (const relativePath of sourceFiles) {
    const filePath = path.join(repoRoot, relativePath);
    const source = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const description =
          method === 'description'
            ? staticStringValue(node.arguments[0])
            : method === 'option' || method === 'requiredOption'
              ? staticStringValue(node.arguments[1])
              : undefined;

        if (description && /[A-Za-z]/.test(description)) {
          descriptions.add(description.replace(/\s+/g, ' ').trim());
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return [...descriptions].filter((description) => description.length > 0).sort();
}

function metadataHelp(language: SupportedCliLanguage) {
  setCliLanguage(language);
  const command = new Command('probe');
  command.addOption(new Option('--mode <mode>', 'Mode').choices(['fast', 'safe']));
  command.addOption(new Option('--limit <n>', 'Limit').default('5'));
  command.addOption(new Option('--level [name]', 'Level').preset('auto'));
  command.addOption(new Option('--token <token>', 'Token').env('GITNEXUS_TOKEN'));
  localizeCliHelp(command);
  return command.helpInformation();
}

describe('CLI help surface', () => {
  afterEach(() => setCliLanguage(null));

  it('root help localizes commander headings, options, and command descriptions', () => {
    const result = runRootHelp({ GITNEXUS_LANG: 'zh-CN' } as NodeJS.ProcessEnv);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('用法： gitnexus [options] [command]');
    expect(result.stdout).toContain('GitNexus 本地 CLI 和 MCP 服务器');
    expect(result.stdout).toContain('选项：');
    expect(result.stdout).toContain('-V, --version                            输出版本号');
    expect(result.stdout).toContain('-h, --help                               显示命令帮助');
    expect(result.stdout).toContain('命令：');
    expect(result.stdout).toContain('setup');
    expect(result.stdout).toContain('一次性设置：为 Cursor、Claude Code、OpenCode、Codex 配置 MCP');
    expect(result.stdout).toContain('detect-changes|detect_changes [options]');
    expect(result.stdout).toContain('将 git diff hunk 映射到已索引符号和受影响执行流程');
    expect(result.stdout).not.toContain('GitNexus local CLI and MCP server');
    expect(result.stdout).not.toContain('display help for command');
  });

  it('command help localizes option descriptions and help suffix text', () => {
    const result = runHelp('query', { GITNEXUS_LANG: 'zh-CN' } as NodeJS.ProcessEnv);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('用法： gitnexus query [options] <search_query>');
    expect(result.stdout).toContain('搜索知识图谱中与概念相关的执行流程');
    expect(result.stdout).toContain('-r, --repo <name>     目标仓库（仅有一个已索引仓库时可省略）');
    expect(result.stdout).toContain('-l, --limit <n>       最多返回的流程数（默认：5）');
    expect(result.stdout).toContain('-h, --help            显示命令帮助');
    expect(result.stdout).not.toContain('Target repository (omit if only one indexed)');
  });

  it('setup help exposes selective coding-agent configuration', () => {
    const result = runHelp('setup');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gitnexus setup [options]');
    expect(result.stdout).toContain('-c, --coding-agent <agents>');
  });

  it('localizes every registered CLI command and option description in zh-CN help', () => {
    const zhHelpOutput = allHelpCommands
      .map((args) => {
        const result = runHelpArgs(args, { GITNEXUS_LANG: 'zh-CN' } as NodeJS.ProcessEnv);

        expect(result.status, `gitnexus ${args.join(' ')} --help`).toBe(0);
        return result.stdout;
      })
      .join('\n');

    const untranslated = extractRegisteredHelpDescriptions().filter((description) =>
      zhHelpOutput.includes(description),
    );

    expect(untranslated).toEqual([]);
  });

  it('analyze help localizes custom environment variable help text', () => {
    const result = runHelp('analyze', { GITNEXUS_LANG: 'zh-CN' } as NodeJS.ProcessEnv);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('环境变量：');
    expect(result.stdout).toContain('当参数和对应环境变量同时提供时，参数优先。');
    expect(result.stdout).toContain('提示：`.gitnexusignore` 支持 `.gitignore` 风格的取反。');
    expect(result.stdout).not.toContain('Environment variables:');
    expect(result.stdout).not.toContain('Flags override the corresponding env vars');
  });

  it('query help keeps advanced search options without importing analyze deps', () => {
    const result = runHelp('query');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--context <text>');
    expect(result.stdout).toContain('--goal <text>');
    expect(result.stdout).toContain('--content');
    expect(result.stderr).not.toContain('tree-sitter-kotlin');
  });

  it('context help keeps optional name and disambiguation flags', () => {
    const result = runHelp('context');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('context [options] [name]');
    expect(result.stdout).toContain('--uid <uid>');
    expect(result.stdout).toContain('--file <path>');
  });

  it('impact help keeps repo, include-tests, and disambiguation flags', () => {
    const result = runHelp('impact');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--depth <n>');
    expect(result.stdout).toContain('--include-tests');
    expect(result.stdout).toContain('--repo <name>');
    // Disambiguation flags (#1907) — mirror the context help test so a
    // missing-flag regression on impact is caught here too.
    expect(result.stdout).toContain('--uid <uid>');
    expect(result.stdout).toContain('--file <path>');
    expect(result.stdout).toContain('--kind <kind>');
  });

  it('detect-changes help exposes compare scope and base-ref flags', () => {
    const result = runHelp('detect-changes');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gitnexus detect-changes|detect_changes [options]');
    expect(result.stdout).toContain('--scope <scope>');
    expect(result.stdout).toContain('--base-ref <ref>');
    expect(result.stdout).toContain('--repo <name>');
  });

  it('query-family commands expose the --branch scope flag (#2106)', () => {
    for (const cmd of ['query', 'context', 'impact', 'cypher', 'detect-changes']) {
      const result = runHelp(cmd);
      expect(result.status, cmd).toBe(0);
      expect(result.stdout, cmd).toContain('--branch <name>');
    }
  });

  it('wiki help shows provider, review, and verbose flags', () => {
    const result = runHelp('wiki');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--provider <provider>');
    expect(result.stdout).toContain('claude');
    expect(result.stdout).toContain('codex');
    expect(result.stdout).toContain('--review');
    expect(result.stdout).toContain('-v, --verbose');
    expect(result.stdout).toContain('--model <model>');
    expect(result.stdout).toContain('--gist');
  });

  it('publish help names the registry, the token env var, and the opt-out behaviour', () => {
    const result = runHelp('publish');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--id <owner/repo>');
    expect(result.stdout).toContain('--skip-git');
    // Discoverability contract: a contributor scanning `--help` must see
    // (a) which registry this dispatches to, and (b) the env var that
    // gates the opt-in. Both are part of the no-token contract.
    expect(result.stdout).toContain('understand-quickly');
    expect(result.stdout).toContain('UNDERSTAND_QUICKLY_TOKEN');
  });

  it('analyze help includes the FTS repair option', () => {
    const result = runHelp('analyze');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--repair-fts');
  });

  it('localizes commander-generated option metadata labels', () => {
    const english = metadataHelp('en');
    const chinese = metadataHelp('zh-CN');

    expect(english).toContain('choices: "fast", "safe"');
    expect(english).toContain('default: "5"');
    expect(english).toContain('preset: "auto"');
    expect(english).toContain('env: GITNEXUS_TOKEN');

    expect(chinese).toContain('可选值: "fast", "safe"');
    expect(chinese).toContain('默认: "5"');
    expect(chinese).toContain('预设: "auto"');
    expect(chinese).toContain('环境变量: GITNEXUS_TOKEN');
  });
});
