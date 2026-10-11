import { CLASS_KINDS, SupportedLanguages } from 'gitnexus-shared';
import type { RenameProvider, RenameSource } from '../../rename-provider.js';
import { createTreeSitterRenameSource } from '../rename-tree-sitter.js';
import { cNameReference, cNameRole, checkCMacroSafety, withParameterClaims } from '../c/rename.js';
import { callableDeclarationFamilies } from '../../scope-resolution/passes/callable-value-flow.js';
import { buildGraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';
import { graphRenameFamily } from '../rename-family.js';
import { isFileLocal } from './file-local-linkage.js';
import { isStaticName } from '../c/static-linkage.js';
import { normalizeQualifiedName } from '../../utils/qualified-name.js';
import { lookupNameClaim } from '../../scope-resolution/scope/walkers.js';

// C++ [lex.key], including alternative operator tokens. C-only keywords such as
// restrict are valid C++ identifiers and must not enter this provider's set.
const keywords = new Set(
  'alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue contract_assert co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq'.split(
    ' ',
  ),
);
const names = new Set([
  'identifier',
  'type_identifier',
  'field_identifier',
  'namespace_identifier',
  'statement_identifier',
]);

const parseSource = createTreeSitterRenameSource({
  isName: (node) => names.has(node.type),
  skip: (node) => node.type === 'comment',
  role: cNameRole,
  transformParsed: (parsed) => ({
    ...parsed,
    localDefs: parsed.localDefs.map((def) => {
      if (!simpleQualifiedName(def)?.startsWith('~') || !def.nameRange) return def;
      // The destructor's tilde is syntax; the source name is the child identifier.
      return Object.assign(def, {
        nameRange: { ...def.nameRange, startCol: def.nameRange.startCol + 1 },
      });
    }),
  }),
  reference(node, source) {
    const site = cNameReference(node, source);
    return site &&
      (node.type === 'type_identifier' ||
        node.type === 'namespace_identifier' ||
        node.parent?.type === 'destructor_name')
      ? { ...site, kind: 'type-reference' as const, lookupPurpose: 'type' as const }
      : site;
  },
});

/** Qualified members and constructors do not declare a free lexical function. */
function withCppLexicalBindings(source: RenameSource): RenameSource {
  const nonLexical = new Set<string>();
  const defs = new Map(source.parsed.localDefs.map((def) => [def.nodeId, def]));
  for (const def of defs.values()) {
    const owner = def.ownerId && defs.get(def.ownerId);
    if (
      owner &&
      CLASS_KINDS.includes(owner.type) &&
      (simpleQualifiedName(def) ?? '').replace(/^~/, '') === simpleQualifiedName(owner)
    )
      nonLexical.add(def.nodeId);
  }
  for (const occurrence of source.occurrences) {
    if (!occurrence.definitionId || !occurrence.node) continue;
    const name =
      occurrence.node.parent?.type === 'destructor_name' ? occurrence.node.parent : occurrence.node;
    if (name.parent?.type === 'qualified_identifier') nonLexical.add(occurrence.definitionId);
  }
  return {
    ...source,
    parsed: {
      ...source.parsed,
      scopes: source.parsed.scopes.map((scope) => ({
        ...scope,
        bindings: new Map(
          [...scope.bindings].flatMap(([name, bindings]) => {
            const lexical = bindings.filter((binding) => !nonLexical.has(binding.def.nodeId));
            return lexical.length ? [[name, lexical]] : [];
          }),
        ),
      })),
    },
  };
}

export const cppRenameProvider: RenameProvider = {
  checkSafety: checkCMacroSafety,
  canonicalName: (name) => name.replace(/^~/, ''),
  acceptsSourceProvider: (provider) =>
    [SupportedLanguages.C, SupportedLanguages.CPlusPlus].includes(provider.id),
  symbolFamily(context) {
    const writtenQualifications = new Map<string, string>();
    const writtenOwners = new Map<string, string>();
    for (const source of context.files.values())
      for (const occurrence of source.occurrences) {
        if (!occurrence.definitionId || !occurrence.node) continue;
        const name =
          occurrence.node.parent?.type === 'destructor_name'
            ? occurrence.node.parent
            : occurrence.node;
        const qualified = name.parent;
        if (
          qualified?.type === 'qualified_identifier' &&
          qualified.childForFieldName('name')?.id === name.id
        ) {
          writtenQualifications.set(
            occurrence.definitionId,
            normalizeQualifiedName(qualified.text),
          );
          const qualifier = qualified.childForFieldName('scope');
          const qualifierOccurrence = source.occurrences.find(
            (candidate) => candidate.node?.id === qualifier?.id,
          );
          const site = qualifierOccurrence?.referenceSite;
          if (site) {
            const claim = lookupNameClaim(
              site.lookupScope ?? site.inScope,
              site.name,
              context.indexes,
              {
                position: site.atRange,
                purpose: 'type',
              },
            );
            const owners = [
              ...new Set(
                claim.bindings
                  .filter((binding) => CLASS_KINDS.includes(binding.def.type))
                  .map((binding) => binding.def.nodeId),
              ),
            ];
            if (claim.status === 'resolved' && owners.length === 1)
              writtenOwners.set(occurrence.definitionId, owners[0]);
          }
        }
      }
    const declarations = callableDeclarationFamilies(
      context.indexes,
      context.graph,
      buildGraphNodeLookup(context.graph),
      (def) =>
        !def.ownerId &&
        (isFileLocal(def.filePath, simpleQualifiedName(def) ?? '') ||
          isStaticName(def.filePath, simpleQualifiedName(def) ?? '')),
      writtenQualifications,
    );
    const owner =
      context.target.ownerId &&
      context.definitions.find((def) => def.nodeId === context.target.ownerId);
    const classTarget = CLASS_KINDS.includes(context.target.type)
      ? context.target
      : owner &&
          (simpleQualifiedName(context.target) ?? '').replace(/^~/, '') ===
            simpleQualifiedName(owner)
        ? owner
        : undefined;
    if (classTarget) {
      const className = simpleQualifiedName(classTarget);
      const selected = new Map([[classTarget.nodeId, classTarget]]);
      for (const def of context.definitions) {
        if (
          (def.ownerId ?? writtenOwners.get(def.nodeId)) !== classTarget.nodeId ||
          (simpleQualifiedName(def) ?? '').replace(/^~/, '') !== className
        )
          continue;
        for (const member of declarations.get(def.nodeId) ?? [def])
          selected.set(member.nodeId, member);
      }
      return [...selected.values()];
    }
    return graphRenameFamily(context, {
      matches: (left, right) =>
        !!left.ownerId &&
        !!right.ownerId &&
        simpleQualifiedName(left) === simpleQualifiedName(right) &&
        left.parameterCount === right.parameterCount &&
        JSON.stringify(left.parameterTypes) === JSON.stringify(right.parameterTypes),
      sameDeclarationGroup: (left, right) =>
        declarations.get(left.nodeId)?.some((def) => def.nodeId === right.nodeId) === true,
    });
  },
  validateName(name) {
    if (
      !/^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(name) ||
      keywords.has(name) ||
      name.includes('__') ||
      /^_[A-Z]/.test(name)
    )
      return { code: 'invalid_name', message: 'Choose a valid nonreserved C++ identifier.' };
  },
  parseSource: async (input) =>
    withCppLexicalBindings(withParameterClaims(await parseSource(input))),
};
