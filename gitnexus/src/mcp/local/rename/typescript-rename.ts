import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript-language-service';
import {
  RenameFailure,
  repositoryPath,
  type RenameOptions,
  type RenamePlan,
  type RenameSymbol,
} from './rename-plan.js';

function checkNewName(name: string, oldName: string): void {
  if (typeof name !== 'string' || !name || name === oldName || name.includes('\\')) {
    throw new RenameFailure('invalid_name', 'new_name must be a different, unescaped identifier.');
  }
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    name,
  );
  if (
    scanner.scan() !== ts.SyntaxKind.Identifier ||
    scanner.getTokenPos() !== 0 ||
    scanner.getTextPos() !== name.length ||
    scanner.scan() !== ts.SyntaxKind.EndOfFileToken
  ) {
    throw new RenameFailure(
      'invalid_name',
      'new_name must be one identifier; keywords, whitespace and punctuation are unsupported.',
    );
  }
}

function declarationKind(node: ts.Node): string | undefined {
  if (
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  )
    return 'method';
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return 'function';
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isModuleDeclaration(node)) return 'namespace';
  if (
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isPropertyAssignment(node)
  )
    return 'property';
  if (ts.isVariableDeclaration(node))
    return node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ? 'function'
      : 'variable';
  if (ts.isParameter(node) || ts.isBindingElement(node)) return 'variable';
  return undefined;
}

function matchesKind(actual: string, expected?: string): boolean {
  if (!expected) return true;
  const kind = expected.toLowerCase();
  if (kind === 'const' || kind === 'variable') return actual === 'variable';
  if (kind === 'typealias') return actual === 'type';
  return actual === kind;
}

function ownerName(node: ts.Node): string {
  const owners: string[] = [];
  for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
    if (declarationKind(parent)) {
      const name = (parent as ts.NamedDeclaration).name;
      if (name && ts.isIdentifier(name)) owners.unshift(name.text);
    }
  }
  return owners.join('.');
}

