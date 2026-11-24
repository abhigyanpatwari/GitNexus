import { compareCodeUnits } from '../compare.mjs';
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

const fsCalls = new Set([
  'readFile',
  'readFileSync',
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'createReadStream',
  'createWriteStream',
]);
const projectReaders = new Set([
  'runPipelineFromRepo',
  'runFullAnalysis',
  'useFixture',
  'writeFixtureRepo',
]);
const fixturePath =
  /(?:^|\/)(?:compiler-conformance\/java-[^/]+|java-resolution\/[^/]+|fixtures(?:\/[^/]+)*\/(?:java|java-[^/]+))(?:\/|$)/;
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
    case 'Identifier': {
      if (seen.has(node.name)) return '*';
      const binding = bindings.get(node.name);
      if (binding?.node) return literal(binding.node, bindings, new Set([...seen, node.name]));
      return nameOf(binding?.imported) === 'FIXTURES' || node.name === 'FIXTURES'
        ? 'fixtures'
        : '*';
    }
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
        nameOf(node.callee.property) ?? nameOf(bindings.get(node.callee.name)?.imported);
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
    return javaSourceMap(bindings.get(node.name)?.node, bindings, new Set([...seen, node.name]));
  }
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression')
    return javaSourceMap(node.expression, bindings, seen);
  if (node.type !== 'ObjectExpression') return '';
  for (const property of node.properties) {
    if (property.type === 'SpreadElement') {
      const match = javaSourceMap(property.argument, bindings, seen);
      if (match) return match;
    } else {
      const key = property.computed ? literal(property.key, bindings) : nameOf(property.key);
      if (typeof key === 'string' && key.endsWith('.java')) return key;
    }
  }
  return '';
}

function localBindings(node, outer) {
  const bindings = new Map(outer);
  for (const statement of node.body) {
    if (statement.type === 'ImportDeclaration') {
      for (const spec of statement.specifiers)
        bindings.set(spec.local.name, { module: statement.source.value, imported: spec.imported });
    } else if (statement.type === 'FunctionDeclaration' && statement.id) {
      bindings.set(statement.id.name, { node: statement });
    } else if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) {
        if (declaration.id.type === 'Identifier')
          bindings.set(declaration.id.name, { node: declaration.init });
        if (
          declaration.id.type === 'ObjectPattern' &&
          nameOf(declaration.init?.callee) === 'createRenameFixtureHelpers'
        ) {
          for (const property of declaration.id.properties) {
            if (['fixture', 'expectRename'].includes(nameOf(property.key)))
              bindings.set(nameOf(property.value), { writesFixture: true });
          }
        }
      }
    }
  }
  return bindings;
}

// Follow local fixture writers only when their implementation reaches real I/O.
function writesFiles(binding, outer, mocked, seen = new Set()) {
  if (binding?.writesFixture) return true;
  const node = binding?.node;
  if (
    !node ||
    seen.has(node) ||
    !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)
  )
    return false;
  seen.add(node);
  function walk(part, inherited) {
    const bindings = part.type === 'BlockStatement' ? localBindings(part, inherited) : inherited;
    if (part.type === 'CallExpression') {
      const callee = part.callee;
      const owner =
        nameOf(callee.object?.property) === 'promises' ? callee.object.object : callee.object;
      const resolved = bindings.get(callee.name ?? owner?.name);
      const method = nameOf(callee.property) ?? nameOf(resolved?.imported) ?? callee.name;
      if (
        fsCalls.has(method) &&
        fsModule.test(resolved?.module ?? '') &&
        !mocked.has(resolved.module.replace(/^node:/, ''))
      )
        return true;
      if (
        projectReaders.has(method) ||
        (callee.type === 'Identifier' && writesFiles(resolved, bindings, mocked, seen))
      )
        return true;
    }
    return children(part).some((child) => walk(child, bindings));
  }
  return walk(node.body, outer);
}

/** Detect Java fixture I/O statically. Vitest setup also detects in-memory inputs to the Java parser. */
export function javaFixtureUses(source, filename = 'suite.test.ts') {
  if (!/java|FIXTURES/i.test(source)) return [];
  const tree = parse(source, {
    sourceType: 'unambiguous',
    plugins: ['typescript', ...(filename.endsWith('x') ? ['jsx'] : [])],
  });
  const findings = [];
  const mocked = new Set();
  function findMocks(node) {
    if (
      node.type === 'CallExpression' &&
      nameOf(node.callee.object) === 'vi' &&
      nameOf(node.callee.property) === 'mock'
    ) {
      const spec = node.arguments[0]?.value;
      if (typeof spec === 'string' && fsModule.test(spec) && !node.arguments[1])
        mocked.add(spec.replace(/^node:/, ''));
    }
    for (const child of children(node)) findMocks(child);
  }
  findMocks(tree.program);
  function visit(node, outer) {
    const bindings = ['Program', 'BlockStatement'].includes(node.type)
      ? localBindings(node, outer)
      : outer;
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const callee = node.callee;
      const identifier = callee.type === 'Identifier';
      let owner = callee.object;
      if (nameOf(owner?.property) === 'promises') owner = owner.object;
      const binding = bindings.get(identifier ? callee.name : owner?.name);
      const method = identifier
        ? (nameOf(binding?.imported) ?? callee.name)
        : nameOf(callee.property);
      const actualFs =
        fsModule.test(binding?.module ?? '') && !mocked.has(binding.module.replace(/^node:/, ''));
      const isProject = projectReaders.has(method) && identifier;
      const explicitProjectPath =
        (node.type === 'NewExpression' && method === 'URL') ||
        (pathModule.test(binding?.module ?? '') && ['join', 'resolve'].includes(method));
      let match = '';
      if ((actualFs && fsCalls.has(method)) || isProject || explicitProjectPath) {
        const args = explicitProjectPath
          ? [node]
          : node.arguments.slice(
              0,
              ['cp', 'cpSync', 'copyFile', 'copyFileSync'].includes(method) ? 2 : 1,
            );
        for (const arg of args) {
          const candidate = literal(arg, bindings).replaceAll('\\', '/');
          if (fixturePath.test(candidate) || (actualFs && candidate.endsWith('.java'))) {
            match = candidate;
            break;
          }
        }
      }
      if (!match && (method === 'useFixture' || method === 'writeFixtureRepo') && isProject)
        match = javaSourceMap(node.arguments[1], bindings);
      if (!match && identifier && binding) {
        for (const arg of node.arguments) {
          const candidate = javaSourceMap(arg, bindings) || literal(arg, bindings);
          if (
            (candidate.endsWith('.java') || fixturePath.test(candidate)) &&
            writesFiles(binding, bindings, mocked)
          ) {
            match = candidate;
            break;
          }
        }
      }
      if (match) findings.push({ line: node.loc.start.line, method, path: match });
    }
    for (const child of children(node)) visit(child, bindings);
  }
  visit(tree.program, new Map());
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../../../test/', import.meta.url));
  const findings = [];
  for (const file of globSync('**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs}', { cwd: root })) {
    for (const issue of javaFixtureUses(readFileSync(path.join(root, file), 'utf8'), file))
      findings.push(file + ':' + issue.line + ' ' + issue.method + ' ' + issue.path);
  }
  if (findings.length) {
    console.error(
      'Run file-backed Java fixtures in compiler conformance:\n' +
        findings.sort(compareCodeUnits).join('\n'),
    );
    process.exitCode = 1;
  } else console.log('Java fixture ownership passed');
}
