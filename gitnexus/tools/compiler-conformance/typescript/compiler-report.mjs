import assert from 'node:assert/strict';
import { compilerImportTrace } from './import-trace.mjs';
import { callbackTargets, implementationParameters } from './compiler-callbacks.mjs';
import { withWorkspacePackages } from './workspace.mjs';
import { existsSync, globSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { API, SymbolFlags } from 'typescript/unstable/sync';
import { NodeFlags, SyntaxKind } from 'typescript/unstable/ast';
import { skipTrivia } from 'typescript/unstable/ast/scanner';

export const graphRelations = [
  'CALLS',
  'USES',
  'IMPORTS',
  'EXTENDS',
  'IMPLEMENTS',
  'METHOD_OVERRIDES',
  'METHOD_IMPLEMENTS',
];
export const relations = [
  ...graphRelations,
  'CALLABLE_PROPERTIES',
  'PROPERTY_READS',
  'PROPERTY_WRITES',
  'TYPE_PARAMETER_USES',
  'PARAMETER_CALLS',
  'CALLBACK_TARGETS',
  'VARIABLE_READS',
  'DECLARATIONS',
  'HAS_METHOD',
  'METHOD_FACTS',
  'REJECTED_CALLS',
];

export function emptyReport() {
  return Object.fromEntries(relations.map((relation) => [relation, { sites: [], edges: [] }]));
}

function relative(root, source) {
  return path.relative(root, source.fileName).split(path.sep).join('/');
}

function startOfDeclaration(node) {
  // Tree-sitter represents export/default wrappers outside the declaration.
  // A method's modifiers (including override) are part of the method.
  if (
    [
      SyntaxKind.FunctionDeclaration,
      SyntaxKind.ClassDeclaration,
      SyntaxKind.InterfaceDeclaration,
    ].includes(node.kind)
  ) {
    const prefix = Array.from(node.modifiers ?? []).filter(
      (modifier) =>
        modifier.kind === SyntaxKind.ExportKeyword || modifier.kind === SyntaxKind.DefaultKeyword,
    );
    if (prefix.length) return skipTrivia(node.getSourceFile().text, prefix.at(-1).end);
  }
  return node.getStart();
}

function declarationName(node) {
  if (node.name) return node.name.getText();
  if (node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.DefaultKeyword))
    return 'default';
}

function identity(root, node) {
  const source = node.getSourceFile();
  if (node.kind === SyntaxKind.SourceFile) return relative(root, source);
  const pos = source.getLineAndCharacterOfPosition(startOfDeclaration(node));
  const fileLine = relative(root, source) + '#' + (pos.line + 1);
  if (
    [
      SyntaxKind.ClassDeclaration,
      SyntaxKind.InterfaceDeclaration,
      SyntaxKind.TypeAliasDeclaration,
      SyntaxKind.EnumDeclaration,
    ].includes(node.kind)
  ) {
    return fileLine + ':' + (declarationName(node) ?? pos.character);
  }
  return fileLine + ':' + pos.character;
}

// A TypeScript callable has one runtime method even when its signatures
// occupy different lines. Keep the selected declaration in the site report.
function graphIdentity(root, node, project) {
  if (node.kind === SyntaxKind.Constructor) return identity(root, node.parent) + '.constructor';
  if (node.kind === SyntaxKind.MethodDeclaration || node.kind === SyntaxKind.MethodSignature) {
    const owner =
      node.parent.kind === SyntaxKind.TypeLiteral &&
      node.parent.parent.kind === SyntaxKind.TypeAliasDeclaration
        ? node.parent.parent
        : node.parent;
    return identity(root, owner) + '.' + node.name.getText();
  }
  if (node.kind === SyntaxKind.FunctionDeclaration && node.name) {
    const signatures = project.checker.getSymbolAtLocation(node.name)?.declarations;
    if (signatures?.length > 1) return identity(root, signatures[0].resolve(project));
  }
  return identity(root, node);
}

