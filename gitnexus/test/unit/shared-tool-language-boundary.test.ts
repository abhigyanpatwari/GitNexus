import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as t from '@babel/types';
import { getLanguageFromFilename, SupportedLanguages } from 'gitnexus-shared';
import { describe, expect, it } from 'vitest';
import { newLanguageFindings, type Finding } from '../helpers/changed-language-findings.js';
import {
  isSharedProductionFile,
  productionPaths,
} from '../helpers/shared-production-language-scope.js';
import { initGitRepo, commitAll } from '../helpers/temp-git-repo.js';
import {
  collectDescendants,
  nodeText,
  parseTypeScript,
  staticStringValue,
  type AstNode,
} from '../helpers/parse-typescript-source.js';

const root = path.resolve(__dirname, '../../..');
const languages = Object.values(SupportedLanguages);
// Use the canonical detection table without importing native parsers in the quality job.
const detection = 'gitnexus-shared/src/language-detection.ts';
const extensions = collectDescendants(
  parseTypeScript(detection, readFileSync(path.join(root, detection), 'utf8')).ast,
)
  .filter((node) => t.isStringLiteral(node))
  .map((node) => node.value)
  .filter((value) => /^\.\w+$/.test(value) && getLanguageFromFilename('file' + value));
const roots = [
  'gitnexus/src/core/analysis',
  'gitnexus/src/mcp',
  'gitnexus-web/src/core/llm',
  'gitnexus/src/cli',
  'gitnexus/src/server',
];
const reasonFilter = new RegExp(
  '\\.reason\\s*(?:<>|!=|=|STARTS WITH|ENDS WITH)\\s*[\'"](?:' + languages.join('|') + ')[-_:]',
  'i',
);
const providerReason = new RegExp('^(?:' + languages.join('|') + ')[-_][a-z][a-z0-9_-]*:\\s*\\S');

function namesLanguage(specifier: string): boolean {
  return specifier.split('/').some((part) => {
    const name = part
      .replace(/\.[cm]?[jt]sx?$/, '')
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .replaceAll('_', '-')
      .toLowerCase();
    return languages.some((lang) => ('-' + name + '-').includes('-' + lang + '-'));
  });
}

function importSource(node: t.Node): string | undefined {
  if (
    t.isImportDeclaration(node) ||
    t.isExportAllDeclaration(node) ||
    t.isExportNamedDeclaration(node)
  ) {
    return node.source?.value;
  }
  if (t.isTSImportType(node)) return staticStringValue(node.source);
  if (t.isTSExternalModuleReference(node)) return staticStringValue(node.expression);
  if (t.isImportExpression(node)) return staticStringValue(node.source);
  if (
    t.isCallExpression(node) &&
    (t.isImport(node.callee) || t.isIdentifier(node.callee, { name: 'require' }))
  ) {
    return staticStringValue(node.arguments[0]);
  }
}

function languageSuffixPattern(pattern: string, flags: string): boolean {
  if (!pattern.includes('\\.')) return false;
  const regex = new RegExp(pattern, flags.replace(/[gy]/g, ''));
  // A generic path/extension matcher treats an unknown extension the same.
  return ['src/module', 'src/module.test'].some(
    (prefix) =>
      !regex.test(prefix + '.not_a_language') && extensions.some((ext) => regex.test(prefix + ext)),
  );
}

function isQueryLiteral(node: AstNode): boolean {
  const parent = t.isTemplateElement(node) ? node.parent?.parent : node.parent;
  return (
    t.isCallExpression(parent) ||
    t.isReturnStatement(parent) ||
    (t.isVariableDeclarator(parent) &&
      t.isIdentifier(parent.id) &&
      /query|cypher|statement|^q$/i.test(parent.id.name))
  );
}

