import path from 'node:path';
import type Parser from 'tree-sitter';
import { splitRustUseDeclaration } from './import-decomposer.js';

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

const BUILTIN_DERIVES = new Set([
  'Clone',
  'Copy',
  'Debug',
  'Default',
  'Eq',
  'Hash',
  'Ord',
  'PartialEq',
  'PartialOrd',
]);
const EXPRESSION_MACROS = new Set([
  'print',
  'println',
  'eprint',
  'eprintln',
  'assert',
  'assert_eq',
  'assert_ne',
  'debug_assert',
  'debug_assert_eq',
  'debug_assert_ne',
  'vec',
  'format',
  'format_args',
  'write',
  'writeln',
  'panic',
  'todo',
  'unimplemented',
  'unreachable',
  'dbg',
  'matches',
]);

/** Token arguments can contain blocks/modules or further macro expansion.
 * Inspect token nodes, never strings/comments that merely mention those words. */
function hasExpandingArguments(tokens: Parser.SyntaxNode): boolean {
  for (let i = 0; i < tokens.childCount; i++) {
    const child = tokens.child(i)!;
    if (child.type === 'mod' || child.type === '#') return true;
    if (child.type === '!' && tokens.child(i - 1)?.type === 'identifier') return true;
    if (child.type === 'token_tree' && hasExpandingArguments(child)) return true;
  }
  return false;
}

/** Public use evidence from the same AST used for membership. Keeps restricted
 * and private globs distinct without changing the shared import/cache shape. */
