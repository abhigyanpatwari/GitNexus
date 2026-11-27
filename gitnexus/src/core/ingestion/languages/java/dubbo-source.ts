import Parser from 'tree-sitter';

type Node = Parser.SyntaxNode;

export interface JavaMethod {
  name: string;
  /** Zero-based source coordinate, matching persisted graph symbols. */
  line: number;
  parameters: string[];
}

export interface DubboServiceKey {
  service: string;
  group: string;
  version: string;
}

export interface DubboSite extends DubboServiceKey {
  filePath: string;
  name: string;
  line: number;
  /** Empty for a service/type anchor. */
  method: string;
  parameters: string[];
  role: 'provider' | 'consumer';
}

export interface JavaFile {
  filePath: string;
  packageName: string;
  imports: Map<string, string>;
  wildcards: string[];
  types: JavaType[];
}

interface Reference extends DubboServiceKey {
  field: string;
  fieldType: string;
}

interface UnsupportedMethod {
  name: string;
  /** Minimum argument count; exact unless variadic. */
  arity: number;
  variadic: boolean;
}

export interface JavaType {
  name: string;
  line: number;
  isInterface: boolean;
  supers: string[];
  methods: JavaMethod[];
  unsupportedMethods: UnsupportedMethod[];
  provider?: DubboServiceKey;
  references: Reference[];
  calls: { field: string; method: string; arity: number; caller: string; line: number }[];
}

const ANNOTATIONS = new Map([
  ['org.apache.dubbo.config.annotation.DubboReference', 'consumer'],
  ['org.apache.dubbo.config.annotation.Reference', 'consumer'],
  ['com.alibaba.dubbo.config.annotation.Reference', 'consumer'],
  ['org.apache.dubbo.config.annotation.DubboService', 'provider'],
  ['org.apache.dubbo.config.annotation.Service', 'provider'],
  ['com.alibaba.dubbo.config.annotation.Service', 'provider'],
]);
const JAVA_LANG = new Set([
  'String',
  'Object',
  'Boolean',
  'Byte',
  'Character',
  'Short',
  'Integer',
  'Long',
  'Float',
  'Double',
  'Void',
  'Number',
  'CharSequence',
  'Throwable',
  'Exception',
]);
const PRIMITIVE = /^(?:boolean|byte|char|short|int|long|float|double|void)$/;

/** Iterative traversal, stopping at nested types (which have a different field scope). */
function descendants(root: Node): Node[] {
  const out: Node[] = [];
  const stack = [...root.namedChildren].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (!node) break;
    if (['class_declaration', 'interface_declaration', 'class_body'].includes(node.type)) continue;
    out.push(node);
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  return out;
}

function field(node: Node, name: string): string {
  return node.childForFieldName(name)?.text ?? '';
}

/** Index lexical bindings once per method, retaining where each binding starts. */
function referenceBindings(member: Node, nodes: Node[]): Map<number, Map<string, number>> {
  const scopes = new Map<number, Map<string, number>>();
  const bind = (scope: Node | null, name: string, start: number) => {
    if (!scope || !name) return;
    const names = scopes.get(scope.id) ?? new Map<string, number>();
    names.set(name, Math.min(names.get(name) ?? start, start));
    scopes.set(scope.id, names);
  };
  const parameters = (params: Node | null, scope: Node | null) => {
    if (!params || !scope) return;
    const entries = params.type === 'identifier' ? [params] : params.namedChildren;
    for (const param of entries) {
      const name =
        param.type === 'identifier'
          ? param.text
          : field(param, 'name') ||
            field(
              param.namedChildren.find((n) => n.type === 'variable_declarator') ?? param,
              'name',
            );
      bind(scope, name, scope.startIndex);
    }
  };
  parameters(member.childForFieldName('parameters'), member);
  for (const node of nodes) {
    if (node.type === 'local_variable_declaration') {
      const parent = node.parent;
      const scope = parent?.type === 'switch_block_statement_group' ? parent.parent : parent;
      if (!scope || !['block', 'for_statement', 'switch_block'].includes(scope.type)) continue;
      for (const decl of node.namedChildren.filter((n) => n.type === 'variable_declarator'))
        bind(scope, field(decl, 'name'), decl.startIndex);
    } else if (node.type === 'lambda_expression') {
      parameters(node.childForFieldName('parameters'), node.childForFieldName('body'));
    } else if (node.type === 'catch_clause') {
      const param = node.namedChildren.find((n) => n.type === 'catch_formal_parameter');
      const body = node.childForFieldName('body');
      if (param && body) bind(body, field(param, 'name'), body.startIndex);
    } else if (node.type === 'enhanced_for_statement') {
      const body = node.childForFieldName('body');
      if (body) bind(body, field(node, 'name'), body.startIndex);
    } else if (node.type === 'resource_specification') {
      const body = node.parent?.childForFieldName('body');
      for (const resource of node.namedChildren) {
        bind(node, field(resource, 'name'), resource.startIndex);
        if (body) bind(body, field(resource, 'name'), body.startIndex);
      }
    }
  }
  return scopes;
}