function violations(file: string, source: string): Finding[] {
  const hits: Finding[] = [];
  const declarationDigests = new WeakMap<t.Node, string>();
  const declarationDigest = (declaration: t.Node, name: t.Identifier) => {
    let digest = declarationDigests.get(declaration);
    if (digest === undefined) {
      if (
        declaration.start == null ||
        declaration.end == null ||
        name.start == null ||
        name.end == null
      )
        throw new Error('Missing declaration or identifier range in ' + file);
      digest = createHash('sha256')
        .update(source.slice(declaration.start, name.start))
        .update('\0')
        .update(source.slice(name.typeAnnotation?.start ?? name.end, declaration.end))
        .digest('hex');
      declarationDigests.set(declaration, digest);
    }
    return digest;
  };
  if (namesLanguage(file))
    hits.push({ key: 'filename', location: file + ': language-specific filename' });
  const nodes = collectDescendants(parseTypeScript(file, source).ast);
  const languageEnums = new Set(['SupportedLanguages']);
  const modulePaths = new Set(['import.meta.url']);
  for (const node of nodes) {
    if (
      t.isImportSpecifier(node) &&
      t.isIdentifier(node.imported, { name: 'SupportedLanguages' })
    ) {
      languageEnums.add(node.local.name);
    }
    if (
      t.isVariableDeclarator(node) &&
      t.isIdentifier(node.id) &&
      node.init &&
      nodeText(source, node.init).replace(/\s/g, '') === 'fileURLToPath(import.meta.url)'
    ) {
      modulePaths.add(node.id.name);
    }
  }
  for (const node of nodes) {
    const specifier = importSource(node);
    let reason: string | undefined;
    if (specifier && namesLanguage(specifier)) {
      reason = 'direct language dependency ' + specifier;
    } else {
      // Optional grammar installation has an explicit language/package registry.
      if (file.endsWith('/cli/optional-grammars.ts')) {
        let parent: AstNode | undefined = node;
        while (parent && !t.isVariableDeclarator(parent)) parent = parent.parent;
        if (
          t.isVariableDeclarator(parent) &&
          t.isIdentifier(parent.id, { name: 'OPTIONAL_GRAMMARS' })
        )
          continue;
      }
      const text = t.isTemplateElement(node)
        ? node.value.cooked
        : t.isStringLiteral(node)
          ? node.value
          : '';
      if (
        t.isMemberExpression(node) &&
        t.isIdentifier(node.object) &&
        languageEnums.has(node.object.name)
      ) {
        reason = 'concrete language enum ' + nodeText(source, node.property);
      } else if (t.isRegExpLiteral(node) && languageSuffixPattern(node.pattern, node.flags)) {
        reason = 'language filename pattern ' + node.pattern;
      } else if (
        t.isNewExpression(node) &&
        t.isIdentifier(node.callee, { name: 'RegExp' }) &&
        languageSuffixPattern(
          staticStringValue(node.arguments[0]) ?? '',
          staticStringValue(node.arguments[1]) ?? '',
        )
      ) {
        reason = 'language filename pattern ' + staticStringValue(node.arguments[0]);
      } else if (text && reasonFilter.test(text) && isQueryLiteral(node)) {
        reason = 'provider-specific graph reason filter ' + reasonFilter.exec(text)?.[0];
      } else if (text && providerReason.test(text)) {
        reason = 'provider-specific reason value ' + text;
      } else if (
        t.isImportSpecifier(node) &&
        t.isIdentifier(node.imported) &&
        namesLanguage(node.imported.name)
      ) {
        reason = 'provider-specific import ' + node.imported.name;
      } else if (t.isStringLiteral(node) && node.parent) {
        // Source/compiled worker selection is about the running GitNexus module.
        if (
          node.value === '.ts' &&
          t.isCallExpression(node.parent) &&
          t.isMemberExpression(node.parent.callee) &&
          t.isIdentifier(node.parent.callee.property, { name: 'endsWith' }) &&
          modulePaths.has(nodeText(source, node.parent.callee.object))
        )
          continue;
        const comparison =
          t.isBinaryExpression(node.parent) ||
          t.isArrayExpression(node.parent) ||
          t.isSwitchCase(node.parent) ||
          t.isCallExpression(node.parent);
        if (
          comparison &&
          /^\.?[\w.-]+$/.test(node.value) &&
          (node.value.startsWith('.') || !node.value.includes('.')) &&
          getLanguageFromFilename(node.value.startsWith('.') ? 'file' + node.value : node.value) !==
            null
        ) {
          reason = 'language filename literal ' + node.value;
        } else if (
          comparison &&
          languages.some((lang) => lang === node.value) &&
          (t.isBinaryExpression(node.parent) || t.isSwitchCase(node.parent)) &&
          (node.value.length > 2 ||
            /lang|provider/i.test(
              nodeText(
                source,
                t.isSwitchCase(node.parent) &&
                  node.parent.parent &&
                  t.isSwitchStatement(node.parent.parent)
                  ? node.parent.parent.discriminant
                  : node.parent,
              ),
            ))
        ) {
          reason = 'concrete language discriminator ' + node.value;
        }
      }
    }
    if (!reason) continue;
    const owners: string[] = [];
    let renamedOwnerDigest: (() => string) | undefined;
    for (let parent = node.parent; parent; parent = parent.parent) {
      let name: t.Node | null | undefined;
      if (
        t.isFunctionDeclaration(parent) ||
        t.isClassDeclaration(parent) ||
        t.isVariableDeclarator(parent)
      )
        name = t.isIdentifier(parent.id) ? parent.id : undefined;
      else if (t.isClassMethod(parent) || t.isObjectMethod(parent)) name = parent.key;
      if (!name) continue;
      if (!owners.length && t.isIdentifier(name) && !('computed' in parent && parent.computed)) {
        const declaration = parent;
        const identifier = name;
        renamedOwnerDigest = () => declarationDigest(declaration, identifier);
      }
      owners.push(t.isIdentifier(name) ? name.name : nodeText(source, name));
    }
    // Keep the operation with the finding: moving a check to another function or
    // changing the operand in an existing file must consume a different baseline key.
    const operation =
      t.isStringLiteral(node) &&
      (t.isCallExpression(node.parent) || t.isBinaryExpression(node.parent))
        ? nodeText(source, node.parent).replace(/\s+/g, '')
        : '';
    hits.push({
      key: JSON.stringify([owners, reason, operation]),
      renamedBindingKey:
        renamedOwnerDigest &&
        (() => JSON.stringify([owners.slice(1), renamedOwnerDigest(), reason, operation])),
      location: file + ':' + node.loc?.start.line + ': ' + reason,
    });
  }
  return hits;
}

