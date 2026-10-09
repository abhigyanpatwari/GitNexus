/** Compiler binding ownership, kept separate from successful symbol extraction. */
import {
  makeScopeId,
  type Capture,
  type CaptureMatch,
  type NameClaim,
  type Range,
  type ScopeKind,
} from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { splitImportStatement } from './import-decomposer.js';
import { interpretPythonImport } from './interpret.js';

const COMPREHENSIONS = new Set([
  'list_comprehension',
  'set_comprehension',
  'dictionary_comprehension',
  'generator_expression',
]);
const CONDITIONAL = new Set([
  'if_statement',
  'for_statement',
  'while_statement',
  'try_statement',
  'match_statement',
]);
interface Environment {
  node: SyntaxNode;
  kind: ScopeKind;
  parent?: Environment;
  claims: NameClaim[];
  directives: Map<string, 'module' | 'enclosing-function'>;
  imports: Map<string, Array<{ identity: string; packageRoot?: string; claim: NameClaim }>>;
}
interface Event {
  env: Environment;
  node: SyntaxNode;
  name: string;
  kind: NameClaim['kind'];
  declaration?: boolean;
  annotationOnly?: boolean;
  deletion?: boolean;
  hoisted?: boolean;
  conditional?: boolean;
  identity?: string;
  packageRoot?: string;
}

