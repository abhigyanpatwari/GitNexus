import path from 'node:path';
import type Parser from 'tree-sitter';

// Built-in attributes cannot expand to new module declarations. cfg is a union:
// visiting both alternatives is conservative; cfg_attr may change a path.
const NON_EXPANDING_ATTRIBUTES = new Set([
  'cfg',
  'path',
  'allow',
  'warn',
  'deny',
  'forbid',
  'expect',
  'doc',
  'test',
  'should_panic',
  'ignore',
  'derive',
  'automatically_derived',
  'proc_macro',
  'proc_macro_derive',
  'proc_macro_attribute',
  'inline',
  'cold',
  'no_mangle',
  'export_name',
  'repr',
  'non_exhaustive',
  'must_use',
  'deprecated',
  'no_std',
  'no_main',
  'feature',
  'crate_type',
  'crate_name',
  'recursion_limit',
  'type_length_limit',
]);

// Expression-position std macros cannot introduce `mod` items. Item-position
// `include!` / unknown macros still abort the membership proof.
const NON_EXPANDING_MACROS = new Set([
  'print',
  'println',
  'eprint',
  'eprintln',
  'dbg',
  'assert',
  'assert_eq',
  'assert_ne',
  'vec',
  'format',
  'format_args',
  'write',
  'writeln',
  'panic',
  'todo',
  'unimplemented',
  'unreachable',
]);

function identName(node: Parser.SyntaxNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'identifier') return node.text;
  if (node.type === 'scoped_identifier') return node.childForFieldName('name')?.text;
  return undefined;
}

/** Decode a literal path without mistaking strings/comments for Rust syntax. */
function literalPath(text: string): string | undefined {
  const raw = /^r(#+)?"([\s\S]*)"\1$/.exec(text);
  if (raw) return raw[2];
  // Escape forms beyond JSON's subset remain unknown, never a guessed path.
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** External modules reachable from one source file; undefined is incomplete. */
export function rustModuleFiles(
  root: Parser.SyntaxNode,
  file: string,
  ownsDirectory: boolean,
  files: ReadonlySet<string>,
): readonly { file: string; ownsDirectory: boolean }[] | undefined {
  if (root.hasError) return undefined;
  const fileDir = path.posix.dirname(file);
  const moduleDir =
    ownsDirectory || path.posix.basename(file) === 'mod.rs'
      ? fileDir
      : file.slice(0, -'.rs'.length);
  const pending = [{ node: root, moduleDir, attributeDir: fileDir }];
  const result: { file: string; ownsDirectory: boolean }[] = [];
  while (pending.length) {
    const context = pending.pop()!;
    let attributes: Parser.SyntaxNode[] = [];
    for (const node of context.node.namedChildren) {
      if (node.type === 'line_comment' || node.type === 'block_comment') continue;
      if (node.type === 'attribute_item' || node.type === 'inner_attribute_item') {
        const attribute = node.namedChildren[0];
        const name = identName(attribute?.namedChildren[0]);
        if (!name || !NON_EXPANDING_ATTRIBUTES.has(name)) return undefined;
        if (node.type === 'attribute_item') attributes.push(node);
        continue;
      }
      const attrs = attributes;
      attributes = [];
      // The current scope captures do not carry extern-crate aliases. Do not
      // certify a negative import-root proof from an incomplete namespace view.
      if (node.type === 'extern_crate_declaration' && node.childForFieldName('alias') !== null) {
        return undefined;
      }
      const invocation =
        node.type === 'macro_invocation'
          ? node
          : node.type === 'expression_statement' &&
              node.namedChildren[0]?.type === 'macro_invocation'
            ? node.namedChildren[0]
            : undefined;
      if (invocation) {
        const name = identName(
          invocation.childForFieldName('macro') ?? invocation.namedChildren[0],
        );
        if (!name || !NON_EXPANDING_MACROS.has(name)) return undefined;
      }
      if (node.type !== 'mod_item') {
        // Items (including external #[path] modules) can also occur in blocks.
        // Inspect them too; a macro expansion there can add shared membership.
        // Macro definitions/token trees and literal contents are not expansions.
        if (
          node.type !== 'macro_definition' &&
          node.type !== 'token_tree' &&
          node.namedChildCount > 0
        ) {
          pending.push({ ...context, node });
        }
        continue;
      }
      const name = node.childForFieldName('name')?.text;
      if (!name) return undefined;
      let override: string | undefined;
      for (const attr of attrs) {
        const attribute = attr.namedChildren[0]!;
        if (attribute.namedChildren[0]?.text !== 'path') continue;
        const value = attribute.childForFieldName('value');
        if (!value || override !== undefined) return undefined;
        override = literalPath(value.text);
        if (override === undefined || path.posix.isAbsolute(override) || override.includes('\\'))
          return undefined;
      }
      const body = node.childForFieldName('body');
      if (body) {
        const dir =
          override === undefined
            ? path.posix.join(context.moduleDir, name)
            : path.posix.join(context.attributeDir, override);
        pending.push({ node: body, moduleDir: dir, attributeDir: dir });
        continue;
      }
      const candidates =
        override !== undefined
          ? [path.posix.normalize(path.posix.join(context.attributeDir, override))]
          : [
              path.posix.join(context.moduleDir, `${name}.rs`),
              path.posix.join(context.moduleDir, name, 'mod.rs'),
            ];
      const existing = candidates.filter((candidate) => files.has(candidate));
      if (existing.length === 0) return undefined;
      // Union conditional alternatives; shared membership must never be erased.
      // #[path] makes the loaded file own its containing directory, just like
      // a crate root; its children do NOT acquire the file stem as a prefix.
      result.push(...existing.map((file) => ({ file, ownsDirectory: override !== undefined })));
    }
  }
  return result;
}