function declarationPosition(source: ts.SourceFile, symbol: RenameSymbol): number {
  if (
    !Number.isSafeInteger(symbol.startLine) ||
    symbol.startLine < 1 ||
    (symbol.endLine !== undefined &&
      (!Number.isSafeInteger(symbol.endLine) || symbol.endLine < symbol.startLine))
  ) {
    throw new RenameFailure(
      'stale_symbol',
      'The indexed declaration has no usable source range. Reindex and select it again.',
    );
  }
  let expectedOwner: string | undefined;
  if (symbol.uid) {
    const prefix = `${symbol.kind ?? symbol.uid.split(':')[0]}:${symbol.filePath}:`;
    if (!symbol.uid.startsWith(prefix))
      throw new RenameFailure(
        'stale_symbol',
        'Symbol identity does not match its file and kind. Reindex and select it again.',
      );
    const qualified = symbol.uid.slice(prefix.length).replace(/#\d+.*$/, '');
    if (qualified === symbol.name) expectedOwner = '';
    else if (qualified.endsWith(`.${symbol.name}`))
      expectedOwner = qualified.slice(0, -(symbol.name.length + 1));
    else
      throw new RenameFailure(
        'stale_symbol',
        'This indexed declaration identity is not supported. Reindex and select a named declaration.',
      );
  }
  const candidates: ts.Identifier[] = [];
  function visit(node: ts.Node): void {
    const kind = declarationKind(node);
    const name = kind ? (node as ts.NamedDeclaration).name : undefined;
    if (
      name &&
      ts.isIdentifier(name) &&
      name.text === symbol.name &&
      matchesKind(kind!, symbol.kind)
    ) {
      // Tree-sitter records variable statements (including export/const), while
      // the compiler owns the identifier on a VariableDeclaration.
      const rangeNode =
        ts.isVariableDeclaration(node) &&
        ts.isVariableDeclarationList(node.parent) &&
        ts.isVariableStatement(node.parent.parent)
          ? node.parent.parent
          : node;
      const start = source.getLineAndCharacterOfPosition(rangeNode.getStart(source)).line + 1;
      const end =
        source.getLineAndCharacterOfPosition(
          Math.max(rangeNode.getStart(source), rangeNode.end - 1),
        ).line + 1;
      if (
        start === symbol.startLine &&
        (symbol.endLine === undefined || end === symbol.endLine) &&
        (expectedOwner === undefined || ownerName(node) === expectedOwner)
      )
        candidates.push(name);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (candidates.length !== 1)
    throw new RenameFailure(
      'stale_symbol',
      'The indexed name, kind, owner and range do not identify one current declaration. Reindex and select it again.',
    );
  return candidates[0].getStart(source);
}

/** Uses our pinned compiler API only; project compiler packages/plugins are never executed. */
export function planTypeScriptRename(
  repoPath: string,
  symbol: RenameSymbol,
  options: RenameOptions,
): RenamePlan {
  checkNewName(options.new_name, symbol.name);
  const root = path.resolve(repoPath);
  const target = repositoryPath(root, symbol.filePath);
  const realRoot = fs.realpathSync(root);
  repositoryPath(realRoot, fs.realpathSync(target));
  const snapshots = new Map<string, string>();
  const readFile = (filename: string): string | undefined => {
    const absolute = path.resolve(filename);
    if (snapshots.has(absolute)) return snapshots.get(absolute);
    try {
      // Keep the exact on-disk BOM and UTF-16 offsets; ts.sys.readFile strips BOMs.
      const bytes = fs.readFileSync(absolute);
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes))
        throw new RenameFailure(
          'unsupported_encoding',
          `Rename requires losslessly decoded UTF-8 input: ${absolute}`,
          'unsupported',
        );
      snapshots.set(absolute, text);
      return text;
    } catch (error) {
      if (error instanceof RenameFailure) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new RenameFailure(
        'read_failed',
        `Cannot read rename input ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const canonical = (file: string) =>
    ts.sys.useCaseSensitiveFileNames ? path.resolve(file) : path.resolve(file).toLowerCase();
  let configs: string[] = [];
  if (options.tsconfig_path !== undefined) {
    if (
      typeof options.tsconfig_path !== 'string' ||
      !options.tsconfig_path ||
      path.isAbsolute(options.tsconfig_path)
    ) {
      throw new RenameFailure(
        'invalid_config_path',
        'tsconfig_path must be a repository-relative config filename.',
      );
    }
    configs = [repositoryPath(root, options.tsconfig_path)];
  } else {
    for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
      configs.push(
        ...fs
          .readdirSync(dir)
          .filter((name) => /^(?:tsconfig|jsconfig).*\.json$/i.test(name))
          .map((name) => path.join(dir, name)),
      );
      if (dir === root) break;
    }
  }
  if (!configs.length)
    throw new RenameFailure(
      'missing_project',
      'No configured TS/JS project found. Add a config or supply tsconfig_path.',
      'unsupported',
    );
  const candidates: { config: string; parsed: ts.ParsedCommandLine }[] = [];
  for (const config of configs.sort()) {
    repositoryPath(realRoot, fs.realpathSync(config));
    const loaded = ts.readConfigFile(config, readFile);
    const parsed = loaded.error
      ? undefined
      : ts.parseJsonConfigFileContent(
          loaded.config,
          { ...ts.sys, readFile },
          path.dirname(config),
          undefined,
          config,
        );
    const errors = loaded.error ? [loaded.error] : parsed!.errors;
    if (errors.length)
      throw new RenameFailure(
        'invalid_project',
        `Cannot use ${path.relative(root, config)}: ${errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, ' ')).join('; ')}`,
        'unsupported',
      );
    if (parsed!.fileNames.some((file) => canonical(file) === canonical(target)))
      candidates.push({ config, parsed: parsed! });
  }
  if (!candidates.length)
    throw new RenameFailure(
      'missing_project',
      'The selected declaration is not included in a configured project. Supply tsconfig_path for its owning project.',
      'unsupported',
    );
  if (candidates.length > 1)
    throw new RenameFailure(
      'ambiguous_project',
      'Several configured projects contain this declaration. Select one using tsconfig_path.',
      'blocked',
      candidates.map((c) => path.relative(root, c.config).split(path.sep).join('/')),
    );
  const { config, parsed } = candidates[0];
  if (parsed.projectReferences?.length)
    throw new RenameFailure(
      'project_references',
      'Project references require cross-project coordination and are not supported for rename. Select a self-contained project.',
      'unsupported',
    );
  const host: ts.LanguageServiceHost = {
    ...ts.sys,
    readFile,
    getCurrentDirectory: () => root,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: () => '0',
    getScriptSnapshot: (filename) => {
      const text = readFile(filename);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
  };
  const service = ts.createLanguageService(host);
  try {
    const program = service.getProgram();
    const source = program?.getSourceFile(target);
    if (!source)
      throw new RenameFailure(
        'missing_source',
        'The compiler could not load the indexed source.',
        'unsupported',
      );
    // Capture every source file, including unedited dependencies: a changed
    // declaration elsewhere can invalidate the compiler's binding decisions.
    for (const file of program.getSourceFiles()) {
      if (readFile(file.fileName) !== file.text)
        throw new RenameFailure(
          'source_changed',
          `Compiler source snapshot mismatch: ${file.fileName}`,
        );
    }
    const position = declarationPosition(source, symbol);
    const preferences: ts.UserPreferences = {
      providePrefixAndSuffixTextForRename: true,
      allowRenameOfImportPath: false,
    };
    const info = service.getRenameInfo(target, position, preferences);
    if (info.canRename === false)
      throw new RenameFailure('unsupported_target', info.localizedErrorMessage, 'unsupported');
    if (info.fileToRename)
      throw new RenameFailure(
        'file_rename',
        'File and import-path renames are not supported.',
        'unsupported',
      );
    const locations = service.findRenameLocations(target, position, false, false, preferences);
    if (!locations?.length)
      throw new RenameFailure(
        'no_locations',
        'The compiler returned no rename locations.',
        'unsupported',
      );
    return {
      symbol,
      new_name: options.new_name,
      snapshots,
      coverage: {
        name: 'typescript',
        version: ts.version,
        scope: 'project',
        tsconfig_path: path.relative(root, config).split(path.sep).join('/'),
        source_file_count: program
          .getSourceFiles()
          .filter(
            (file) =>
              !program.isSourceFileDefaultLibrary(file) &&
              !program.isSourceFileFromExternalLibrary(file),
          ).length,
      },
      edits: locations.map((location) => {
        const absolute = repositoryPath(root, location.fileName);
        const snapshot = snapshots.get(absolute);
        if (snapshot === undefined)
          throw new RenameFailure(
            'missing_snapshot',
            `The compiler returned an uncaptured source: ${location.fileName}`,
          );
        return {
          file_path: path.relative(root, absolute).split(path.sep).join('/'),
          start: location.textSpan.start,
          length: location.textSpan.length,
          old_text: snapshot.slice(
            location.textSpan.start,
            location.textSpan.start + location.textSpan.length,
          ),
          new_text: `${location.prefixText ?? ''}${options.new_name}${location.suffixText ?? ''}`,
        };
      }),
    };
  } finally {
    service.dispose();
  }
}
