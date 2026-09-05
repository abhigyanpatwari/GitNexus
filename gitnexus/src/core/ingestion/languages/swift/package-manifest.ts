/**
 * Read the source targets declared in a Swift Package manifest without
 * executing the manifest. Dynamic target declarations are intentionally
 * omitted: missing an edge is safer than inventing one for an external module.
 */

const SOURCE_TARGET_FACTORIES = new Set([
  'target',
  'executableTarget',
  'testTarget',
  'macro',
  'plugin',
]);

function skipTrivia(source: string, start: number): number {
  let i = start;
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }
    if (source.startsWith('//', i)) {
      const newline = source.indexOf('\n', i + 2);
      return newline === -1 ? source.length : skipTrivia(source, newline + 1);
    }
    if (source.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (source.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    break;
  }
  return i;
}

function skipString(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
    } else if (source[i] === '"') {
      return i + 1;
    } else {
      i++;
    }
  }
  return source.length;
}

function findClosingDelimiter(
  source: string,
  open: number,
  opening: '(' | '[',
  closing: ')' | ']',
): number {
  let depth = 1;
  let i = open + 1;
  while (i < source.length) {
    if (source[i] === '"') {
      i = skipString(source, i);
      continue;
    }
    if (source.startsWith('//', i) || source.startsWith('/*', i)) {
      i = skipTrivia(source, i);
      continue;
    }
    if (source[i] === opening) depth++;
    if (source[i] === closing && --depth === 0) return i;
    i++;
  }
  return -1;
}

function findTopLevelArgument(body: string, label: string): number | null {
  let i = 0;
  let depth = 0;
  while (i < body.length) {
    i = skipTrivia(body, i);
    if (i >= body.length) break;
    if (body[i] === '"') {
      i = skipString(body, i);
      continue;
    }
    if (body[i] === '(' || body[i] === '[' || body[i] === '{') {
      depth++;
      i++;
      continue;
    }
    if (body[i] === ')' || body[i] === ']' || body[i] === '}') {
      depth--;
      i++;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(i))?.[0];
    if (depth !== 0 || identifier === undefined) {
      i++;
      continue;
    }
    i += identifier.length;
    if (identifier !== label) continue;
    i = skipTrivia(body, i);
    if (body[i] !== ':') continue;
    return skipTrivia(body, i + 1);
  }
  return null;
}

function readStringArgument(body: string, label: string): string | null {
  const start = findTopLevelArgument(body, label);
  if (start === null || body[start] !== '"') return null;
  const end = skipString(body, start);
  if (end > body.length || body[end - 1] !== '"') return null;
  const raw = body.slice(start + 1, end - 1);
  // Target names and paths are normally plain string literals. Refuse
  // interpolation and uncommon escape forms instead of guessing at them.
  if (raw.includes('\\(') || /\\(?!["\\nrt0])/.test(raw)) return null;
  return raw.replace(/\\(["\\nrt0])/g, (_match, escaped: string) => {
    if (escaped === 'n') return '\n';
    if (escaped === 'r') return '\r';
    if (escaped === 't') return '\t';
    if (escaped === '0') return '\0';
    return escaped;
  });
}

export interface SwiftManifestTarget {
  readonly name: string;
  readonly path: string;
}

function parseTargetList(source: string): SwiftManifestTarget[] {
  const targets: SwiftManifestTarget[] = [];
  let i = 0;
  let depth = 0;
  while (i < source.length) {
    i = skipTrivia(source, i);
    if (i >= source.length) break;
    if (source[i] === '"') {
      i = skipString(source, i);
      continue;
    }
    if (source[i] === '(' || source[i] === '[' || source[i] === '{') {
      depth++;
      i++;
      continue;
    }
    if (source[i] === ')' || source[i] === ']' || source[i] === '}') {
      depth--;
      i++;
      continue;
    }
    if (depth !== 0 || source[i] !== '.') {
      i++;
      continue;
    }
    const nameStart = i + 1;
    const factory = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(nameStart))?.[0];
    if (factory === undefined || !SOURCE_TARGET_FACTORIES.has(factory)) {
      i++;
      continue;
    }
    const open = skipTrivia(source, nameStart + factory.length);
    if (source[open] !== '(') {
      i = open;
      continue;
    }
    const close = findClosingDelimiter(source, open, '(', ')');
    if (close === -1) break;
    const body = source.slice(open + 1, close);
    const name = readStringArgument(body, 'name');
    if (name !== null && name !== '') {
      const pathStart = findTopLevelArgument(body, 'path');
      const explicitPath = readStringArgument(body, 'path');
      if (pathStart !== null && explicitPath === null) {
        i = close + 1;
        continue;
      }
      const defaultRoot =
        factory === 'testTarget' ? 'Tests' : factory === 'plugin' ? 'Plugins' : 'Sources';
      targets.push({ name, path: explicitPath ?? `${defaultRoot}/${name}` });
    }
    i = close + 1;
  }
  return targets;
}

export function parseSwiftPackageTargets(source: string): SwiftManifestTarget[] {
  let i = 0;
  while (i < source.length) {
    i = skipTrivia(source, i);
    if (i >= source.length) break;
    if (source[i] === '"') {
      i = skipString(source, i);
      continue;
    }
    const constructor = /^Package\b/.exec(source.slice(i))?.[0];
    if (constructor === undefined || (i > 0 && /[A-Za-z0-9_.]/.test(source[i - 1]))) {
      i++;
      continue;
    }
    const open = skipTrivia(source, i + constructor.length);
    if (source[open] !== '(') {
      i = open;
      continue;
    }
    const close = findClosingDelimiter(source, open, '(', ')');
    if (close === -1) return [];
    const packageBody = source.slice(open + 1, close);
    const targetsStart = findTopLevelArgument(packageBody, 'targets');
    if (targetsStart === null || packageBody[targetsStart] !== '[') return [];
    const targetsEnd = findClosingDelimiter(packageBody, targetsStart, '[', ']');
    if (targetsEnd === -1) return [];
    const targetList = packageBody.slice(targetsStart + 1, targetsEnd);
    // Conditional compilation can make only one branch authoritative. Taking
    // the union would fabricate targets, so leave such manifests unresolved.
    if (/(?:^|\n)\s*#(?:if|elseif|else|endif)\b/.test(targetList)) return [];
    return parseTargetList(targetList);
  }
  return [];
}
