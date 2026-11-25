import { compareCodeUnits } from '../compare.mjs';
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { isFunction } from '@babel/types';

const twoPathFsCalls = new Set([
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'rename',
  'renameSync',
]);
const fsCalls = new Set([
  'readFile',
  'readFileSync',
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  ...twoPathFsCalls,
  'createReadStream',
  'createWriteStream',
]);
const projectReaders = new Set([
  'runPipelineFromRepo',
  'runFullAnalysis',
  'useFixture',
  'writeFixtureRepo',
]);
const compilerProjectPath =
  /(?:^|\/)(?:compiler-conformance\/java-[^/]+|java-resolution\/[^/]+)(?:\/|$)/;
const javaFixturePath = /(?:^|\/)fixtures(?:\/[^/]+)*\/java(?:-[^/]+)?(?:\/|$)/;
function isFixturePath(path) {
  return compilerProjectPath.test(path) || javaFixturePath.test(path);
}
const fsModule = /^(?:node:)?fs(?:\/promises)?$/;
const pathModule = /^(?:node:)?path(?:\/posix|\/win32)?$/;

function children(node) {
  return Object.values(node)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((child) => child && typeof child === 'object' && typeof child.type === 'string');
}

function nameOf(node) {
  return node?.name ?? node?.value;
}

function literalIdentifier(node, bindings, seen) {
  if (seen.has(node.name)) return '*';
  const binding = bindingFor(bindings, node);
  if (binding?.path)
    return literal(binding.path.node, binding.path.scope, new Set([...seen, node.name]));
  const name = binding ? nameOf(binding.imported) : node.name;
  return name === 'FIXTURES' ? 'fixtures' : '*';
}

function literal(node, bindings, seen = new Set()) {
  if (!node) return '';
  switch (node.type) {
    case 'StringLiteral':
      return node.value;
    case 'TemplateLiteral':
      return node.quasis
        .map(
          (q, i) =>
            q.value.cooked +
            (i < node.expressions.length
              ? literal(node.expressions[i], bindings, seen) || '*'
              : ''),
        )
        .join('');
    case 'Identifier':
      return literalIdentifier(node, bindings, seen);
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      return literal(node.expression, bindings, seen);
    case 'BinaryExpression':
      return node.operator === '+'
        ? literal(node.left, bindings, seen) + literal(node.right, bindings, seen)
        : '';
    case 'NewExpression':
      return nameOf(node.callee) === 'URL' ? literal(node.arguments[0], bindings, seen) : '';
    case 'CallExpression': {
      const method =
        nameOf(node.callee.property) ?? nameOf(bindingFor(bindings, node.callee)?.imported);
      if (['join', 'resolve'].includes(method))
        return node.arguments.map((n) => literal(n, bindings, seen)).join('/');
      if (method === 'fileURLToPath' || node.callee.name === 'fileURLToPath')
        return literal(node.arguments[0], bindings, seen);
      return '';
    }
    default:
      return '';
  }
}

function javaSourceMap(node, bindings, seen = new Set()) {
  if (!node) return '';
  if (node.type === 'Identifier' && !seen.has(node.name)) {
    const init = bindingFor(bindings, node)?.path;
    return init ? javaSourceMap(init.node, init.scope, new Set([...seen, node.name])) : '';
  }
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression')
    return javaSourceMap(node.expression, bindings, seen);
  if (node.type !== 'ObjectExpression') return '';
  for (const property of node.properties) {
    const match = javaSourceProperty(property, bindings, seen);
    if (match) return match;
  }
  return '';
}

function javaSourceProperty(property, bindings, seen) {
  if (property.type === 'SpreadElement') return javaSourceMap(property.argument, bindings, seen);
  const key = property.computed ? literal(property.key, bindings) : nameOf(property.key);
  return typeof key === 'string' && key.endsWith('.java') ? key : '';
}

function requiredModule(node, scope) {
  if (
    node?.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'require' &&
    !scope.getBinding('require') &&
    node.arguments.length === 1 &&
    node.arguments[0].type === 'StringLiteral'
  )
    return { module: node.arguments[0].value };
  if (node?.type !== 'MemberExpression') return undefined;
  const owner = requiredModule(node.object, scope);
  if (!owner || owner.imported) return undefined;
  const imported = node.property;
  if (node.computed && imported.type !== 'StringLiteral') return undefined;
  return nameOf(imported) === 'promises' && /^(?:node:)?fs$/.test(owner.module)
    ? { module: owner.module + '/promises' }
    : { module: owner.module, imported };
}

function directAssignmentValue(write, read) {
  if (
    !write.isAssignmentExpression({ operator: '=' }) ||
    !write.get('left').isIdentifier({ name: read.node.name })
  )
    return undefined;
  const statement = write.parentPath;
  const block = statement.parentPath;
  return statement.isExpressionStatement() &&
    (block.isBlockStatement() || block.isProgram()) &&
    block.isAncestor(read)
    ? write.get('right')
    : undefined;
}

