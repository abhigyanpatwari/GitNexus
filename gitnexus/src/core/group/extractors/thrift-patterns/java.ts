import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import {
  compilePatterns,
  runCompiledPatterns,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import type { ThriftDetection, ThriftLanguagePlugin } from './types.js';

const GENERATED_MEMBER_TYPES = new Set(['Iface', 'Client']);
const SERVICE_TYPE_RE = /^[A-Z][A-Za-z0-9]*(?:Service|Management)$/;

interface VariableBinding {
  name: string;
  serviceName: string;
  usesGeneratedServiceMember: boolean;
  scopeStart: number;
  scopeEnd: number;
  declarationEnd: number;
  scopeSize: number;
}

interface ServiceTypeMatch {
  serviceName: string;
  usesGeneratedServiceMember: boolean;
}

const VARIABLE_PATTERNS = compilePatterns({
  name: 'java-thrift-variables',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (field_declaration
          type: (_) @type
          declarator: (variable_declarator
            name: (identifier) @var))
      `,
    },
    {
      meta: {},
      query: `
        (local_variable_declaration
          type: (_) @type
          declarator: (variable_declarator
            name: (identifier) @var))
      `,
    },
    {
      meta: {},
      query: `
        (formal_parameter
          type: (_) @type
          name: (identifier) @var)
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const ANNOTATED_CLIENT_PATTERNS = compilePatterns({
  name: 'java-thrift-annotated-clients',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (field_declaration
          (modifiers
            (marker_annotation
              name: (_) @annotation_name))
          type: (_) @type
          declarator: (variable_declarator
            name: (identifier) @var))
      `,
    },
    {
      meta: {},
      query: `
        (field_declaration
          (modifiers
            (annotation
              name: (_) @annotation_name))
          type: (_) @type
          declarator: (variable_declarator
            name: (identifier) @var))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const CALL_PATTERNS = compilePatterns({
  name: 'java-thrift-method-calls',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (method_invocation
          object: (identifier) @receiver
          name: (identifier) @method)
      `,
    },
    {
      meta: {},
      query: `
        (method_invocation
          object: (field_access
            object: (this)
            field: (identifier) @receiver)
          name: (identifier) @method)
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const PROVIDER_PATTERNS = compilePatterns({
  name: 'java-thrift-providers',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (class_declaration
          name: (identifier) @class_name
          (super_interfaces
            (type_list
              (_) @type))
          body: (class_body) @body) @class
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

function serviceFromType(typeText: string): ServiceTypeMatch | null {
  const segments = typeText.split('.').filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  const service = segments.at(-2);
  if (last && service && GENERATED_MEMBER_TYPES.has(last)) {
    return { serviceName: service, usesGeneratedServiceMember: true };
  }
  return last && SERVICE_TYPE_RE.test(last)
    ? { serviceName: last, usesGeneratedServiceMember: false }
    : null;
}

export function serviceFromAnnotatedClient(
  typeText: string,
  annotationName: string,
): ServiceTypeMatch | null {
  // Only process annotations that look like thrift client annotations
  // Handle both simple (@ThriftClient) and qualified (@com.example.ThriftClient) names
  // Reject negating annotations like @NotThriftClient, @DisableThriftClient
  const annotationSimpleName = annotationName.split('.').at(-1) || annotationName;
  const isThriftClient = annotationSimpleName.endsWith('ThriftClient') || annotationSimpleName.endsWith('RpcClient');
  const isNegating = /^(Not|Disable|Skip|Ignore)/i.test(annotationSimpleName);
  if (!isThriftClient || isNegating) {
    return null;
  }

  // Extract service name from client interface types
  // Examples: ISimpleServiceClient → SimpleService, OrderClient → Order
  const segments = typeText.split('.').filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  if (!last) return null;

  // Pattern 1: I{Service}Client → {Service}
  // Matches ISimpleServiceClient → SimpleService, IAClient → A (single-char service)
  const iClientMatch = last.match(/^I([A-Z][A-Za-z0-9]*)Client$/);
  if (iClientMatch) {
    return { serviceName: iClientMatch[1], usesGeneratedServiceMember: true };
  }

  // Pattern 2: {Service}ServiceClient → {Service}Service
  // Matches UserServiceServiceClient → UserServiceService
  const serviceClientMatch = last.match(/^([A-Z][A-Za-z0-9]*Service)Client$/);
  if (serviceClientMatch) {
    return { serviceName: serviceClientMatch[1], usesGeneratedServiceMember: true };
  }

  // Pattern 3: {Service}Client → {Service}
  // Matches OrderClient → Order, AClient → A (single-char service)
  const clientMatch = last.match(/^([A-Z][A-Za-z0-9]*)Client$/);
  if (clientMatch) {
    return { serviceName: clientMatch[1], usesGeneratedServiceMember: true };
  }

  return null;
}

function methodNamesInClassBody(body: Parser.SyntaxNode): string[] {
  const names: string[] = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child || child.type !== 'method_declaration') continue;
    const name = child.childForFieldName('name');
    if (name?.text) names.push(name.text);
  }
  return names;
}

function nearestAncestor(node: Parser.SyntaxNode, types: Set<string>): Parser.SyntaxNode | null {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (types.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

function bindingScope(varNode: Parser.SyntaxNode): {
  scope: Parser.SyntaxNode;
  declarationEnd: number;
} | null {
  const declaration = nearestAncestor(
    varNode,
    new Set(['field_declaration', 'local_variable_declaration', 'formal_parameter']),
  );
  if (!declaration) return null;

  if (declaration.type === 'field_declaration') {
    const classBody = nearestAncestor(declaration, new Set(['class_body']));
    if (!classBody) return null;
    return { scope: classBody, declarationEnd: 0 };
  }

  if (declaration.type === 'formal_parameter') {
    const callable = nearestAncestor(
      declaration,
      new Set(['method_declaration', 'constructor_declaration']),
    );
    if (!callable) return null;
    return { scope: callable, declarationEnd: 0 };
  }

  const block = nearestAncestor(declaration, new Set(['block']));
  if (!block) return null;
  return { scope: block, declarationEnd: declaration.endIndex };
}

function resolveServiceForReceiver(
  bindings: VariableBinding[],
  receiver: string,
  callNode: Parser.SyntaxNode,
): VariableBinding | null {
  const callStart = callNode.startIndex;
  const candidates = bindings.filter(
    (binding) =>
      binding.name === receiver &&
      binding.scopeStart <= callStart &&
      callStart <= binding.scopeEnd &&
      binding.declarationEnd <= callStart,
  );
  candidates.sort((a, b) => {
    if (a.scopeSize !== b.scopeSize) return a.scopeSize - b.scopeSize;
    return b.declarationEnd - a.declarationEnd;
  });
  return candidates[0] ?? null;
}

export const JAVA_THRIFT_PLUGIN: ThriftLanguagePlugin = {
  name: 'java-thrift',
  language: Java,
  scan(tree) {
    const out: ThriftDetection[] = [];
    const bindings: VariableBinding[] = [];

    for (const match of runCompiledPatterns(VARIABLE_PATTERNS, tree)) {
      const typeNode = match.captures.type;
      const varNode = match.captures.var;
      if (!typeNode || !varNode) continue;
      const service = serviceFromType(typeNode.text);
      if (!service) continue;
      const scope = bindingScope(varNode);
      if (!scope) continue;
      bindings.push({
        name: varNode.text,
        serviceName: service.serviceName,
        usesGeneratedServiceMember: service.usesGeneratedServiceMember,
        scopeStart: scope.scope.startIndex,
        scopeEnd: scope.scope.endIndex,
        declarationEnd: scope.declarationEnd,
        scopeSize: scope.scope.endIndex - scope.scope.startIndex,
      });
    }

    // Process annotation-based thrift clients (#2629)
    for (const match of runCompiledPatterns(ANNOTATED_CLIENT_PATTERNS, tree)) {
      const annotationNode = match.captures.annotation_name;
      const typeNode = match.captures.type;
      const varNode = match.captures.var;
      if (!annotationNode || !typeNode || !varNode) continue;
      const service = serviceFromAnnotatedClient(typeNode.text, annotationNode.text);
      if (!service) continue;
      const scope = bindingScope(varNode);
      if (!scope) continue;
      bindings.push({
        name: varNode.text,
        serviceName: service.serviceName,
        usesGeneratedServiceMember: service.usesGeneratedServiceMember,
        scopeStart: scope.scope.startIndex,
        scopeEnd: scope.scope.endIndex,
        declarationEnd: scope.declarationEnd,
        scopeSize: scope.scope.endIndex - scope.scope.startIndex,
      });
    }

    for (const match of runCompiledPatterns(CALL_PATTERNS, tree)) {
      const receiver = match.captures.receiver?.text;
      const methodName = match.captures.method?.text;
      const callNode = match.captures.receiver?.parent;
      if (!receiver || !methodName) continue;
      if (!callNode) continue;
      const binding = resolveServiceForReceiver(bindings, receiver, callNode);
      if (!binding) continue;
      out.push({
        role: 'consumer',
        serviceName: binding.serviceName,
        methodName,
        symbolName: `${receiver}.${methodName}`,
        source: 'java_thrift_consumer',
        confidenceWithIdl: 0.75,
        confidenceWithoutIdl: 0.45,
        usesGeneratedServiceMember: binding.usesGeneratedServiceMember,
      });
    }

    const emittedProviders = new Set<string>();
    for (const match of runCompiledPatterns(PROVIDER_PATTERNS, tree)) {
      const typeNode = match.captures.type;
      const bodyNode = match.captures.body;
      if (!typeNode || !bodyNode) continue;
      const service = serviceFromType(typeNode.text);
      if (!service) continue;

      for (const methodName of methodNamesInClassBody(bodyNode)) {
        const key = `${service.serviceName}.${methodName}`;
        if (emittedProviders.has(key)) continue;
        emittedProviders.add(key);
        out.push({
          role: 'provider',
          serviceName: service.serviceName,
          methodName,
          symbolName: `${service.serviceName}.${methodName}`,
          source: 'java_thrift_provider',
          confidenceWithIdl: 0.8,
          confidenceWithoutIdl: 0,
        });
      }
    }

    return out;
  },
};