describe('language ownership in shared tool entry points', () => {
  const inScope = (file: string) => isSharedProductionFile(file, namesLanguage);
  const target = process.env.GITNEXUS_LANGUAGE_BOUNDARY_BASE ?? '';
  it('distinguishes declared implementation and composition sites from similarly named shared modules', () => {
    expect(inScope('gitnexus/src/core/ingestion/languages/python/references.ts')).toBe(false);
    expect(inScope('gitnexus/src/core/ingestion/languages/query-providers.ts')).toBe(false);
    expect(inScope('gitnexus/src/core/ingestion/languages/shared/python-impact.ts')).toBe(true);
    expect(inScope('gitnexus/src/core/analysis/python-impact.ts')).toBe(true);
    expect(inScope('gitnexus-shared/src/python-impact.ts')).toBe(true);
  });
  it.skipIf(!target)(
    'adds no language-specific behavior to shared production code since the merge base',
    () => {
      expect(newLanguageFindings(root, target, productionPaths, inScope, violations)).toEqual([]);
    },
    60_000,
  );

  it('allows declaration renames and detects a check moved to another function', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'gn-language-rename-'));
    try {
      initGitRepo(repo);
      const file = path.join(repo, 'gitnexus-shared/src/impact.ts');
      mkdirSync(path.dirname(file), { recursive: true });
      const check = "file.endsWith('.go')";
      const local = 'const accepts = (file: string) => ' + check + ';';
      const baseline = [
        'function legacyFn(file: string) { return ' + check + '; }',
        'class Rules { legacyMethod(file: string) { return ' + check + '; } }',
        'class legacyRule { accepts = (file: string) => ' + check + '; }',
        'function first() { ' + local + ' }',
        'function second() {}',
      ].join('\n');
      writeFileSync(file, baseline);
      commitAll(repo, 'baseline');
      const scan = () => newLanguageFindings(repo, 'HEAD', productionPaths, inScope, violations);
      writeFileSync(file, baseline.replaceAll('legacy', 'renamed'));
      expect(scan()).toEqual([]);
      writeFileSync(
        file,
        baseline.replace(local, '').replace('second() {}', 'second() { ' + local + ' }'),
      );
      expect(scan()).toEqual([expect.stringContaining('gitnexus-shared/src/impact.ts:5:')]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports newly introduced behavior in an existing shared file and an untracked web component', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'gn-language-ratchet-'));
    try {
      initGitRepo(repo);
      const shared = 'gitnexus-shared/src/impact.ts';
      mkdirSync(path.dirname(path.join(repo, shared)), { recursive: true });
      const prior = "const legacy = (file: string) => file.endsWith('.go');";
      writeFileSync(path.join(repo, shared), prior);
      commitAll(repo, 'baseline');
      const base = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim();
      writeFileSync(path.join(repo, shared), '// Shift the line of existing debt\n' + prior);
      expect(newLanguageFindings(repo, base, productionPaths, inScope, violations)).toEqual([]);
      const renamed = prior.replace('legacy', 'newDispatch');
      writeFileSync(path.join(repo, shared), renamed);
      expect(newLanguageFindings(repo, base, productionPaths, inScope, violations)).toEqual([]);
      writeFileSync(path.join(repo, shared), renamed + '\n' + prior);
      expect(newLanguageFindings(repo, base, productionPaths, inScope, violations)).toEqual([
        expect.stringContaining(shared + ':1:'),
      ]);
      writeFileSync(
        path.join(repo, shared),
        renamed.replace("file.endsWith('.go')", "file.startsWith('.go')") +
          "\nconst skipReasons = ['swift-scope: implicit module visibility'];",
      );
      const web = 'gitnexus-web/src/Panel.tsx';
      mkdirSync(path.dirname(path.join(repo, web)), { recursive: true });
      writeFileSync(
        path.join(repo, web),
        "export const Panel = ({file}) => file.endsWith('.kt') ? <h1/> : null;",
      );
      const hits = newLanguageFindings(repo, base, productionPaths, inScope, violations);
      expect(hits).toEqual([
        expect.stringContaining(shared + ':1:'),
        expect.stringContaining(
          shared + ':2: provider-specific reason value swift-scope: implicit module visibility',
        ),
        expect.stringContaining(web + ':1:'),
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps query routing and provider imports at their registry boundaries', () => {
    const hits: string[] = [];
    for (const dir of roots) {
      const absolute = path.join(root, dir);
      for (const relative of readdirSync(absolute, { recursive: true, encoding: 'utf8' })) {
        if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(relative)) continue;
        const file = dir + '/' + relative.split(path.sep).join('/');
        hits.push(
          ...violations(file, readFileSync(path.join(root, file), 'utf8')).map((v) => v.location),
        );
      }
    }
    expect(hits).toEqual([]);
  }, 30_000);

  it.each(Object.entries(SupportedLanguages))(
    'rejects concrete %s dependencies, enum branches, filenames and suffix checks',
    (member, language) => {
      const source = [
        "import provider from '../languages/" + language + "';",
        "import { SupportedLanguages as L } from 'gitnexus-shared';",
        'if (kind === L.' + member + ') dispatch();',
        "if (file.endsWith('" +
          extensions.find((ext) => getLanguageFromFilename('x' + ext) === language) +
          "')) dispatch();",
      ].join('\n');
      expect(violations(language + '-impact.ts', source)).toHaveLength(4);
    },
  );

  it('distinguishes filename routing from documentation, framework tools, and generic path handling', () => {
    expect(
      violations('impact.ts', String.raw`if (/\.pyi?$/i.test(ownerPath)) handle();`),
    ).toHaveLength(1);
    expect(
      violations(
        'tools.ts',
        `import { getProviderForFile } from '../languages/index.js';
      // Example: if (file.endsWith('.go')) ...
      const docs = 'Python files end in .py'; const tool = 'spring_bean';
      const help = { description: "MATCH (n)-[r]->(m) WHERE r.reason = 'swift-scope: example' RETURN n" };
      const example = 'A persisted reason can look like dart-scope: package identity dependency.';
      switch (status) { case 'r': break; }
      if (/\\.[^/]+$/.test(file)) getProviderForFile(file);`,
      ),
    ).toEqual([]);
  });

  it('keeps persisted language-specific import reasons out of graph filters and shared data', () => {
    expect(
      violations(
        'imports.ts',
        `
      import { DART_PACKAGE_IDENTITY_REASON } from '../edge-reasons.js';
      const query = "MATCH (n)-[r]->(m) WHERE r.reason <> 'swift-scope: implicit module visibility' RETURN n";
      const skipReasons = ['swift-scope: implicit module visibility'];
      export const identity = 'dart-scope: package identity dependency';
    `,
      ),
    ).toHaveLength(4);
  });
});
