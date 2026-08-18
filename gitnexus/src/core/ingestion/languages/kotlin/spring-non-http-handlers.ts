import { makeScopeId } from 'gitnexus-shared';
import {
  createSpringNonHttpHandlerMetadataAttacher,
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
 * Capture annotated callables conservatively. A simple-name prefilter would
 * discard Kotlin aliases (for example, `EventListener as SpringEvent`) before
 * the post-import resolver can map the local name back to its annotation FQN.
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
  for (const member of body.namedChildren) {
    if (member.type !== 'function_declaration') continue;
    const annotations = kotlinSpringAnnotationFacts(member);
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
      })),
    });
  }
  return facts;
}

export const attachKotlinSpringNonHttpHandlerMetadata = createSpringNonHttpHandlerMetadataAttacher({
  getFacts: getKotlinSpringNonHttpHandlerFacts,
  isPackageVisibilityIncomplete: isKotlinPackageSiblingVisibilityIncomplete,
});
