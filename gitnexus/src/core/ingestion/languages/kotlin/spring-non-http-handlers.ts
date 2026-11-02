import { makeScopeId } from 'gitnexus-shared';
import {
  createSpringNonHttpHandlerMetadataAttacher,
  hasSpringNonHttpHandlerRelevantAnnotation,
  type SpringNonHttpHandlerAnnotationFact,
  type SpringNonHttpHandlerFact,
} from '../../frameworks/spring/non-http-handlers.js';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { getKotlinSpringNonHttpHandlerFacts } from './capture-side-channel.js';
import { isKotlinPackageSiblingVisibilityIncomplete } from './package-siblings.js';
import { kotlinSpringAnnotationFacts } from './spring-di.js';

export type KotlinSpringNonHttpHandlerFact =
  SpringNonHttpHandlerFact<SpringNonHttpHandlerAnnotationFact>;

/**
 * Local names that reach a handler annotation only through an import alias.
 *
 * `import ...event.EventListener as SpringEvent` makes `@SpringEvent` a handler
 * annotation whose simple name matches nothing, which is why the CALLABLE
 * capture below has no name prefilter. The alias is not a mystery at capture
 * time, though: the import header states both the local name and the FQN it
 * stands for, so the same relevance predicate that Java uses on the annotation
 * name can be applied to the IMPORTED name and the answer carried back to the
 * alias. That recovers a name-based decision without discarding aliases.
 *
 * Only aliases are collected. A plain or wildcard import leaves the annotation
 * written under its own simple name, which the direct check already sees.
 */
function aliasedHandlerAnnotationNames(classNode: SyntaxNode): ReadonlySet<string> {
  let root: SyntaxNode = classNode;
  while (root.parent !== null) root = root.parent;

  const headers: SyntaxNode[] = [];
  for (const child of root.namedChildren) {
    if (child.type === 'import_header') headers.push(child);
    else if (child.type === 'import_list') {
      for (const header of child.namedChildren) {
        if (header.type === 'import_header') headers.push(header);
      }
    }
  }

  const aliases = new Set<string>();
  for (const header of headers) {
    const alias = header.namedChildren
      .find((child) => child.type === 'import_alias')
      ?.namedChildren.find((child) => child.type === 'type_identifier')
      ?.text.trim();
    if (alias === undefined || alias.length === 0) continue;
    const imported = header.namedChildren.find((child) => child.type === 'identifier')?.text.trim();
    if (imported === undefined || imported.length === 0) continue;
    if (hasSpringNonHttpHandlerRelevantAnnotation([{ name: imported }])) aliases.add(alias);
  }
  return aliases;
}

/**
 * Capture annotated callables conservatively. A simple-name prefilter would
 * discard Kotlin aliases (for example, `EventListener as SpringEvent`) before
 * the post-import resolver can map the local name back to its annotation FQN.
 *
 * That conservatism applies to the CALLABLE — every annotated function still
 * produces a fact, whatever its annotations are named. It does NOT have to
 * apply to the arguments: reading them unconditionally charged every
 * `@Transactional` and `@Deprecated` in a repository for data no consumer
 * reads, and unlike the callable itself an argument list can be fetched on
 * evidence. Arguments are therefore read in a second pass, for callables that
 * either carry a handler annotation under its own name or use a local name this
 * file aliased to one — the same two-pass shape as Java, with the alias set
 * standing in for the name prefilter Kotlin cannot use.
 *
 * Measured on 200 annotated NON-handler functions in one file: the side-channel
 * payload was 41069 bytes before arguments existed, 78797 with them read
 * unconditionally, and 41069 again with this pass — byte for byte what it cost
 * before the feature. The 200-handler equivalent pays 58649, which is the
 * argument text the consumer asked for.
 */
export function captureKotlinSpringNonHttpHandlerFacts(
  classNode: SyntaxNode,
  filePath: string,
): KotlinSpringNonHttpHandlerFact[] {
  const facts: KotlinSpringNonHttpHandlerFact[] = [];
  const body = classNode.namedChildren.find(
    (child) => child.type === 'class_body' || child.type === 'enum_class_body',
  );
  if (body === undefined) return facts;
  // Read the import headers at most once per class, and only when some callable
  // actually fails the direct name check.
  let aliasedHandlerNames: ReadonlySet<string> | undefined;
  for (const member of body.namedChildren) {
    if (member.type !== 'function_declaration') continue;
    const named = kotlinSpringAnnotationFacts(member);
    if (named.length === 0) continue;
    let readArguments = hasSpringNonHttpHandlerRelevantAnnotation(named);
    if (!readArguments) {
      aliasedHandlerNames ??= aliasedHandlerAnnotationNames(classNode);
      readArguments = named.some(
        (annotation) => aliasedHandlerNames?.has(annotation.name) === true,
      );
    }
    const annotations = readArguments
      ? kotlinSpringAnnotationFacts(member, { includeArguments: true })
      : named;
    if (annotations.length === 0) continue;
    const ownerRange = nodeToCapture('@spring-non-http-handler.owner', member).range;
    facts.push({
      ownerScopeId: makeScopeId({ filePath, range: ownerRange, kind: 'Function' }),
      ownerFilePath: filePath,
      ownerRange,
      annotations: annotations.map((annotation) => ({
        name: annotation.name,
        ...(annotation.useSiteTarget === undefined
          ? {}
          : { useSiteTarget: annotation.useSiteTarget }),
        ...(annotation.args === undefined ? {} : { args: annotation.args }),
      })),
    });
  }
  return facts;
}

export const attachKotlinSpringNonHttpHandlerMetadata = createSpringNonHttpHandlerMetadataAttacher({
  getFacts: getKotlinSpringNonHttpHandlerFacts,
  isPackageVisibilityIncomplete: isKotlinPackageSiblingVisibilityIncomplete,
});
