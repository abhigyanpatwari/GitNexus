import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { findClassBindingInScope, lookupNameClaim } from '../../scope-resolution/scope/walkers.js';

// Conservative receiver-method inventory from Rust 1.99.1, including conditional
// and blanket implementations. An overlap keeps the whole field wrapped until
// dispatch can preserve ordered autoderef; this is not a method-selection table.
// https://doc.rust-lang.org/1.99.1/std/boxed/struct.Box.html
// https://doc.rust-lang.org/1.99.1/std/rc/struct.Rc.html
// https://doc.rust-lang.org/1.99.1/std/sync/struct.Arc.html
const POINTER_MEMBER_NAMES: ReadonlySet<string> = new Set(
  `
advance_back_by advance_by all allocate allocate_zeroed any array_chunks as_fd as_handle
as_mut as_raw_fd as_ref as_socket as_utf8_pattern assume_init async_call async_call_mut
async_call_once borrow borrow_mut by_ref bytes call call_mut call_once cause chain clamp
clone clone_from clone_into clone_to_uninit cloned cmp cmp_by collect collect_into
consume copied count cycle deallocate deref deref_mut description downcast
downcast_unchecked drop enumerate eq eq_by extend extend_one extend_reserve fill_buf
filter filter_map find find_map finish flat_map flatten flush fmt fold for_each fuse ge
grow grow_zeroed gt has_data_left hash inspect intersperse intersperse_with into
into_array into_async_iter into_future into_iter into_searcher is_contained_in is_empty
is_partitioned is_prefix_of is_read_vectored is_sorted is_sorted_by is_sorted_by_key
is_suffix_of is_write_vectored last le len lines lt map map_while map_windows max max_by
max_by_key min min_by min_by_key ne next next_back next_chunk next_chunk_back nth
nth_back partial_cmp partial_cmp_by partition partition_in_place peekable pin_drop poll
poll_next position product provide read read_array read_be read_buf read_buf_exact
read_exact read_le read_line read_to_end read_to_string read_until read_vectored reduce
resume rev rewind rfind rfold rposition scan seek seek_relative share shrink size_hint
skip skip_until skip_while source split step_by stream_len stream_position
strip_prefix_of strip_suffix_of sum take take_while to_owned to_string try_collect
try_find try_fold try_for_each try_into try_reduce try_rfold type_id unzip write
write_all write_all_vectored write_fmt write_i128 write_i16 write_i32 write_i64 write_i8
write_isize write_length_prefix write_str write_u128 write_u16 write_u32 write_u64
write_u8 write_usize write_vectored zip
`
    .trim()
    .split(/\s+/),
);
const POINTER_NAMES = new Set(['Box', 'Rc', 'Arc']);
// Compiler attributes that cannot introduce arbitrary dispatch implementations.
// cfg_attr and procedural/tool attributes deliberately remain opaque.
const COMPILER_ATTRIBUTES = new Set([
  'allow',
  'warn',
  'deny',
  'forbid',
  'expect',
  'cfg',
  'cold',
  'inline',
  'must_use',
  'repr',
  'non_exhaustive',
  'deprecated',
  'doc',
  'test',
  'ignore',
  'should_panic',
  'track_caller',
  'no_mangle',
  'export_name',
  'link',
  'link_name',
  'link_section',
  'used',
  'unsafe',
  'default',
  'automatically_derived',
  'derive',
]);
const COMPILER_DERIVES = new Set([
  'Clone',
  'Copy',
  'Debug',
  'Default',
  'PartialEq',
  'Eq',
  'PartialOrd',
  'Ord',
  'Hash',
]);