// A write after a read can reach that read on the next loop iteration.
function mayReadPreviousIteration(read, latest, writes) {
  for (const loop of read.getAncestry().filter((path) => path.isLoop())) {
    if (latest && loop.isAncestor(latest)) continue;
    if (writes.some((write) => loop.isAncestor(write))) return true;
  }
  return false;
}

// A mutable binding has a known value after a direct assignment in a block
// enclosing the read. Writes behind a branch or in another function can make
// the value uncertain. Never substitute the initializer for an uncertain read.
function valueAtReference(binding, node) {
  const initial = binding.path.get('init');
  if (binding.constant) return initial;
  const read = binding.referencePaths.find((ref) => ref.node === node);
  if (!read) return undefined;
  const fn = read.getFunctionParent()?.node;
  if (fn !== binding.path.getFunctionParent()?.node) return undefined;
  let latest;
  for (const write of binding.constantViolations) {
    if (write.getFunctionParent()?.node !== fn) return undefined;
    if (write.node.end <= node.start && write.node.end > (latest?.node.end ?? -1)) latest = write;
  }
  if (mayReadPreviousIteration(read, latest, binding.constantViolations)) return undefined;
  return latest ? directAssignmentValue(latest, read) : initial;
}

function bindingFor(scope, identifier) {
  const name = identifier?.name;
  const binding = name && scope.getBinding(name);
  if (!binding) return undefined;
  const declaration = binding.path;
  if (declaration.parentPath.isImportDeclaration())
    return { module: declaration.parent.source.value, imported: declaration.node.imported };
  if (declaration.isFunctionDeclaration()) return { path: declaration };
  if (!declaration.isVariableDeclarator()) return {};
  const { id, init } = declaration.node;
  const value = valueAtReference(binding, identifier);
  if (!value?.node) return {};
  const required = requiredModule(value.node, value.scope);
  if (value.node !== init || id.type === 'Identifier') return required ?? { path: value };
  if (id.type !== 'ObjectPattern') return {};
  const imported = id.properties.find((property) => nameOf(property.value) === name)?.key;
  if (!imported) return {};
  if (required && !required.imported) return { module: required.module, imported };
  if (nameOf(init?.callee) === 'createRenameFixtureHelpers')
    return { writesFixture: ['fixture', 'expectRename'].includes(nameOf(imported)) };
  return {};
}

// Follow local fixture writers only when their implementation reaches real I/O.
function writesFiles(binding, mocked, seen = new Set()) {
  if (binding?.writesFixture) return true;
  const definition = binding?.path;
  if (!definition?.isFunction() || seen.has(definition.node)) return false;
  seen.add(definition.node);
  let writes = false;
  definition.traverse({
    CallExpression(call) {
      const {
        binding: resolved,
        method,
        actualFs,
        identifier,
      } = fixtureCall(call.node, call.scope, mocked);
      if (
        (actualFs && fsCalls.has(method)) ||
        (projectReaders.has(method) && (!resolved || resolved.module)) ||
        (identifier && writesFiles(resolved, mocked, seen))
      ) {
        writes = true;
        call.stop();
      }
    },
  });
  return writes;
}

function virtualJavaSource(node, bindings) {
  if (node.type !== 'ObjectProperty') return undefined;
  const key = node.computed ? literal(node.key, bindings) : nameOf(node.key);
  const value = node.value;
  const languageRow =
    key === 'java' &&
    value.type === 'ArrayExpression' &&
    literal(value.elements[0], bindings) === 'java';
  if (!languageRow && !(typeof key === 'string' && key.endsWith('.java'))) return undefined;
  const source = literal(languageRow ? value.elements[1] : value, bindings);
  return /\b(?:class|interface|enum|record)\s+[\p{L}$_]|\b(?:package|import)\s+[\w.$]+\s*;/u.test(
    source,
  )
    ? key
    : undefined;
}

function stubExports(node) {
  if (node?.type === 'CallExpression')
    return (
      nameOf(node.callee.object) === 'vi' &&
      nameOf(node.callee.property) === 'fn' &&
      node.arguments.length === 0
    );
  return (
    node?.type === 'ObjectExpression' &&
    node.properties.every(
      (property) => property.type === 'ObjectProperty' && stubExports(property.value),
    )
  );
}

function completeFsMock(factory) {
  if (!factory) return true;
  if (!isFunction(factory)) return false;
  const body = factory.body;
  if (body.type !== 'BlockStatement') return stubExports(body);
  return (
    body.body.length === 1 &&
    body.body[0].type === 'ReturnStatement' &&
    stubExports(body.body[0].argument)
  );
}

