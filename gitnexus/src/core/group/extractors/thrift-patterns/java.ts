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

const VARIABLE_PATTERNS = compilePatterns({
  name: 'java-thrift-variables',
  language: Java,
  patterns: [
    {
      meta: { scoped: true },
      query: `
        (field_declaration
          (scoped_type_identifier
            (type_identifier) @service
            (type_identifier) @member)
          (variable_declarator
            (identifier) @var))
      `,
    },
    {
      meta: { scoped: true },
      query: `
        (local_variable_declaration
          (scoped_type_identifier
            (type_identifier) @service
            (type_identifier) @member)
          (variable_declarator
            (identifier) @var))
      `,
    },
    {
      meta: { scoped: true },
      query: `
        (formal_parameter
          (scoped_type_identifier
            (type_identifier) @service
            (type_identifier) @member)
          (identifier) @var)
      `,
    },
    {
      meta: { scoped: false },
      query: `
        (field_declaration
          (type_identifier) @service
          (variable_declarator
            (identifier) @var))
      `,
    },
    {
      meta: { scoped: false },
      query: `
        (local_variable_declaration
          (type_identifier) @service
          (variable_declarator
            (identifier) @var))
      `,
    },
    {
      meta: { scoped: false },
      query: `
        (formal_parameter
          (type_identifier) @service
          (identifier) @var)
      `,
    },
  ],
} satisfies LanguagePatterns<{ scoped: boolean }>);

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
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const PROVIDER_PATTERNS = compilePatterns({
  name: 'java-thrift-providers',
  language: Java,
  patterns: [
    {
      meta: { scoped: true },
      query: `
        (class_declaration
          name: (identifier) @class_name
          (super_interfaces
            (type_list
              (scoped_type_identifier
                (type_identifier) @service
                (type_identifier) @member)))
          body: (class_body) @body) @class
      `,
    },
    {
      meta: { scoped: false },
      query: `
        (class_declaration
          name: (identifier) @class_name
          (super_interfaces
            (type_list
              (type_identifier) @service))
          body: (class_body) @body) @class
      `,
    },
  ],
} satisfies LanguagePatterns<{ scoped: boolean }>);

function serviceFromType(serviceText: string, memberText: string | undefined): string | null {
  if (memberText !== undefined) {
    return GENERATED_MEMBER_TYPES.has(memberText) ? serviceText : null;
  }
  return SERVICE_TYPE_RE.test(serviceText) ? serviceText : null;
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

export const JAVA_THRIFT_PLUGIN: ThriftLanguagePlugin = {
  name: 'java-thrift',
  language: Java,
  scan(tree) {
    const out: ThriftDetection[] = [];
    const variables = new Map<string, string>();

    for (const match of runCompiledPatterns(VARIABLE_PATTERNS, tree)) {
      const serviceNode = match.captures.service;
      const varNode = match.captures.var;
      if (!serviceNode || !varNode) continue;
      const memberNode = match.meta.scoped ? match.captures.member : undefined;
      const serviceName = serviceFromType(serviceNode.text, memberNode?.text);
      if (!serviceName) continue;
      variables.set(varNode.text, serviceName);
    }

    for (const match of runCompiledPatterns(CALL_PATTERNS, tree)) {
      const receiver = match.captures.receiver?.text;
      const methodName = match.captures.method?.text;
      if (!receiver || !methodName) continue;
      const serviceName = variables.get(receiver);
      if (!serviceName) continue;
      out.push({
        role: 'consumer',
        serviceName,
        methodName,
        symbolName: `${receiver}.${methodName}`,
        source: 'java_thrift_consumer',
        confidenceWithIdl: 0.75,
        confidenceWithoutIdl: 0.45,
      });
    }

    const emittedProviders = new Set<string>();
    for (const match of runCompiledPatterns(PROVIDER_PATTERNS, tree)) {
      const serviceNode = match.captures.service;
      const bodyNode = match.captures.body;
      if (!serviceNode || !bodyNode) continue;
      const memberNode = match.meta.scoped ? match.captures.member : undefined;
      const serviceName = serviceFromType(serviceNode.text, memberNode?.text);
      if (!serviceName) continue;

      for (const methodName of methodNamesInClassBody(bodyNode)) {
        const key = `${serviceName}.${methodName}`;
        if (emittedProviders.has(key)) continue;
        emittedProviders.add(key);
        out.push({
          role: 'provider',
          serviceName,
          methodName,
          symbolName: `${serviceName}.${methodName}`,
          source: 'java_thrift_provider',
          confidenceWithIdl: 0.8,
          confidenceWithoutIdl: 0,
        });
      }
    }

    return out;
  },
};