export interface RustPointerFieldSafety {
  readonly externCrateAliases: ReadonlySet<string>;
  readonly opaqueWrappers: ReadonlySet<string>;
  readonly opaquePointees: ReadonlySet<string>;
  readonly membersByType: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Index declaration evidence once, before any pointer fields are flattened. */
export function buildRustPointerFieldSafety(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  rootFor: (parsed: ParsedFile) => SyntaxNode | null,
  scopeFor: (parsed: ParsedFile, node: SyntaxNode) => ScopeId | undefined,
): RustPointerFieldSafety {
  const externCrateAliases = new Set<string>();
  const opaqueWrappers = new Set<string>();
  const opaquePointees = new Set<string>();
  const membersByType = new Map<string, Set<string>>();
  const typeDef = (
    parsed: ParsedFile,
    node: SyntaxNode,
    name: string,
  ): SymbolDefinition | undefined => {
    const scope = scopeFor(parsed, node);
    return scope === undefined
      ? undefined
      : findClassBindingInScope(scope, name, indexes, undefined, {
          uniqueQualifiedNameFallback: false,
          purpose: 'type',
        });
  };
  for (const parsed of parsedFiles) {
    const root = rootFor(parsed);
    if (root === null) continue;
    // An unresolved non-standard import may bring a blanket extension trait.
    // Macro definitions may emit impls absent from the parsed declaration model.
    // Neither supplies enough dispatch evidence to erase a wrapper safely.
    const hasUnknownImport = parsed.parsedImports.some((entry) => {
      const importedRoot = entry.targetRaw.replace(/^::/, '').split('::')[0]!;
      if (['std', 'core', 'alloc', 'self', 'super', 'crate'].includes(importedRoot)) return false;
      if (!('localName' in entry)) return true;
      const claim = lookupNameClaim(
        entry.declaredAtScope ?? parsed.moduleScope,
        entry.localName,
        indexes,
        { purpose: 'type' },
      );
      return claim.imports.length === 0 || claim.imports.some((edge) => edge.targetFile === null);
    });
    const hasOpaqueAttribute = root
      .descendantsOfType(['attribute_item', 'inner_attribute_item'])
      .some((attribute) => {
        const name = /^#!?\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|=|\])/.exec(attribute.text)?.[1];
        if (name === undefined || !COMPILER_ATTRIBUTES.has(name)) return true;
        if (name !== 'derive') return false;
        const args = /^#!?\[\s*derive\s*\(([\s\S]*)\)\s*\]$/.exec(attribute.text)?.[1];
        return (
          args === undefined ||
          args
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
            .some((part) => !COMPILER_DERIVES.has(part))
        );
      });
    const hasOpaqueInvocation = root.descendantsOfType('macro_invocation').some((macro) => {
      const name = macro.childForFieldName('macro')?.text ?? '';
      const parent = macro.parent;
      const owner = parent?.type === 'expression_statement' ? parent.parent : parent;
      if (
        name.includes('::') ||
        name === 'include' ||
        owner?.type === 'source_file' ||
        owner?.type === 'declaration_list'
      )
        return true;
      const tokens = macro.namedChildren.find((child) => child.type === 'token_tree')?.text ?? '';
      // Macro token trees are not parsed as declarations. Reject hidden impls
      // and nested invocations rather than guessing what their expansion emits.
      return /\bimpl\b|\b[A-Za-z_][A-Za-z0-9_]*\s*!/.test(tokens);
    });
    if (
      hasUnknownImport ||
      hasOpaqueAttribute ||
      hasOpaqueInvocation ||
      root.descendantsOfType('macro_definition').length > 0
    ) {
      for (const pointer of POINTER_NAMES) opaqueWrappers.add(pointer);
    }
    for (const declaration of root.descendantsOfType('extern_crate_declaration')) {
      const alias = declaration.childForFieldName('alias')?.text;
      if (alias !== undefined && alias !== declaration.childForFieldName('name')?.text)
        externCrateAliases.add(alias);
    }
    for (const node of root.descendantsOfType(['impl_item', 'trait_item'])) {
      const isImpl = node.type === 'impl_item';
      const written = node.childForFieldName(isImpl ? 'type' : 'name')?.text;
      if (written === undefined) continue;
      const base = written
        .replace(/^&\s*(?:'[\w]+\s+)?(?:mut\s+)?/, '')
        .split('<')[0]!
        .trim();
      const definition = typeDef(parsed, node, base);
      if (isImpl && node.childForFieldName('trait') !== null) {
        const tail = base.split('::').at(-1)!;
        if (POINTER_NAMES.has(tail)) opaqueWrappers.add(tail);
        else if (definition !== undefined) opaquePointees.add(definition.nodeId);
        else for (const pointer of POINTER_NAMES) opaqueWrappers.add(pointer);
      }
      if (definition === undefined) {
        // Qualified inherent impls can still attach methods downstream even
        // when their self type cannot be proved here. Do not flatten through it.
        if (isImpl) for (const pointer of POINTER_NAMES) opaqueWrappers.add(pointer);
        continue;
      }
      const members = membersByType.get(definition.nodeId) ?? new Set<string>();
      const body = node.childForFieldName('body');
      for (const member of body?.namedChildren ?? []) {
        if (member.type !== 'function_item' && member.type !== 'function_signature_item') continue;
        const name = member.childForFieldName('name')?.text;
        if (name !== undefined) members.add(name);
      }
      membersByType.set(definition.nodeId, members);
    }
  }
  return { externCrateAliases, opaqueWrappers, opaquePointees, membersByType };
}

/** No qualified-tail guessing, projections or callable types after autoderef. */
export function canFlattenRustPointerTarget(
  target: string,
  scope: ScopeId,
  indexes: ScopeResolutionIndexes,
  safety: RustPointerFieldSafety,
): boolean {
  if (target.includes('::') || /[()[\]]/.test(target) || target.startsWith('<')) return false;
  const base = target.split('<')[0]!.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(base)) return false;
  const definition = findClassBindingInScope(scope, base, indexes, undefined, {
    uniqueQualifiedNameFallback: false,
    purpose: 'type',
  });
  if (definition === undefined || safety.opaquePointees.has(definition.nodeId)) return false;
  for (const member of safety.membersByType.get(definition.nodeId) ?? []) {
    if (POINTER_MEMBER_NAMES.has(member)) return false;
  }
  return true;
}