function callableBinding(scope, identifier) {
  let binding = bindingFor(scope, identifier);
  const seen = new Set();
  while (binding?.path?.isIdentifier() && !seen.has(binding.path.node)) {
    const alias = binding.path;
    seen.add(alias.node);
    identifier = alias.node;
    binding = bindingFor(alias.scope, identifier);
  }
  return { name: identifier?.name, binding };
}

function fixtureCall(node, bindings, mocked) {
  const callee = node.callee;
  const identifier = callee.type === 'Identifier';
  let owner = callee.object;
  if (nameOf(owner?.property) === 'promises') owner = owner.object;
  const target = callableBinding(bindings, identifier ? callee : owner);
  const binding = target.binding ?? requiredModule(owner, bindings);
  const method = identifier ? (nameOf(binding?.imported) ?? target.name) : nameOf(callee.property);
  const actualFs =
    fsModule.test(binding?.module ?? '') && !mocked.has(binding.module.replace(/^node:/, ''));
  const isProject = projectReaders.has(method) && identifier && (!binding || binding.module);
  const explicitProjectPath =
    (node.type === 'NewExpression' && method === 'URL') ||
    (pathModule.test(binding?.module ?? '') && ['join', 'resolve'].includes(method));
  return { binding, method, identifier, actualFs, isProject, explicitProjectPath };
}

function fixtureArgument(node, bindings, { method, actualFs, isProject, explicitProjectPath }) {
  if ((actualFs && fsCalls.has(method)) || isProject || explicitProjectPath) {
    const count = twoPathFsCalls.has(method) ? 2 : 1;
    const paths = explicitProjectPath ? [node] : node.arguments.slice(0, count);
    for (const arg of paths) {
      const candidate = literal(arg, bindings).replaceAll('\\', '/');
      if (isFixturePath(candidate) || (actualFs && candidate.endsWith('.java'))) return candidate;
    }
  }
  if (isProject && (method === 'useFixture' || method === 'writeFixtureRepo'))
    return javaSourceMap(node.arguments[1], bindings);
  return '';
}

function writtenFixture(node, bindings, { identifier, binding }, mocked) {
  if (!identifier || !binding) return '';
  for (const arg of node.arguments) {
    const candidate = javaSourceMap(arg, bindings) || literal(arg, bindings);
    if ((candidate.endsWith('.java') || isFixturePath(candidate)) && writesFiles(binding, mocked))
      return candidate;
  }
  return '';
}

/** Detect Java file fixtures and virtual source maps. Vitest setup also observes the parser. */
export function javaFixtureUses(source, filename = 'suite.test.ts') {
  if (!/java|FIXTURES/i.test(source)) return [];
  const tree = parse(source, {
    sourceType: 'unambiguous',
    plugins: ['typescript', ...(filename.endsWith('x') ? ['jsx'] : [])],
  });
  const findings = [];
  const inlineSources = [];
  const mocked = new Set();
  function findMocks(node) {
    if (
      node.type === 'CallExpression' &&
      nameOf(node.callee.object) === 'vi' &&
      nameOf(node.callee.property) === 'mock'
    ) {
      const spec = node.arguments[0]?.value;
      if (typeof spec === 'string' && fsModule.test(spec) && completeFsMock(node.arguments[1]))
        mocked.add(spec.replace(/^node:/, ''));
    }
    for (const child of children(node)) findMocks(child);
  }
  findMocks(tree.program);
  function visit({ node, scope: bindings }) {
    const virtual = virtualJavaSource(node, bindings);
    if (virtual)
      inlineSources.push({
        line: node.loc.start.line,
        method: 'inline Java source',
        path: virtual,
      });
    if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return;
    const call = fixtureCall(node, bindings, mocked);
    const match =
      fixtureArgument(node, bindings, call) || writtenFixture(node, bindings, call, mocked);
    if (match) findings.push({ line: node.loc.start.line, method: call.method, path: match });
  }
  traverse(tree, { 'ObjectProperty|CallExpression|NewExpression': visit });
  const reportedPaths = new Set(findings.map((issue) => issue.path));
  return [...findings, ...inlineSources.filter((issue) => !reportedPaths.has(issue.path))];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../../../test/', import.meta.url));
  const findings = [];
  for (const file of globSync('**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs,cts,cjs}', { cwd: root })) {
    for (const issue of javaFixtureUses(readFileSync(path.join(root, file), 'utf8'), file))
      findings.push(file + ':' + issue.line + ' ' + issue.method + ' ' + issue.path);
  }
  if (findings.length) {
    console.error(
      'Run Java source fixtures in compiler conformance:\n' +
        findings.toSorted(compareCodeUnits).join('\n'),
    );
    process.exitCode = 1;
  } else console.log('Java fixture ownership passed');
}
