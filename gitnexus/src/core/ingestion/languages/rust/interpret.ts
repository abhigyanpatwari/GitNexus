import type { CaptureMatch, ParsedImport, ParsedTypeBinding, TypeRef } from 'gitnexus-shared';

const REF_PREFIX_RE = /^&\s*(mut\s+)?/;
const PTR_PREFIX_RE = /^\*\s*(const|mut)?\s*/;
const ENUM_VARIANT_NAMES = new Set(['Some', 'None', 'Ok', 'Err']);

// ─── interpretImport ──────────────────────────────────────────────────────

export function interpretRustImport(captures: CaptureMatch): ParsedImport | null {
  const kind = captures['@import.kind']?.text;
  const source = captures['@import.source']?.text;
  const name = captures['@import.name']?.text;
  const alias = captures['@import.alias']?.text;
  if (kind === undefined || source === undefined) return null;

  if (kind === 'wildcard') return { kind: 'wildcard', targetRaw: source };
  if (kind === 'namespace') {
    if (name === undefined) return null;
    return { kind: 'namespace', localName: name, importedName: name, targetRaw: source };
  }
  if (kind === 'reexport') {
    if (name === undefined) return null;
    const originalName = captures['@import.original-name']?.text;
    return {
      kind: 'reexport',
      localName: alias ?? name,
      importedName: originalName ?? name,
      targetRaw: source,
    };
  }
  // kind === 'named'
  if (name === undefined) return null;
  const originalName = captures['@import.original-name']?.text;
  return {
    kind: 'named',
    localName: alias ?? name,
    importedName: originalName ?? name,
    targetRaw: source,
  };
}

// ─── interpretTypeBinding ─────────────────────────────────────────────────

export function interpretRustTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const name = captures['@type-binding.name']?.text;
  const type = captures['@type-binding.type']?.text;
  if (name === undefined || type === undefined) return null;

  let source: TypeRef['source'] = 'annotation';
  let normalizedType: string;

  if (captures['@type-binding.self'] !== undefined) {
    source = 'self';
    normalizedType = normalizeRustTypeName(type);
  } else if (captures['@type-binding.constructor'] !== undefined) {
    source = 'constructor-inferred';
    normalizedType = normalizeRustTypeName(type);
  } else if (captures['@type-binding.call-return'] !== undefined) {
    if (ENUM_VARIANT_NAMES.has(type)) return null;
    source = 'constructor-inferred';
    normalizedType = normalizeRustCallReturnType(type);
  } else if (captures['@type-binding.return'] !== undefined) {
    source = 'return-annotation';
    normalizedType = normalizeRustReturnType(type);
  } else if (captures['@type-binding.assignment'] !== undefined) {
    source = 'assignment-inferred';
    normalizedType = normalizeRustTypeName(type);
  } else if (captures['@type-binding.alias'] !== undefined) {
    source = 'assignment-inferred';
    normalizedType = normalizeRustTypeName(type);
  } else if (captures['@type-binding.parameter'] !== undefined) {
    source = 'parameter-annotation';
    normalizedType = normalizeRustTypeName(type);
  } else {
    normalizedType = normalizeRustTypeName(type);
  }

  return { boundName: name, rawTypeName: normalizedType, source };
}

export function normalizeRustTypeName(text: string): string {
  let t = text.trim();
  // Strip reference prefixes (&, &mut, *const, *mut)
  while (t.startsWith('&')) t = t.replace(REF_PREFIX_RE, '');
  while (t.startsWith('*')) t = t.replace(PTR_PREFIX_RE, '');
  // Unwrap common smart-pointer/container wrappers to their inner type
  const wrappers = ['Box', 'Option', 'Arc', 'Rc', 'Mutex', 'RwLock', 'RefCell', 'Cell'];
  for (const w of wrappers) {
    if (t.startsWith(`${w}<`)) {
      const inner = extractFirstGenericArg(t);
      if (inner !== null) {
        t = inner;
        break;
      }
    }
  }
  if (t.startsWith('Vec<')) {
    const inner = extractFirstGenericArg(t);
    if (inner !== null) t = inner;
  }
  const bracket = t.indexOf('<');
  if (bracket !== -1) t = t.slice(0, bracket);
  // Take last segment of qualified paths (crate::foo::Bar → Bar)
  const lastColon = t.lastIndexOf('::');
  if (lastColon !== -1) t = t.slice(lastColon + 2);
  return t.trim();
}

function extractFirstGenericArg(text: string): string | null {
  const open = text.indexOf('<');
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '<') depth++;
    else if (text[i] === '>') {
      depth--;
      if (depth === 0) {
        const inner = text.slice(open + 1, i).trim();
        const comma = findTopLevelComma(inner);
        return comma === -1 ? inner : inner.slice(0, comma).trim();
      }
    }
  }
  return null;
}

function findTopLevelComma(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '<') depth++;
    else if (text[i] === '>') depth--;
    else if (text[i] === ',' && depth === 0) return i;
  }
  return -1;
}

function normalizeRustCallReturnType(text: string): string {
  let t = text.trim();
  // For scoped calls like `Foo::new()`, extract the type part before `::`
  const scopeIdx = t.indexOf('::');
  if (scopeIdx !== -1) {
    t = t.slice(0, scopeIdx);
  }
  return normalizeRustTypeName(t);
}

function normalizeRustReturnType(text: string): string {
  let t = text.trim();
  while (t.startsWith('&')) t = t.replace(REF_PREFIX_RE, '');
  // Unwrap Result<T, E>, Option<T> for return types
  const wrappers = ['Result', 'Option'];
  for (const w of wrappers) {
    if (t.startsWith(`${w}<`)) {
      const inner = extractFirstGenericArg(t);
      if (inner !== null) {
        t = inner;
        break;
      }
    }
  }
  const bracket = t.indexOf('<');
  if (bracket !== -1) t = t.slice(0, bracket);
  const lastColon = t.lastIndexOf('::');
  if (lastColon !== -1) t = t.slice(lastColon + 2);
  return t.trim();
}
