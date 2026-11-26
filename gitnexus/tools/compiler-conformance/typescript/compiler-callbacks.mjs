import { SignatureKind } from 'typescript/unstable/sync';
import { SyntaxKind } from 'typescript/unstable/ast';

// The checker selects a function type at callback(). At the call to its owner,
// it can also identify the executable declaration carried by the argument.
export function callbackTargets(project, calls, invocations, declarationKey, record) {
  if (!invocations.length) return;
  const argumentsByParameter = new Map();
  for (const { parameters, args } of calls) {
    for (let i = 0; i < Math.min(parameters.length, args.length); i++) {
      const key = declarationKey(parameters[i].name);
      const values = argumentsByParameter.get(key) ?? [];
      values.push(args[i]);
      argumentsByParameter.set(key, values);
    }
  }
  const { checker } = project;
  for (const { parameter, caller, site } of invocations) {
    const pending = [declarationKey(parameter.name)];
    const visited = new Set();
    while (pending.length) {
      const key = pending.pop();
      if (visited.has(key)) continue;
      visited.add(key);
      for (const arg of argumentsByParameter.get(key) ?? []) {
        const symbol = arg.kind === SyntaxKind.Identifier && checker.getSymbolAtLocation(arg);
        const source = symbol && symbol.valueDeclaration?.resolve(project);
        if (source?.kind === SyntaxKind.Parameter) {
          pending.push(declarationKey(source.name));
          continue;
        }
        const type = checker.getTypeAtLocation(arg);
        for (const signature of checker.getSignaturesOfType(type, SignatureKind.Call)) {
          const target = signature.declaration?.resolve(project);
          if (target?.body) record(caller, target, site);
        }
      }
    }
  }
}