function referenceIsShadowed(
  call: Node,
  name: string,
  scopes: Map<number, Map<string, number>>,
): boolean {
  for (let scope: Node | null = call; scope; scope = scope.parent) {
    const start = scopes.get(scope.id)?.get(name);
    if (start !== undefined && start <= call.startIndex) return true;
  }
  return false;
}

function literal(node: Node | undefined): string | null {
  if (!node || node.type !== 'string_literal') return null;
  try {
    const value: unknown = JSON.parse(node.text);
    return typeof value === 'string' && !/\$\{|\*/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function annotation(node: Node, file: JavaFile, role: string): Map<string, Node> | null {
  const modifiers = node.namedChildren.find((n) => n.type === 'modifiers');
  for (const ann of modifiers?.namedChildren ?? []) {
    if (ann.type !== 'annotation' && ann.type !== 'marker_annotation') continue;
    const name = field(ann, 'name');
    // Require a real import or FQN; @Service alone could be Spring's annotation.
    const resolved = name.includes('.') ? name : file.imports.get(name);
    const candidates = resolved ? [resolved] : file.wildcards.map((p) => `${p}.${name}`);
    if (candidates.length !== 1 || ANNOTATIONS.get(candidates[0]) !== role) continue;
    return new Map(
      (ann.childForFieldName('arguments')?.namedChildren ?? [])
        .filter((arg) => arg.type === 'element_value_pair')
        .flatMap((arg): [string, Node][] => {
          const value = arg.childForFieldName('value');
          return value ? [[field(arg, 'key'), value]] : [];
        }),
    );
  }
  return null;
}

function serviceKey(args: Map<string, Node>, fallback: string): DubboServiceKey | null {
  if (args.has('export') && args.get('export')?.text !== 'true') return null;
  if (args.has('generic') && args.get('generic')?.text !== 'false') return null;
  if (args.has('scope') && literal(args.get('scope')) !== 'remote') return null;
  const group = args.has('group') ? literal(args.get('group')) : '';
  const version = args.has('version') ? literal(args.get('version')) : '';
  if (group === null || version === null) return null;
  let service = fallback;
  if (args.has('interfaceClass')) {
    const value = args.get('interfaceClass');
    if (!value || value.type !== 'class_literal') return null;
    service = value.text.replace(/\.class$/, '');
  } else if (args.has('interfaceName')) {
    const value = literal(args.get('interfaceName'));
    if (!value) return null;
    service = value;
  }
  return service && service !== 'void' ? { service, group, version } : null;
}

/** Copy only plain facts out of the tree; the group catalog never retains native nodes. */
export function scanDubboJava(filePath: string, root: Node): JavaFile {
  const file: JavaFile = {
    filePath,
    packageName: '',
    imports: new Map(),
    wildcards: [],
    types: [],
  };
  for (const node of root.namedChildren) {
    if (node.type === 'package_declaration') file.packageName = node.namedChildren[0]?.text ?? '';
    if (node.type !== 'import_declaration' || /\bstatic\b/.test(node.text)) continue;
    const name = node.namedChildren.find((n) => n.type !== 'asterisk')?.text ?? '';
    if (node.namedChildren.some((n) => n.type === 'asterisk')) file.wildcards.push(name);
    else if (name) file.imports.set(name.split('.').at(-1) ?? name, name);
  }
  for (const node of root.namedChildren) {
    if (node.type !== 'class_declaration' && node.type !== 'interface_declaration') continue;
    // A type parameter can shadow a concrete name (including java.lang.String).
    // Generic service types require substitution and are outside this extractor.
    if (node.childForFieldName('type_parameters')) continue;
    const body = node.childForFieldName('body');
    if (!body) continue;
    const name = field(node, 'name');
    const supers =
      node.childForFieldName('interfaces')?.namedChildren[0]?.namedChildren.map((n) => n.text) ??
      node.namedChildren
        .find((n) => n.type === 'extends_interfaces')
        ?.namedChildren.map((n) => n.text) ??
      [];
    const type: JavaType = {
      name,
      line: node.startPosition.row,
      isInterface: node.type === 'interface_declaration',
      supers,
      methods: [],
      unsupportedMethods: [],
      references: [],
      calls: [],
    };
    const provider = annotation(node, file, 'provider');
    if (provider)
      type.provider = serviceKey(provider, supers.length === 1 ? supers[0] : '') ?? undefined;
    for (const member of body.namedChildren) {
      if (member.type === 'field_declaration') {
        const args = annotation(member, file, 'consumer');
        if (!args) continue;
        const key = serviceKey(args, field(member, 'type'));
        if (!key) continue;
        for (const decl of member.namedChildren.filter((n) => n.type === 'variable_declarator')) {
          type.references.push({
            ...key,
            field: field(decl, 'name'),
            fieldType: field(member, 'type'),
          });
        }
      }
      if (member.type !== 'method_declaration') continue;
      const modifiers = member.namedChildren.find((n) => n.type === 'modifiers');
      if (/\b(?:static|private|protected)\b/.test(modifiers?.text ?? '')) continue;
      const params = (member.childForFieldName('parameters')?.namedChildren ?? []).filter(
        (n) => n.type !== 'receiver_parameter',
      );
      // Varargs and generic methods need invocation/type inference; do not guess.
      if (
        member.childForFieldName('type_parameters') ||
        params.some((n) => n.type !== 'formal_parameter')
      ) {
        const variadic = params.some((n) => n.type === 'spread_parameter');
        type.unsupportedMethods.push({
          name: field(member, 'name'),
          arity: params.length - (variadic ? 1 : 0),
          variadic,
        });
        continue;
      }
      type.methods.push({
        name: field(member, 'name'),
        line: member.startPosition.row,
        parameters: params.map(
          (n) => field(n, 'type') + (n.childForFieldName('dimensions')?.text ?? ''),
        ),
      });
    }
    // Calls in private helpers are still consumers; the provider visibility filter above does not apply.
    for (const member of body.namedChildren.filter((n) => n.type === 'method_declaration')) {
      const nodes = descendants(member);
      const bindings = referenceBindings(member, nodes);
      for (const call of nodes.filter((n) => n.type === 'method_invocation')) {
        const object = call.childForFieldName('object');
        const explicit = object?.type === 'field_access' && field(object, 'object') === 'this';
        const receiver =
          explicit && object
            ? field(object, 'field')
            : object?.type === 'identifier'
              ? object.text
              : '';
        if (!receiver || (!explicit && referenceIsShadowed(call, receiver, bindings))) continue;
        type.calls.push({
          field: receiver,
          method: field(call, 'name'),
          arity: call.childForFieldName('arguments')?.namedChildCount ?? 0,
          caller: field(member, 'name'),
          line: member.startPosition.row,
        });
      }
    }
    // A reassigned proxy is no longer proven to refer to the annotated remote service.
    const assigned = new Set(
      descendants(body)
        .filter((n) => n.type === 'assignment_expression')
        .map((n) => field(n, 'left').replace(/^this\./, '')),
    );
    type.references = type.references.filter((r) => !assigned.has(r.field));
    file.types.push(type);
  }
  return file;
}

/** Erased Java parameter identity, retaining package, case and array rank. */
export function resolveJavaType(
  raw: string,
  file: JavaFile,
  knownTypes: Set<string>,
): string | null {
  const erased = raw.replace(/<.*>/g, '').replace(/\s/g, '');
  const base = erased.replace(/(?:\[\])+$/, '');
  const suffix = erased.slice(base.length);
  if (!base || !/^[\w.$]+$/.test(base)) return null;
  if (PRIMITIVE.test(base) || base.includes('.')) return base + suffix;
  const imported = file.imports.get(base);
  if (imported) return imported + suffix;
  const local = file.packageName ? `${file.packageName}.${base}` : base;
  if (knownTypes.has(local)) return local + suffix;
  if (JAVA_LANG.has(base)) return `java.lang.${base}${suffix}`;
  const candidates = file.wildcards.map((p) => `${p}.${base}`).filter((n) => knownTypes.has(n));
  if (candidates.length === 1) return candidates[0] + suffix;
  // Unknown wildcard imports/type variables are not evidence for a concrete type.
  return null;
}

export function dubboContractId(
  key: DubboServiceKey,
  method = '',
  parameters: string[] = [],
): string {
  // JSON tuple preserves case and avoids collisions between names, groups and versions.
  return `dubbo::${JSON.stringify([key.service, key.group, key.version, method, parameters])}`;
}

export function buildDubboSites(files: JavaFile[]): Map<JavaFile, DubboSite[]> {
  const known = new Set(
    files.flatMap((f) =>
      f.types.map((t) => (f.packageName ? `${f.packageName}.${t.name}` : t.name)),
    ),
  );
  const interfaces = new Map<
    string,
    { file: JavaFile; type: JavaType; methods: JavaMethod[]; unsupported: UnsupportedMethod[] }[]
  >();
  const output = new Map(files.map((f) => [f, [] as DubboSite[]]));
  for (const file of files)
    for (const type of file.types) {
      if (!type.isInterface || type.supers.length) continue;
      const service = file.packageName ? `${file.packageName}.${type.name}` : type.name;
      const unsupported = [...type.unsupportedMethods];
      const methods = type.methods.flatMap((m) => {
        const params = m.parameters.map((p) => resolveJavaType(p, file, known));
        if (params.some((p) => p === null)) {
          unsupported.push({ name: m.name, arity: m.parameters.length, variadic: false });
          return [];
        }
        return [{ ...m, parameters: params as string[] }];
      });
      const entries = interfaces.get(service) ?? [];
      entries.push({ file, type, methods, unsupported });
      interfaces.set(service, entries);
    }
  const used = new Map<string, DubboServiceKey>();
  for (const file of files)
    for (const type of file.types) {
      const add = (
        key: DubboServiceKey,
        method: JavaMethod | null,
        role: 'provider' | 'consumer',
        name: string,
        line: number,
      ) => {
        output.get(file)?.push({
          ...key,
          filePath: file.filePath,
          role,
          name,
          line,
          method: method?.name ?? '',
          parameters: method?.parameters ?? [],
        });
        used.set(dubboContractId(key), key);
      };
      const bind = (key: DubboServiceKey) => {
        const service = resolveJavaType(key.service, file, known);
        if (!service) return null;
        const declarations = interfaces.get(service);
        // Duplicate interface definitions across members are ambiguous, even with identical simple names.
        return declarations?.length === 1
          ? { key: { ...key, service }, declaration: declarations[0] }
          : null;
      };
      if (type.provider) {
        const binding = bind(type.provider);
        if (
          binding &&
          type.supers.some((s) => resolveJavaType(s, file, known) === binding.key.service)
        ) {
          for (const method of type.methods) {
            const params = method.parameters.map((p) => resolveJavaType(p, file, known));
            if (params.some((p) => p === null)) continue;
            const declared = binding.declaration.methods.find(
              (m) =>
                m.name === method.name && JSON.stringify(m.parameters) === JSON.stringify(params),
            );
            if (declared) add(binding.key, declared, 'provider', method.name, method.line);
          }
          add(binding.key, null, 'provider', type.name, type.line);
        }
      }
      for (const reference of type.references) {
        const binding = bind(reference);
        if (!binding) continue;
        if (resolveJavaType(reference.fieldType, file, known) !== binding.key.service) continue;
        for (const call of type.calls.filter((c) => c.field === reference.field)) {
          const candidates = binding.declaration.methods.filter(
            (m) => m.name === call.method && m.parameters.length === call.arity,
          );
          const ambiguous = binding.declaration.unsupported.some(
            (m) =>
              m.name === call.method &&
              (m.variadic ? call.arity >= m.arity : call.arity === m.arity),
          );
          if (candidates.length !== 1 || ambiguous) continue;
          add(binding.key, candidates[0], 'consumer', call.caller, call.line);
          add(binding.key, null, 'consumer', call.caller, call.line);
        }
      }
    }
  // A contract-only repository participates using its actual Interface/Method UIDs.
  // Only interfaces referenced by a proven Dubbo annotation receive contracts.
  for (const key of used.values()) {
    const declaration = interfaces.get(key.service)?.[0];
    if (!declaration) continue;
    const sites = output.get(declaration.file);
    if (!sites) continue;
    for (const method of declaration.methods)
      sites.push({
        ...key,
        role: 'provider',
        filePath: declaration.file.filePath,
        name: method.name,
        line: method.line,
        method: method.name,
        parameters: method.parameters,
      });
    sites.push({
      ...key,
      role: 'provider',
      filePath: declaration.file.filePath,
      name: declaration.type.name,
      line: declaration.type.line,
      method: '',
      parameters: [],
    });
  }
  return output;
}