function enclosingCaller(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      [
        SyntaxKind.FunctionDeclaration,
        SyntaxKind.MethodDeclaration,
        SyntaxKind.MethodSignature,
        SyntaxKind.Constructor,
        SyntaxKind.ClassDeclaration,
        SyntaxKind.InterfaceDeclaration,
        SyntaxKind.TypeAliasDeclaration,
        SyntaxKind.SourceFile,
      ].includes(parent.kind)
    ) {
      return parent;
    }
    if (
      (parent.kind === SyntaxKind.FunctionExpression || parent.kind === SyntaxKind.ArrowFunction) &&
      parent.parent.kind === SyntaxKind.VariableDeclaration
    )
      return parent;
  }
  throw new Error('No source caller for ' + node.getText());
}

function symbolDeclaration(symbol, project) {
  return (symbol?.valueDeclaration ?? symbol?.declarations[0])?.resolve(project);
}

export function compilerReport(root, expectedDiagnostics = [], inventory = false, options = {}) {
  return withWorkspacePackages(root, (projectRoot) =>
    reportProject(projectRoot, expectedDiagnostics, inventory, options),
  );
}

function reportProject(
  root,
  expectedDiagnostics,
  inventory,
  { runtime, methodFacts, propertyAccess },
) {
  const localConfig = path.join(root, 'tsconfig.json');
  const scratch = existsSync(localConfig)
    ? undefined
    : mkdtempSync(path.join(tmpdir(), 'gitnexus-ts-config-'));
  const config = scratch ? path.join(scratch, 'tsconfig.json') : localConfig;
  const api = new API({ cwd: root });
  try {
    if (scratch) {
      const files = globSync('**/*.{ts,tsx,mts,cts}', {
        cwd: root,
        exclude: ['**/node_modules/**'],
      }).map((file) => path.join(root, file));
      writeFileSync(
        path.join(scratch, 'tsconfig.json'),
        JSON.stringify({
          files,
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            jsx: 'preserve',
            strict: true,
            noEmit: true,
            types: [],
          },
        }),
        { flag: 'wx' },
      );
    }
    const project = api.updateSnapshot({ openProjects: [config] }).getProject(config);
    assert.ok(project, 'TypeScript failed to open ' + config);
    const { checker, program } = project;
    const files = new Set(
      program.getSourceFileNames().filter((file) => {
        const relativePath = path.relative(root, file);
        return (
          relativePath &&
          !path.isAbsolute(relativePath) &&
          relativePath.split(path.sep)[0] !== '..' &&
          !relativePath.split(path.sep).includes('node_modules')
        );
      }),
    );
    assert.ok(files.size, 'Empty TypeScript project ' + config);
    const result = emptyReport();
    const compilerDiagnostics = [
      ...program.getConfigFileParsingDiagnostics(),
      ...program.getProgramDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ];
    const erasedValueUses = new Map();
    const nonCallableExpressions = new Set();
    const diagnostics = compilerDiagnostics
      .map((diagnostic) => {
        if (diagnostic.code === 2349) {
          nonCallableExpressions.add(
            JSON.stringify([diagnostic.fileName, diagnostic.pos, diagnostic.end]),
          );
        }
        if (diagnostic.code === 1361 || diagnostic.code === 1362) {
          const positions = erasedValueUses.get(diagnostic.fileName) ?? new Set();
          positions.add(diagnostic.pos);
          erasedValueUses.set(diagnostic.fileName, positions);
        }
        const file = diagnostic.fileName && program.getSourceFile(diagnostic.fileName);
        if (!file) return 'project TS' + diagnostic.code;
        const { line, character } = file.getLineAndCharacterOfPosition(diagnostic.pos);
        return relative(root, file) + ':' + (line + 1) + ':' + character + ' TS' + diagnostic.code;
      })
      .sort();
    assert.deepEqual(diagnostics, expectedDiagnostics, 'TypeScript diagnostics for ' + root);

    let importTrace;
    function importedDeclaration(literal) {
      const declaration = symbolDeclaration(checker.getSymbolAtLocation(literal), project);
      if (declaration || !literal.text?.startsWith('.')) return declaration;
      importTrace ??= compilerImportTrace(root, config);
      const target = importTrace
        .get(path.resolve(literal.getSourceFile().fileName))
        ?.get(literal.text);
      return target && program.getSourceFile(target);
    }

    function edge(kind, from, to, site) {
      if (to && files.has(to.getSourceFile().fileName)) {
        const target = identity(root, to);
        result[kind].edges.push({
          from: graphIdentity(root, from, project),
          to: graphIdentity(root, to, project),
        });
        if (site) {
          const source = site.getSourceFile();
          const position = (offset) => {
            const { line, character } = source.getLineAndCharacterOfPosition(offset);
            return line + 1 + ':' + character;
          };
          result[kind].sites.push({
            file: relative(root, source),
            start: position(site.getStart()),
            end: position(site.end),
            status: 'resolved',
            target,
          });
        }
      }
    }

    const callsWithArguments = [];
    const invokedParameters = [];
    const assignments = [];
    function rememberArguments(node, selected) {
      if (
        node.arguments?.length &&
        selected?.parameters?.length &&
        files.has(selected.getSourceFile().fileName)
      ) {
        callsWithArguments.push({
          parameters: implementationParameters(project, selected),
          args: node.arguments,
        });
      }
    }
    function call(node, callee) {
      const caller = enclosingCaller(node);
      const selected = checker.getResolvedSignature(node)?.declaration?.resolve(project);
      rememberArguments(node, selected);
      const parameter =
        callee.kind === SyntaxKind.Identifier
          ? symbolDeclaration(checker.getSymbolAtLocation(callee), project)
          : undefined;
      if (parameter?.kind === SyntaxKind.Parameter && parameter.type) {
        invokedParameters.push({ parameter, caller, site: node });
        const source = node.getSourceFile();
        const position = (offset) => {
          const { line, character } = source.getLineAndCharacterOfPosition(offset);
          return line + 1 + ':' + character;
        };
        result.PARAMETER_CALLS.sites.push({
          file: relative(root, source),
          start: position(node.getStart()),
          end: position(node.end),
          status: 'resolved',
          target: JSON.stringify([identity(root, parameter.name), parameter.type.getText()]),
        });
      }
      // A signature written on a parameter has no executable declaration.
      // Its identity and spelling are checked at the invocation above.
      const parameterSignature =
        parameter?.kind === SyntaxKind.Parameter &&
        selected?.kind === SyntaxKind.FunctionType &&
        selected.getSourceFile().fileName === parameter.getSourceFile().fileName &&
        selected.getStart() === parameter.type?.getStart() &&
        selected.end === parameter.type.end;
      if (!parameterSignature) edge('CALLS', caller, selected, node);
      if (callee.kind === SyntaxKind.PropertyAccessExpression) {
        const member = symbolDeclaration(checker.getSymbolAtLocation(callee.name), project);
        if (
          member?.kind === SyntaxKind.ShorthandPropertyAssignment ||
          member?.kind === SyntaxKind.PropertyAssignment
        )
          edge('CALLABLE_PROPERTIES', caller, member, node);
      }
      return selected;
    }

    function isMethod(node) {
      return (
        node?.kind === SyntaxKind.MethodDeclaration || node?.kind === SyntaxKind.MethodSignature
      );
    }

    function hasModifier(node, kind) {
      return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
    }

    function interfaceContracts(node, seen = new Set()) {
      const contracts = [];
      const key = identity(root, node);
      if (seen.has(key)) return contracts;
      seen.add(key);
      for (const clause of node.heritageClauses ?? []) {
        for (const base of clause.types) {
          const type = checker.getTypeAtLocation(base);
          const decl = symbolDeclaration(type?.getSymbol(), project);
          if (clause.token === SyntaxKind.ImplementsKeyword && type) contracts.push(type);
          else if (decl?.kind === SyntaxKind.ClassDeclaration)
            contracts.push(...interfaceContracts(decl, seen));
        }
      }
      return contracts;
    }

    function recordHeritage(node) {
      for (const clause of node.heritageClauses ?? []) {
        const extendsBase = clause.token === SyntaxKind.ExtendsKeyword;
        for (const base of clause.types) {
          if (
            extendsBase &&
            node.kind === SyntaxKind.ClassDeclaration &&
            isErasedValueUse(base.expression)
          )
            continue;
          const type = checker.getTypeAtLocation(base);
          if (!type) continue;
          edge(
            extendsBase ? 'EXTENDS' : 'IMPLEMENTS',
            node,
            symbolDeclaration(type.getSymbol(), project),
          );
          if (!extendsBase || node.kind !== SyntaxKind.ClassDeclaration) continue;
          for (const method of node.members) {
            if (!isMethod(method)) continue;
            const receiver = hasModifier(method, SyntaxKind.StaticKeyword)
              ? checker.getTypeAtLocation(base.expression)
              : type;
            const member = receiver && checker.getPropertyOfType(receiver, method.name.getText());
            const target = symbolDeclaration(member, project);
            if (isMethod(target)) edge('METHOD_OVERRIDES', node, target);
          }
        }
      }
      if (node.kind !== SyntaxKind.ClassDeclaration) return;
      const classSymbol = node.name
        ? checker.getSymbolAtLocation(node.name)
        : checker.getTypeAtLocation(node)?.getSymbol();
      if (!classSymbol) return;
      const instance = checker.getDeclaredTypeOfSymbol(classSymbol);
      for (const contract of interfaceContracts(node)) {
        for (const member of checker.getPropertiesOfType(contract)) {
          const declaration = symbolDeclaration(member, project);
          if (!isMethod(declaration)) continue;
          const implementation = checker.getPropertyOfType(instance, member.name);
          const method = symbolDeclaration(implementation, project);
          if (
            method?.kind === SyntaxKind.MethodDeclaration &&
            !hasModifier(method, SyntaxKind.AbstractKeyword)
          ) {
            edge('METHOD_IMPLEMENTS', method, declaration);
          }
        }
      }
    }

    function isErasedValueUse(expression) {
      return erasedValueUses.get(expression.getSourceFile().fileName)?.has(expression.getStart());
    }

    function rejectedConstruction(expression) {
      return (
        expression?.kind === SyntaxKind.NewExpression && isErasedValueUse(expression.expression)
      );
    }

    // The checker continues type-checking after an illegal value use and can
    // return recovery signatures for a receiver initialized by that expression.
    function rejectedCall(node) {
      if (isErasedValueUse(node.expression)) return true;
      if (node.expression.kind !== SyntaxKind.PropertyAccessExpression) return false;
      const receiver = node.expression.expression;
      if (receiver.kind !== SyntaxKind.Identifier) return false;
      const declaration = symbolDeclaration(checker.getSymbolAtLocation(receiver), project);
      return (
        declaration?.kind === SyntaxKind.VariableDeclaration &&
        !declaration.type &&
        (declaration.parent.flags & NodeFlags.Const) !== 0 &&
        rejectedConstruction(declaration.initializer)
      );
    }

    const declarationLabels = new Map([
      [SyntaxKind.ClassDeclaration, 'Class'],
      [SyntaxKind.InterfaceDeclaration, 'Interface'],
      [SyntaxKind.FunctionDeclaration, 'Function'],
      [SyntaxKind.MethodDeclaration, 'Method'],
      [SyntaxKind.MethodSignature, 'Method'],
      [SyntaxKind.Constructor, 'Method'],
    ]);
    function propertyReference(node) {
      const field = symbolDeclaration(checker.getSymbolAtLocation(node.name), project);
      if (field?.kind !== SyntaxKind.PropertyDeclaration) return;
      const parent = node.parent;
      const assignment =
        parent.kind === SyntaxKind.BinaryExpression &&
        parent.left === node &&
        parent.operatorToken.kind >= SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= SyntaxKind.LastAssignment;
      const update =
        (parent.kind === SyntaxKind.PostfixUnaryExpression ||
          parent.kind === SyntaxKind.PrefixUnaryExpression) &&
        (parent.operator === SyntaxKind.PlusPlusToken ||
          parent.operator === SyntaxKind.MinusMinusToken);
      const caller = enclosingCaller(node);
      if (assignment || update) edge('PROPERTY_WRITES', caller, field, parent);
      if (!assignment || parent.operatorToken.kind !== SyntaxKind.EqualsToken)
        edge('PROPERTY_READS', caller, field, node);
    }

    function visit(node) {
      if (
        (node.kind === SyntaxKind.VariableDeclaration || node.kind === SyntaxKind.Parameter) &&
        node.name.kind === SyntaxKind.Identifier &&
        node.initializer
      ) {
        assignments.push([node.name, node.initializer]);
      } else if (
        node.kind === SyntaxKind.BinaryExpression &&
        node.left.kind === SyntaxKind.Identifier &&
        node.operatorToken.kind === SyntaxKind.EqualsToken
      ) {
        assignments.push([node.left, node.right]);
      }
      if (propertyAccess && node.kind === SyntaxKind.PropertyAccessExpression)
        propertyReference(node);

      if (methodFacts && node.kind === SyntaxKind.MethodDeclaration) {
        result.METHOD_FACTS.edges.push({
          from: graphIdentity(root, node, project),
          to: JSON.stringify([
            hasModifier(node, SyntaxKind.AbstractKeyword),
            hasModifier(node, SyntaxKind.StaticKeyword),
            Array.from(node.parameters ?? [], (parameter) =>
              checker.typeToString(checker.getTypeAtLocation(parameter)),
            ),
          ]),
        });
      }
      if (runtime && node.kind === SyntaxKind.MethodDeclaration && node.body && node.parent.name) {
        runtime.methods.push({
          file: relative(root, node.getSourceFile()),
          owner: node.parent.name.getText(),
          name: node.name.getText(),
          target: identity(root, node),
          edgeTarget: graphIdentity(root, node, project),
        });
      }
      if (inventory) {
        const variableFunction =
          (node.kind === SyntaxKind.ArrowFunction || node.kind === SyntaxKind.FunctionExpression) &&
          node.parent.kind === SyntaxKind.VariableDeclaration;
        const label = variableFunction ? 'Function' : declarationLabels.get(node.kind);
        const name =
          node.kind === SyntaxKind.Constructor
            ? 'constructor'
            : declarationName(variableFunction ? node.parent : node);
        if (label && name) {
          const target = graphIdentity(root, node, project);
          result.DECLARATIONS.edges.push({
            from: relative(root, node.getSourceFile()),
            to: label + ':' + name + '@' + target,
          });
          if (label === 'Method')
            result.HAS_METHOD.edges.push({ from: identity(root, node.parent), to: target });
        }
      }
      if (
        node.kind === SyntaxKind.ReturnStatement &&
        node.expression?.kind === SyntaxKind.Identifier
      ) {
        const use = node.expression;
        const symbol = checker.getSymbolAtLocation(use);
        const target =
          symbol && (symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
        const variable = symbolDeclaration(target, project);
        if (
          variable?.kind === SyntaxKind.VariableDeclaration &&
          files.has(variable.getSourceFile().fileName)
        ) {
          const source = use.getSourceFile();
          const start = source.getLineAndCharacterOfPosition(use.getStart());
          const end = source.getLineAndCharacterOfPosition(use.end);
          result.VARIABLE_READS.sites.push({
            file: relative(root, source),
            start: start.line + 1 + ':' + start.character,
            end: end.line + 1 + ':' + end.character,
            status: 'resolved',
            target: identity(root, variable.name),
          });
        }
      }
      if (
        (node.kind === SyntaxKind.ImportDeclaration ||
          node.kind === SyntaxKind.ExportDeclaration) &&
        node.moduleSpecifier
      ) {
        const target = importedDeclaration(node.moduleSpecifier);
        edge('IMPORTS', node.getSourceFile(), target);
      }
      const isCall =
        node.kind === SyntaxKind.NewExpression || node.kind === SyntaxKind.CallExpression;
      const rejected =
        isCall &&
        ((erasedValueUses.size > 0 && rejectedCall(node)) ||
          (nonCallableExpressions.size > 0 &&
            nonCallableExpressions.has(
              JSON.stringify([
                node.getSourceFile().fileName,
                node.expression.getStart(),
                node.expression.end,
              ]),
            )));
      if (rejected) {
        const source = node.getSourceFile();
        const start = source.getLineAndCharacterOfPosition(node.getStart());
        const end = source.getLineAndCharacterOfPosition(node.end);
        result.REJECTED_CALLS.sites.push({
          file: relative(root, source),
          start: start.line + 1 + ':' + start.character,
          end: end.line + 1 + ':' + end.character,
          status: 'unresolved',
        });
      }
      if (!rejected && node.kind === SyntaxKind.NewExpression) {
        rememberArguments(node, checker.getResolvedSignature(node)?.declaration?.resolve(project));
        const type = checker.getTypeAtLocation(node);
        edge('CALLS', enclosingCaller(node), symbolDeclaration(type?.getSymbol(), project), node);
      }
      if (!rejected && node.kind === SyntaxKind.CallExpression) {
        if (node.expression.kind === SyntaxKind.ImportKeyword && node.arguments.length) {
          edge('IMPORTS', node.getSourceFile(), importedDeclaration(node.arguments[0]));
        }
        const selected = call(node, node.expression);
        if (runtime && !selected && node.expression.kind === SyntaxKind.PropertyAccessExpression) {
          const source = node.getSourceFile();
          const start = source.getLineAndCharacterOfPosition(node.getStart());
          const end = source.getLineAndCharacterOfPosition(node.end);
          runtime.unchecked.push({
            file: relative(root, source),
            start: [start.line, start.character],
            end: [end.line, end.character],
            caller: graphIdentity(root, enclosingCaller(node), project),
          });
        }
      }
      if (
        node.kind === SyntaxKind.JsxOpeningElement ||
        node.kind === SyntaxKind.JsxSelfClosingElement
      ) {
        call(node, node.tagName);
      }
      if (node.kind === SyntaxKind.TypeReference) {
        const name = checker.getSymbolAtLocation(node.typeName);
        const target =
          name && (name.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(name) : name);
        const decl = symbolDeclaration(target, project);
        if (decl?.kind === SyntaxKind.TypeParameter) {
          const owner = decl.parent.name;
          if (owner) {
            const source = node.getSourceFile();
            const position = (offset) => {
              const p = source.getLineAndCharacterOfPosition(offset);
              return p.line + 1 + ':' + p.character;
            };
            result.TYPE_PARAMETER_USES.sites.push({
              file: relative(root, source),
              start: position(node.typeName.getStart()),
              end: position(node.typeName.end),
              status: 'type-parameter',
              target: identity(root, owner) + '/' + decl.name.getText(),
            });
          }
        } else edge('USES', enclosingCaller(node), decl, node.typeName);
      }
      if (
        node.kind === SyntaxKind.ClassDeclaration ||
        node.kind === SyntaxKind.InterfaceDeclaration
      ) {
        recordHeritage(node);
      }
      node.forEachChild(visit);
    }

    for (const file of files) {
      const source = program.getSourceFile(file);
      assert.ok(source, 'Missing compiler source ' + file);
      visit(source);
    }
    callbackTargets(
      project,
      callsWithArguments,
      assignments,
      invokedParameters,
      (decl) => identity(root, decl),
      (caller, target, site) => edge('CALLBACK_TARGETS', caller, target, site),
    );
    return result;
  } finally {
    api.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [directory, relation = 'CALLS'] = process.argv.slice(2);
  assert.ok(
    directory && relations.includes(relation),
    'Usage: node compiler-report.mjs <project> [' + relations.join('|') + ']',
  );
  const report = compilerReport(
    path.resolve(directory),
    [],
    relation === 'DECLARATIONS' || relation === 'HAS_METHOD',
    { methodFacts: relation === 'METHOD_FACTS' },
  );
  console.log(JSON.stringify({ producer: 'TypeScript', ...report[relation] }, null, 2));
}