/** Attach plain-data facts only: no syntax nodes survive worker transport. */
export function applyPythonLexicalBindings(
  matches: readonly CaptureMatch[],
  root: SyntaxNode,
  filePath: string,
  mapRange: (range: Range) => Range = (range) => range,
): CaptureMatch[] {
  const environments: Environment[] = [];
  const environmentsByRange = new Map<string, Environment>();
  const byNode = new Map<number, Environment>();
  const byRange = new Map<string, SyntaxNode>();
  const events: Event[] = [];
  const annotationOnly = (node: SyntaxNode): boolean =>
    node.type === 'assignment' &&
    node.childForFieldName('type') !== null &&
    node.childForFieldName('right') === null;
  const range = (node: SyntaxNode): Range => ({
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column,
  });
  const key = (r: Range): string => `${r.startLine}:${r.startCol}:${r.endLine}:${r.endCol}`;
  const id = (env: Environment) =>
    makeScopeId({ filePath, kind: env.kind, range: mapRange(range(env.node)) });
  const mark = (node: SyntaxNode, env: Environment): void => {
    byNode.set(node.id, env);
    byRange.set(key(range(node)), node);
  };
  const create = (node: SyntaxNode, kind: ScopeKind, parent?: Environment): Environment => {
    const env: Environment = {
      node,
      kind,
      parent,
      claims: [],
      directives: new Map(),
      imports: new Map(),
    };
    environments.push(env);
    environmentsByRange.set(`${kind}:${key(range(node))}`, env);
    mark(node, env);
    return env;
  };
  const bind = (
    env: Environment,
    node: SyntaxNode | null,
    kind: NameClaim['kind'] = 'binding',
    hoisted = false,
    conditional = false,
    anchor?: SyntaxNode,
  ): void => {
    if (node === null) return;
    if (node.type === 'identifier') {
      events.push({ env, node: anchor ?? node, name: node.text, kind, hoisted, conditional });
      return;
    }
    if (['attribute', 'subscript', 'type'].includes(node.type)) return;
    for (const child of node.namedChildren) bind(env, child, kind, hoisted, conditional, anchor);
  };
  const pattern = (env: Environment, node: SyntaxNode): void => {
    if (node.type === 'dotted_name') {
      if (node.namedChildCount === 1 && node.text !== '_') bind(env, node.firstNamedChild);
      return;
    }
    if (node.type === 'identifier') {
      if (node.text !== '_') bind(env, node);
      return;
    }
    if (node.type === 'class_pattern') {
      for (const child of node.namedChildren.slice(1)) pattern(env, child);
      return;
    }
    if (node.type === 'keyword_pattern') {
      for (const child of node.namedChildren.slice(1)) pattern(env, child);
      return;
    }
    if (node.type === 'dict_pattern') {
      for (const child of node.childrenForFieldName('value')) pattern(env, child);
      for (const child of node.namedChildren)
        if (child.type === 'splat_pattern') pattern(env, child);
      return;
    }
    if (['string', 'concatenated_string', 'attribute'].includes(node.type)) return;
    for (const child of node.namedChildren) pattern(env, child);
  };
  const visit = (node: SyntaxNode, env: Environment, conditional = false): void => {
    mark(node, env);
    if (
      node.type === 'function_definition' ||
      node.type === 'lambda' ||
      node.type === 'class_definition'
    ) {
      const isClass = node.type === 'class_definition';
      if (node.type !== 'lambda') {
        const name = node.childForFieldName('name');
        if (name)
          events.push({
            env,
            node,
            name: name.text,
            kind: 'binding',
            declaration: true,
            conditional,
          });
      }
      const childEnv = create(node, isClass ? 'Class' : 'Function', env);
      const parameters = node.childForFieldName('parameters');
      if (parameters) {
        mark(parameters, childEnv);
        for (const parameter of parameters.namedChildren) {
          mark(parameter, childEnv);
          const target =
            parameter.childForFieldName('name') ??
            (parameter.type === 'identifier' ? parameter : parameter.firstNamedChild);
          if (target && !['positional_separator', 'keyword_separator'].includes(parameter.type))
            bind(childEnv, target, 'binding', true);
          const defaultValue = parameter.childForFieldName('value');
          if (defaultValue) visit(defaultValue, env, conditional);
        }
      }
      const body = node.childForFieldName('body');
      for (const child of node.namedChildren) {
        if (child.id === parameters?.id || child.id === node.childForFieldName('name')?.id)
          continue;
        visit(
          child,
          child.id === body?.id ? childEnv : env,
          child.id === body?.id ? false : conditional,
        );
      }
      return;
    }
    if (COMPREHENSIONS.has(node.type)) {
      const childEnv = create(node, 'Expression', env);
      const firstFor = node.namedChildren.find((child) => child.type === 'for_in_clause');
      const firstIterable = firstFor?.childForFieldName('right');
      for (const child of node.namedChildren) {
        if (child.type === 'for_in_clause') {
          mark(child, childEnv);
          bind(childEnv, child.childForFieldName('left'), 'binding', true);
          for (const part of child.namedChildren)
            visit(part, part.id === firstIterable?.id ? env : childEnv, conditional);
        } else visit(child, childEnv, conditional);
      }
      return;
    }
    if (node.type === 'global_statement' || node.type === 'nonlocal_statement') {
      for (const child of node.namedChildren) {
        if (env.kind !== 'Module' && child.type === 'identifier')
          env.directives.set(
            child.text,
            node.type === 'global_statement' ? 'module' : 'enclosing-function',
          );
      }
      return;
    }
    if (node.type === 'import_statement' || node.type === 'import_from_statement') {
      for (const match of splitImportStatement(node)) {
        const imp = interpretPythonImport(match);
        if (imp && 'localName' in imp && imp.localName !== '') {
          events.push({
            env,
            node,
            name: imp.localName,
            kind: 'import',
            conditional,
            identity: JSON.stringify([
              imp.kind,
              imp.targetRaw,
              'importedName' in imp ? imp.importedName : '',
              'explicitAlias' in imp && imp.explicitAlias,
            ]),
            ...(imp.kind === 'namespace' && !imp.explicitAlias
              ? { packageRoot: imp.localName }
              : {}),
          });
        }
      }
      return;
    }
    if (node.type === 'assignment' || node.type === 'augmented_assignment') {
      const first = events.length;
      bind(env, node.childForFieldName('left'), 'binding', false, conditional, node);
      if (annotationOnly(node))
        for (let i = first; i < events.length; i++) events[i]!.annotationOnly = true;
    }
    if (node.type === 'for_statement') bind(env, node.childForFieldName('left'));
    if (node.type === 'delete_statement') {
      const first = events.length;
      for (const child of node.namedChildren) bind(env, child, 'blocked');
      for (let i = first; i < events.length; i++) events[i]!.deletion = true;
    }
    if (node.type === 'named_expression') {
      let owner = env;
      while (COMPREHENSIONS.has(owner.node.type) && owner.parent) owner = owner.parent;
      bind(owner, node.childForFieldName('name'));
    }
    if (node.type === 'as_pattern' && node.childForFieldName('alias'))
      bind(env, node.childForFieldName('alias'));
    if (node.type === 'case_clause')
      for (const child of node.namedChildren)
        if (child.type === 'case_pattern') pattern(env, child);
    if (node.type === 'type_alias_statement') {
      const first = node.firstNamedChild;
      let target = first?.firstNamedChild;
      if (target?.type === 'generic_type') target = target.firstNamedChild;
      if (target?.type === 'identifier') bind(env, target, 'blocked');
    }
    const childConditional = conditional || CONDITIONAL.has(node.type);
    for (const child of node.namedChildren) visit(child, env, childConditional);
  };
  const module = create(root, 'Module');
  for (const child of root.namedChildren) visit(child, module);

  const localNames = new Map<Environment, Set<string>>();
  const storedNames = new Map<Environment, Set<string>>();
  const definiteDeclarations = new Set<NameClaim>();
  for (const event of events) {
    const names = localNames.get(event.env) ?? new Set<string>();
    names.add(event.name);
    localNames.set(event.env, names);
    if (!event.annotationOnly) {
      const stores = storedNames.get(event.env) ?? new Set<string>();
      stores.add(event.name);
      storedNames.set(event.env, stores);
    }
  }
  const ownerFor = (env: Environment, name: string): Environment => {
    const redirect = env.directives.get(name);
    if (redirect === 'module') return module;
    if (redirect === 'enclosing-function') {
      for (let parent = env.parent; parent; parent = parent.parent) {
        if (
          parent.kind === 'Function' &&
          !parent.directives.has(name) &&
          localNames.get(parent)?.has(name)
        )
          return parent;
      }
    }
    return env;
  };
  for (const env of environments) {
    for (const [name, redirect] of env.directives)
      env.claims.push({
        name,
        kind: 'blocked',
        hoisted: true,
        range: mapRange(range(env.node)),
        redirect,
      });
  }
  for (const event of events) {
    // An annotation records a compiler local, but never overwrites a value.
    // Keep existing imports/declarations when that name has a runtime store.
    if (event.annotationOnly && storedNames.get(event.env)?.has(event.name)) continue;
    const owner = ownerFor(event.env, event.name);
    const eventRange = mapRange(range(event.node));
    const claim: NameClaim = {
      name: event.name,
      kind:
        (event.annotationOnly && owner.kind === 'Class') ||
        (event.conditional && event.kind === 'import')
          ? 'blocked'
          : event.kind,
      range: eventRange,
      ...(event.hoisted || event.annotationOnly
        ? { hoisted: true }
        : { availableFrom: { startLine: eventRange.endLine, startCol: eventRange.endCol } }),
      inactive: owner.kind === 'Class' ? 'module' : 'blocked',
      ...((event.deletion || event.annotationOnly) && owner.kind === 'Class'
        ? { redirect: 'module' }
        : {}),
    };
    const redirected = owner !== event.env;
    if (redirected)
      event.env.claims.push({ ...claim, redirect: event.env.directives.get(event.name) });
    const ownerClaim: NameClaim =
      redirected && !event.declaration ? { ...claim, kind: 'blocked' } : claim;
    owner.claims.push(ownerClaim);
    if (event.declaration && !event.conditional) definiteDeclarations.add(ownerClaim);
    if (event.identity) {
      const imports = owner.imports.get(event.name) ?? [];
      imports.push({ identity: event.identity, packageRoot: event.packageRoot, claim: ownerClaim });
      owner.imports.set(event.name, imports);
    }
  }
  for (const env of environments) {
    for (const [name, imports] of env.imports) {
      const first = imports[0]!;
      const compatible = imports.every(
        (imp) =>
          imp.identity === first.identity ||
          (first.packageRoot !== undefined && imp.packageRoot === first.packageRoot),
      );
      const mixed = env.claims.some(
        (claim) =>
          claim.name === name &&
          claim.redirect === undefined &&
          !imports.some((imp) => imp.claim === claim),
      );
      // Conflicting imports remain uncertain, but a definite def/class store
      // still supplies its own local target after the declaration executes.
      env.claims = env.claims.map((claim) =>
        claim.name !== name || claim.redirect !== undefined || definiteDeclarations.has(claim)
          ? claim
          : !compatible || mixed
            ? { ...claim, kind: 'blocked' }
            : { ...claim, merge: true },
      );
    }
  }
  const environmentAt = (node: SyntaxNode): Environment => {
    for (let current: SyntaxNode | null = node; current; current = current.parent) {
      const env = byNode.get(current.id);
      if (env) return env;
    }
    return module;
  };
  const policyFor = (env: Environment) => ({
    callerScopeIsAuthoritative: true,
    ...(env.kind === 'Class' ? { skipFromChildren: true } : {}),
    ...(env.kind === 'Function' || env.node.type === 'generator_expression'
      ? { deferParentActivation: true }
      : {}),
    ...(env.parent ? { parentScope: id(env.parent) } : {}),
  });
  const decorateScope = (match: CaptureMatch, env: Environment): CaptureMatch => ({
    ...match,
    '@scope.name-claims': syntheticCapture(
      '@scope.name-claims',
      env.node,
      JSON.stringify(env.claims),
    ),
    '@scope.lookup-policy': syntheticCapture(
      '@scope.lookup-policy',
      env.node,
      JSON.stringify(policyFor(env)),
    ),
  });
  const out = matches
    .filter((match) => {
      const declaration = match['@declaration.variable'];
      const node = declaration && byRange.get(key(declaration.range));
      const name = match['@declaration.name']?.text;
      // Keep standalone annotations as structural fields/type declarations.
      // They must not replace an import in the local-over-import merge: an
      // annotation with no initializer does not store a new runtime value.
      return (
        node === undefined ||
        !annotationOnly(node) ||
        name === undefined ||
        !environmentAt(node).imports.has(name)
      );
    })
    .map((match): CaptureMatch => {
      const scopeAnchor =
        match['@scope.module'] ?? match['@scope.class'] ?? match['@scope.function'];
      if (scopeAnchor) {
        // A file consisting of exactly one definition can share its range with
        // that child. Physical extent alone does not identify an environment.
        const kind = match['@scope.module']
          ? 'Module'
          : match['@scope.class']
            ? 'Class'
            : 'Function';
        const env = environmentsByRange.get(`${kind}:${key(scopeAnchor.range)}`);
        if (env) return decorateScope(match, env);
      }
      // A framework dependency is invoked for the handler, but its callable
      // is evaluated in the default expression's enclosing environment.
      // Keep the synthetic caller marker out of lexical anchor selection.
      const { '@reference.caller-function': callerFunction, ...referenceMatch } = match;
      const entries = Object.values(referenceMatch);
      const anchor = entries.reduce<Capture | undefined>(
        (best, cap) =>
          !best ||
          cap.range.endLine - cap.range.startLine > best.range.endLine - best.range.startLine ||
          (cap.range.endLine - cap.range.startLine === best.range.endLine - best.range.startLine &&
            cap.range.endCol - cap.range.startCol > best.range.endCol - best.range.startCol)
            ? cap
            : best,
        undefined,
      );
      if (!anchor) return referenceMatch;
      const node = byRange.get(key(anchor.range));
      if (!node) return referenceMatch;
      const env = environmentAt(node);
      const extra: Record<string, Capture> = {};
      if (callerFunction) {
        const caller = environmentsByRange.get(`Function:${key(callerFunction.range)}`);
        if (caller)
          extra['@reference.caller-scope'] = syntheticCapture(
            '@reference.caller-scope',
            node,
            id(caller),
          );
      }
      if (entries.some((cap) => cap.name.startsWith('@reference.')))
        extra['@reference.lookup-scope'] = syntheticCapture(
          '@reference.lookup-scope',
          node,
          id(env),
        );
      const declarationName = match['@declaration.name']?.text;
      const typeName = match['@type-binding.name']?.text;
      if (declarationName) {
        const declarationEnv = env.node.id === node.id && env.parent ? env.parent : env;
        extra['@binding.scope'] = syntheticCapture(
          '@binding.scope',
          node,
          id(ownerFor(declarationEnv, declarationName)),
        );
      } else if (
        typeName &&
        !match['@type-binding.instance-field'] &&
        !match['@type-binding.self'] &&
        !match['@type-binding.cls']
      ) {
        let owner = match['@type-binding.return'] && env.parent ? env.parent : env;
        if (node.type === 'named_expression')
          while (COMPREHENSIONS.has(owner.node.type) && owner.parent) owner = owner.parent;
        extra['@binding.scope'] = syntheticCapture(
          '@binding.scope',
          node,
          id(ownerFor(owner, typeName)),
        );
        const lookupEnv =
          (match['@type-binding.parameter'] || match['@type-binding.return']) && env.parent
            ? env.parent
            : env;
        extra['@type.lookup-scope'] = syntheticCapture('@type.lookup-scope', node, id(lookupEnv));
      }
      return { ...referenceMatch, ...extra };
    });
  for (const env of environments) {
    if (COMPREHENSIONS.has(env.node.type))
      out.push(
        decorateScope({ '@scope.expression': nodeToCapture('@scope.expression', env.node) }, env),
      );
  }
  return out;
}