export function rustPublicUses(root: Parser.SyntaxNode): ReadonlySet<string> {
  const uses = new Set<string>();
  const pending = [{ node: root, module: '' }];
  while (pending.length > 0) {
    const { node, module } = pending.pop()!;
    for (const child of node.namedChildren) {
      if (child.type === 'mod_item') {
        const body = child.childForFieldName('body');
        const name = child.childForFieldName('name')?.text;
        if (body && name)
          pending.push({ node: body, module: [module, name].filter(Boolean).join('::') });
      } else if (
        child.type === 'use_declaration' &&
        child.namedChildren.some(
          (part) => part.type === 'visibility_modifier' && part.text === 'pub',
        )
      ) {
        for (const capture of splitRustUseDeclaration(child)) {
          uses.add(
            JSON.stringify([
              module,
              capture['@import.source']?.text,
              capture['@import.kind']?.text,
              capture['@import.name']?.text,
            ]),
          );
        }
      }
    }
  }
  return uses;
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
  missingFiles?: Set<string>,
  isCrateRoot = false,
): readonly { file: string; ownsDirectory: boolean }[] | undefined {
  if (root.hasError) return undefined;
  // Built-in spellings are not proof when an import/local macro can shadow
  // them. Cross-file macro_use/macro_export remain unknown attributes below.
  const shadowed = new Set<string>();
  const globs: { node: Parser.SyntaxNode; path: string }[] = [];
  const scan = [root];
  while (scan.length) {
    const node = scan.pop()!;
    if (node.type === 'macro_definition' || node.type === 'mod_item') {
      const name = node.childForFieldName('name')?.text;
      if (name) shadowed.add(name);
      // macro_rules textual scope can extend into child module files. Without
      // expansion/scope receipts, do not assume their same-named calls are std.
      if (node.type === 'macro_definition' && name && EXPRESSION_MACROS.has(name)) return undefined;
    }
    if (node.type === 'use_declaration') {
      for (const capture of splitRustUseDeclaration(node)) {
        if (capture['@import.kind']?.text === 'wildcard')
          globs.push({ node, path: capture['@import.source']?.text ?? '' });
        const name = capture['@import.name']?.text;
        if (name) shadowed.add(name);
      }
    }
    if (node.type !== 'macro_definition' && node.type !== 'token_tree')
      scan.push(...node.namedChildren);
  }
  const wildcard = globs.some(({ node, path: imported }) => {
    const parts = imported.split('::').filter(Boolean);
    // Cargo aliases for these names are rejected by the loader. A local
    // module/import can still shadow a standard-library path in this file.
    if (['std', 'core', 'alloc'].includes(parts[0] ?? '') && !shadowed.has(parts[0]!)) return false;
    let depth = 0;
    let localModuleScope = true;
    for (let parent = node.parent; parent && parent !== root; parent = parent.parent) {
      if (parent.type === 'mod_item') depth++;
      if (
        parent.type === 'function_item' ||
        parent.type === 'block' ||
        parent.type === 'closure_expression'
      )
        localModuleScope = false;
    }
    // The common inline unit-test `use super::*` stays within this AST.
    // A file-level super glob has an external parent and remains unknown.
    if (
      localModuleScope &&
      parts.length > 0 &&
      parts.every((part) => part === 'super') &&
      parts.length <= depth
    )
      return false;
    // At a Cargo root, bare/self/crate paths to inline modules have the same
    // meaning across editions. Do not extend this assumption to file modules.
    if (isCrateRoot && node.parent === root) {
      if (parts[0] === 'self' || parts[0] === 'crate') parts.shift();
      let body: Parser.SyntaxNode | undefined = root;
      for (const part of parts) {
        body =
          body?.namedChildren
            .find(
              (child) =>
                child.type === 'mod_item' && child.childForFieldName('name')?.text === part,
            )
            ?.childForFieldName('body') ?? undefined;
      }
      if (parts.length > 0 && body !== undefined) return false;
    }
    return true;
  });
  const builtin = (name: string): boolean => !wildcard && !shadowed.has(name);
  const fileDir = path.posix.dirname(file);
  const moduleDir =
    ownsDirectory || path.posix.basename(file) === 'mod.rs'
      ? fileDir
      : file.slice(0, -'.rs'.length);
  const pending = [{ node: root, moduleDir, attributeDir: fileDir }];
  const result: { file: string; ownsDirectory: boolean }[] = [];
  let unresolved = false;
  while (pending.length) {
    const context = pending.pop()!;
    let attributes: Parser.SyntaxNode[] = [];
    for (const node of context.node.namedChildren) {
      if (node.type === 'line_comment' || node.type === 'block_comment') continue;
      if (node.type === 'attribute_item' || node.type === 'inner_attribute_item') {
        const attribute = node.namedChildren[0];
        const name = attribute?.namedChildren[0]?.text;
        if (name === 'derive') {
          const argumentsNode = attribute?.childForFieldName('arguments');
          if (
            !argumentsNode ||
            !builtin('derive') ||
            argumentsNode.namedChildren.length === 0 ||
            argumentsNode.namedChildren.some(
              (item) =>
                item.type !== 'identifier' ||
                !BUILTIN_DERIVES.has(item.text) ||
                !builtin(item.text),
            ) ||
            argumentsNode.children.some(
              (item) =>
                !['(', ')', ',', 'identifier', 'line_comment', 'block_comment'].includes(item.type),
            )
          )
            return undefined;
        } else if (!name || !NON_EXPANDING_ATTRIBUTES.has(name)) return undefined;
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
      const macro =
        node.type === 'macro_invocation'
          ? node
          : node.type === 'expression_statement' &&
              node.namedChildren[0]?.type === 'macro_invocation'
            ? node.namedChildren[0]
            : undefined;
      if (macro) {
        const name = macro.childForFieldName('macro')?.text;
        const tokens = macro.namedChildren.find((child) => child.type === 'token_tree');
        const parts = name?.split('::').filter(Boolean) ?? [];
        const standard =
          parts.length === 1 ||
          (parts.length === 2 && ['std', 'core', 'alloc'].includes(parts[0]!));
        if (
          !standard ||
          !EXPRESSION_MACROS.has(parts.at(-1) ?? '') ||
          !parts.every(builtin) ||
          !tokens ||
          hasExpandingArguments(tokens) ||
          context.node.type === 'source_file' ||
          context.node.type === 'declaration_list'
        )
          return undefined;
        continue;
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
      if (existing.length === 0) {
        if (!missingFiles) return undefined;
        for (const candidate of candidates) missingFiles.add(candidate);
        unresolved = true;
        continue;
      }
      // Union conditional alternatives; shared membership must never be erased.
      // #[path] makes the loaded file own its containing directory, just like
      // a crate root; its children do NOT acquire the file stem as a prefix.
      result.push(...existing.map((file) => ({ file, ownsDirectory: override !== undefined })));
    }
  }
  return unresolved ? undefined : result;
}
