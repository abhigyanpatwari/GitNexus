import type Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import {
  compilePatterns,
  runCompiledPatterns,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import type { GrpcDetection, GrpcLanguagePlugin } from './types.js';

/**
 * Python gRPC plugin. Detects:
 *   - Provider: `add_XxxServicer_to_server(...)` calls (bare identifier
 *     or qualified attribute form `auth_pb2_grpc.add_XxxServicer_to_server`)
 *   - Consumer: `XxxStub(channel)` calls (bare or `auth_pb2_grpc.XxxStub`)
 *     in a file that imports gRPC, unless the file defines `XxxStub`
 *     itself and the call does not go through a gRPC module. Test doubles
 *     are often named like stubs (`class _RepoStub:`). A class that extends
 *     the generated stub of its own name stands for that stub; a subclass
 *     under another name may be a test fake, and is left out.
 *
 * A stub imported from a module with no gRPC part in its name (a betterproto
 * package, or a re-export) is found only when the file also imports gRPC.
 */

const ADD_SERVICER_RE = /^add_(\w+)Servicer_to_server$/;
const STUB_RE = /^(\w+)Stub$/;
/** Reserved names that would produce garbage service names. */
const STUB_IGNORE = new Set(['Mock', 'Test', 'Fake', 'Stub']);

/**
 * A part of an imported name that shows the file uses gRPC: the `grpc` or
 * `grpclib` package, or a generated module (`auth_pb2_grpc`, or `auth_grpc`
 * from grpclib).
 */
const isGrpcModulePart = (part: string): boolean =>
  part === 'grpc' || part === 'grpclib' || part.endsWith('_grpc');

const IMPORT_PATTERNS = compilePatterns({
  name: 'python-grpc-import',
  language: Python,
  patterns: [
    { meta: {}, query: '(import_statement) @import' },
    { meta: {}, query: '(import_from_statement) @import' },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const CLASS_PATTERNS = compilePatterns({
  name: 'python-grpc-class',
  language: Python,
  patterns: [{ meta: {}, query: '(class_definition name: (identifier) @name)' }],
} satisfies LanguagePatterns<Record<string, never>>);

/** Whether a module or imported name, relative or not, has a gRPC part. */
const hasGrpcPart = (node: Parser.SyntaxNode): boolean =>
  node
    .descendantsOfType('dotted_name')
    .some((name) => name.namedChildren.some((part) => isGrpcModulePart(part.text)));

interface GrpcImports {
  /** Whether any import of the file, at top level or in a function, is a gRPC one. */
  found: boolean;
  /** Local names those imports bind: `rpc` in `import a.x_pb2_grpc as rpc`. */
  names: Set<string>;
}

function readGrpcImports(tree: Parser.Tree): GrpcImports {
  const imports: GrpcImports = { found: false, names: new Set() };
  const bind = (local: Parser.SyntaxNode | null | undefined) => {
    imports.found = true;
    if (local) imports.names.add(local.text);
  };
  for (const { captures } of runCompiledPatterns(IMPORT_PATTERNS, tree)) {
    const statement = captures.import;
    if (!statement) continue;
    const module = statement.childForFieldName('module_name');
    const fromGrpcModule = module !== null && hasGrpcPart(module);
    if (fromGrpcModule) imports.found = true;
    for (const item of statement.childrenForFieldName('name')) {
      const aliased = item.type === 'aliased_import';
      const name = aliased ? item.childForFieldName('name') : item;
      if (!name || (!fromGrpcModule && !hasGrpcPart(name))) continue;
      if (aliased) bind(item.childForFieldName('alias'));
      // `import a.x_pb2_grpc` binds `a`; `from a import x_pb2_grpc` binds `x_pb2_grpc`.
      else bind(statement.type === 'import_statement' ? name.namedChild(0) : name);
    }
  }
  return imports;
}

/** The leftmost name of `a.b` in `a.b.c`, or null when it is not a plain name. */
function leftmostName(expression: Parser.SyntaxNode): string | null {
  let node: Parser.SyntaxNode | null = expression;
  while (node?.type === 'attribute') node = node.childForFieldName('object');
  return node?.type === 'identifier' ? node.text : null;
}

/** Whether a class extends the generated stub of its own name, through a gRPC module. */
function extendsGeneratedStub(
  classNode: Parser.SyntaxNode,
  name: string,
  grpcNames: Set<string>,
): boolean {
  return (classNode.childForFieldName('superclasses')?.namedChildren ?? []).some((base) => {
    const root = leftmostName(base);
    return (
      base.type === 'attribute' &&
      base.childForFieldName('attribute')?.text === name &&
      root !== null &&
      grpcNames.has(root)
    );
  });
}

/** The classes the file defines, except those that stand for their generated stub. */
function localClasses(tree: Parser.Tree, grpcNames: Set<string>): Set<string> {
  const names = new Set<string>();
  for (const { captures } of runCompiledPatterns(CLASS_PATTERNS, tree)) {
    const name = captures.name;
    if (name?.parent && !extendsGeneratedStub(name.parent, name.text, grpcNames)) {
      names.add(name.text);
    }
  }
  return names;
}

// Any call whose target is either a bare identifier or an attribute
// access (`obj.method`). The plugin filters the function name in JS.
const CALL_PATTERNS = compilePatterns({
  name: 'python-grpc-call',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (call
          function: [
            (identifier) @fn
            (attribute attribute: (identifier) @fn)
          ])
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

export const PYTHON_GRPC_PLUGIN: GrpcLanguagePlugin = {
  name: 'python-grpc',
  language: Python,
  scan(tree) {
    const out: GrpcDetection[] = [];
    // Read only once a call is named like a stub.
    let imports: GrpcImports | undefined;
    let fileClasses: Set<string> | undefined;
    for (const match of runCompiledPatterns(CALL_PATTERNS, tree)) {
      const fnNode = match.captures.fn;
      if (!fnNode) continue;
      const fnText = fnNode.text;

      const addServicer = ADD_SERVICER_RE.exec(fnText);
      if (addServicer) {
        out.push({
          role: 'provider',
          serviceName: addServicer[1],
          symbolName: fnText,
          source: 'python_servicer',
          confidenceWithProto: 0.8,
          confidenceWithoutProto: 0.65,
        });
        continue;
      }

      const stubMatch = STUB_RE.exec(fnText);
      if (!stubMatch || STUB_IGNORE.has(stubMatch[1])) continue;
      imports ??= readGrpcImports(tree);
      if (!imports.found) continue;
      // A call through a gRPC module reaches the generated stub, whatever the file defines.
      const receiver = fnNode.parent?.type === 'attribute' ? fnNode.parent : null;
      const root = receiver ? leftmostName(receiver.childForFieldName('object') ?? receiver) : null;
      if (root === null || !imports.names.has(root)) {
        fileClasses ??= localClasses(tree, imports.names);
        if (fileClasses.has(fnText)) continue;
      }
      out.push({
        role: 'consumer',
        serviceName: stubMatch[1],
        symbolName: fnText,
        source: 'python_stub',
        confidenceWithProto: 0.75,
        confidenceWithoutProto: 0.55,
      });
    }
    return out;
  },
};
