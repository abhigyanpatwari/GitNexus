import { SignatureKind, SymbolFlags } from 'typescript/unstable/sync';
import { SyntaxKind } from 'typescript/unstable/ast';

function implementationOf(project, selected) {
  let implementation = selected;
  if (!selected.body && selected.kind === SyntaxKind.Constructor) {
    implementation = selected.parent.members.find(
      (member) => member.kind === SyntaxKind.Constructor && member.body,
    );
  } else if (!selected.body && selected.name) {
    const symbol = project.checker.getSymbolAtLocation(selected.name);
    implementation = symbol?.declarations
      .map((declaration) => declaration.resolve(project))
      .find((declaration) => declaration.body);
  }
  return implementation;
}

export function implementationParameters(project, selected) {
  return Array.from((implementationOf(project, selected) ?? selected).parameters).filter(
    (parameter) => parameter.name?.getText() !== 'this',
  );
}

// Follow checker-resolved bindings through writes and argument passing. These
// are possible targets across paths. The runtime reporter records executed calls.
export function callbackTargets(project, calls, assignments, invocations, declarationKey, record) {
  if (!invocations.length) return;
  const { checker } = project;
  const valuesByDeclaration = new Map();
  function addValue(declaration, value) {
    const key = declarationKey(declaration);
    const values = valuesByDeclaration.get(key) ?? [];
    values.push(value);
    valuesByDeclaration.set(key, values);
  }
  function binding(identifier) {
    const symbol = checker.getSymbolAtLocation(identifier);
    const target = symbol?.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return target?.valueDeclaration?.resolve(project);
  }
  for (const [identifier, value] of assignments) {
    const declaration = binding(identifier);
    if (declaration?.name) addValue(declaration.name, value);
  }
  for (const { parameters, args } of calls) {
    for (let i = 0; i < Math.min(parameters.length, args.length); i++) {
      addValue(parameters[i].name, args[i]);
    }
  }
  for (const { parameter, caller, site } of invocations) {
    const pending = [parameter.name];
    const visited = new Set();
    const targets = new Set();
    while (pending.length) {
      const expression = pending.pop();
      if (expression.kind === SyntaxKind.Identifier) {
        const source = binding(expression);
        if (
          source?.kind === SyntaxKind.Parameter ||
          source?.kind === SyntaxKind.VariableDeclaration
        ) {
          const key = declarationKey(source.name);
          if (!visited.has(key)) {
            visited.add(key);
            pending.push(...(valuesByDeclaration.get(key) ?? []));
          }
          continue;
        }
      }
      if (expression.kind === SyntaxKind.ConditionalExpression) {
        pending.push(expression.whenTrue, expression.whenFalse);
        continue;
      }
      if (
        expression.kind === SyntaxKind.BinaryExpression &&
        [SyntaxKind.QuestionQuestionToken, SyntaxKind.BarBarToken].includes(
          expression.operatorToken.kind,
        )
      ) {
        pending.push(expression.left, expression.right);
        continue;
      }
      if (
        [
          SyntaxKind.ParenthesizedExpression,
          SyntaxKind.AsExpression,
          SyntaxKind.TypeAssertionExpression,
          SyntaxKind.NonNullExpression,
          SyntaxKind.SatisfiesExpression,
        ].includes(expression.kind)
      ) {
        pending.push(expression.expression);
        continue;
      }
      for (const signature of checker.getSignaturesOfType(
        checker.getTypeAtLocation(expression),
        SignatureKind.Call,
      )) {
        const declaration = signature.declaration?.resolve(project);
        const target = declaration && implementationOf(project, declaration);
        if (target?.body && !targets.has(declarationKey(target))) {
          targets.add(declarationKey(target));
          record(caller, target, site);
        }
      }
    }
  }
}
