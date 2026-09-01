/**
 * Java language provider.
 *
 * Java uses named imports, JVM wildcard/member import resolution,
 * and a 'public' modifier-based export checker. Heritage uses
 * EXTENDS by default with implements-split MRO for multiple
 * interface implementation.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { javaClassConfig } from '../class-extractors/configs/jvm.js';
import { defineLanguage } from '../language-provider.js';
import type { AstFrameworkPatternConfig } from '../language-provider.js';
import { createLeadingDocDescriptionExtractor } from '../utils/ast-helpers.js';
import { javaTypeConfig } from '../type-extractors/jvm.js';
import { extractSpringRoutes, extractSpringTypes } from '../route-extractors/spring.js';
import {
  extractJavaModuleConstants,
  foldJavaOperands,
  isJavaConstantFile,
  prepareJavaRouteConstants,
} from '../route-extractors/java-const-resolver.js';
import { javaExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { javaImportConfig } from '../import-resolvers/configs/jvm.js';
import { JAVA_QUERIES } from '../tree-sitter-queries.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { javaCallConfig } from '../call-extractors/configs/jvm.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { javaConfig } from '../field-extractors/configs/jvm.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { javaVariableConfig } from '../variable-extractors/configs/jvm.js';
import { createJavaCfgVisitor } from '../cfg/visitors/java.js';
import { assertCloneable } from '../workers/clone-safety.js';
import { collectJavaCaptureSideChannel } from './java/capture-side-channel.js';
import type { SymbolDefinition } from 'gitnexus-shared';
import {
  javaRecordMethodExtractor,
  shouldSkipJavaRecordComponentDefinition,
} from './java/record-components.js';
import { synthesizeLombokAccessors } from './java/lombok-synthesizer.js';
import {
  emitJavaScopeCaptures,
  interpretJavaImport,
  interpretJavaTypeBinding,
  javaBindingScopeFor,
  javaImportOwningScope,
  javaMergeBindings,
  javaReceiverBinding,
  javaArityCompatibility,
  resolveJavaImportTarget,
} from './java/index.js';
import { javaRuntimeSymbolStrategy } from './java/spring-actuator.js';

/**
 * Java names the platform owns, matched against a BARE IDENTIFIER — a dropped
 * receiver's chain base (`System` in `System.out.println(...)`) or the bare
 * spelling of that base's declared type (`String raw` ⇒ `raw.trim()`). This set
 * is the ONLY positive evidence `classifyReceiverOrigin` has that a lost edge
 * pointed OUTSIDE the analyzed program; without it every Java drop hedges
 * `impact()` down to `epistemic: 'lower-bound'` (#2744).
 *
 * TYPE names only — deliberately no method names, unlike `csharp.ts`. The same
 * hook also gates `type-env.ts`'s return-type inference and the #2545 free-call
 * shadow guard, both keyed on the CALLEE name; Java method names are camelCase
 * and collide constantly with user code (`format`, `add`, `get`, `run`, `apply`),
 * so listing them would silently suppress real in-program resolutions. Receiver
 * bases are what this pass actually asks about, and those are types.
 *
 * Inclusion rule, applied to every entry below: a name earns a place only when
 * (a) it plausibly appears as a receiver base or bare declared type, and (b) an
 * application defining its OWN type by that name is implausible. Rule (b) is the
 * hard gate. A name listed here can never be reported as in-program from the
 * fallthrough arm, so a wrong entry silently erases a real uncertainty signal,
 * whereas a missing one only costs a hedge — the failure is asymmetric, so this
 * set under-includes on purpose.
 *
 * Deliberately ABSENT, each for rule (b) — all are ordinary domain nouns an
 * application really does declare, and `Map`/`Set`/`Collection` are the worst
 * case because a same-package Java type needs no import to shadow them:
 *   `Map`, `Set`, `Collection`, `Stream`, `Number`, `Record`, `Error`.
 * (`Record` and `Error` also fail rule (a): `java.lang.Record` has no callable
 * static surface and application code never receives a bare `Error`.) `Void`
 * is absent on rule (a) alone — no `Void` instance exists to be a receiver.
 * `List` IS included: unlike `Map`, a hand-rolled `List` would fight the
 * near-universal `java.util.List` import, and it is the highest-value declared
 * receiver type in the language.
 */
const BUILT_INS: ReadonlySet<string> = new Set([
  // java.lang — implicitly imported, so these appear unqualified everywhere.
  'System',
  'String',
  'Integer',
  'Long',
  'Double',
  'Boolean',
  'Character',
  'Byte',
  'Short',
  'Float',
  'Object',
  'Math',
  'Thread',
  'Runtime',
  'Class',
  'StringBuilder',
  'StringBuffer',
  'Exception',
  'RuntimeException',
  'Throwable',
  'Iterable',
  'Comparable',
  'Runnable',
  'Enum',
  // java.util — an explicit import, but an unresolvable one: the import target
  // is outside the workspace, so it produces no in-program binding and the base
  // still reaches this set (verified against real scope extraction, not assumed).
  'Optional',
  'List',
  'Arrays',
  'Collections',
  'Objects',
]);

const orderJavaSameNameTypeCandidates = ({
  callSiteFilePath,
  candidates,
}: {
  readonly typeName: string;
  readonly callSiteFilePath: string;
  readonly candidates: readonly SymbolDefinition[];
}): readonly SymbolDefinition[] | null => {
  if (!callSiteFilePath.endsWith('.java')) return null;
  if (candidates.length <= 1) return null;
  const callerDir = splitDirectorySegments(callSiteFilePath);

  const scored = candidates.map((candidate, index) => ({
    candidate,
    index,
    score: sharedPrefixLength(callerDir, splitDirectorySegments(candidate.filePath)),
  }));
  const bestScore = Math.max(...scored.map((entry) => entry.score));
  // When all candidates tie, we have no structural signal to prefer one path.
  // Returning null keeps downstream ambiguity handling conservative.
  if (scored.every((entry) => entry.score === bestScore)) return null;

  const ordered = [...scored]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.candidate);
  return ordered;
};

const splitDirectorySegments = (filePath: string): string[] => {
  const normalized = filePath.replace(/\\/g, '/');
  // Remove empty segments from leading/trailing/multiple slashes, then drop filename.
  const segments = normalized.split('/').filter(Boolean);
  return segments.slice(0, -1);
};

const sharedPrefixLength = (left: readonly string[], right: readonly string[]): number => {
  const max = Math.min(left.length, right.length);
  let idx = 0;
  while (idx < max && left[idx] === right[idx]) idx += 1;
  return idx;
};

export const javaProvider = defineLanguage({
  id: SupportedLanguages.Java,
  extensions: ['.java'],
  entryPointPatterns: [/^do[A-Z]/, /^create[A-Z]/, /^build[A-Z]/, /Service$/],
  astFrameworkPatterns: [
    {
      framework: 'spring',
      entryPointMultiplier: 3.2,
      reason: 'spring-annotation',
      patterns: [
        '@RestController',
        '@Controller',
        '@GetMapping',
        '@PostMapping',
        '@RequestMapping',
      ],
    },
    {
      framework: 'jaxrs',
      entryPointMultiplier: 3.0,
      reason: 'jaxrs-annotation',
      patterns: ['@Path', '@GET', '@POST', '@PUT', '@DELETE'],
    },
  ] satisfies AstFrameworkPatternConfig[],
  treeSitterQueries: JAVA_QUERIES,
  typeConfig: javaTypeConfig,
  exportChecker: javaExportChecker,
  importResolver: createImportResolver(javaImportConfig),
  mroStrategy: 'implements-split',
  callExtractor: createCallExtractor(javaCallConfig),
  fieldExtractor: createFieldExtractor(javaConfig),
  methodExtractor: javaRecordMethodExtractor,
  shouldSkipDefinitionCapture: shouldSkipJavaRecordComponentDefinition,
  variableExtractor: createVariableExtractor(javaVariableConfig),
  classExtractor: createClassExtractor(javaClassConfig),
  runtimeSymbolStrategy: javaRuntimeSymbolStrategy,

  // ── Javadoc → description (issue #2270) ──
  descriptionExtractor: createLeadingDocDescriptionExtractor(),
  builtInNames: BUILT_INS,

  // ── RFC #909 Ring 3: scope-based resolution hooks ──
  emitScopeCaptures: emitJavaScopeCaptures,
  collectCaptureSideChannel: (filePath) => assertCloneable(collectJavaCaptureSideChannel(filePath)),

  // ── PDG: per-function CFG + def/use harvest (#2195 U4) ──
  cfgVisitor: createJavaCfgVisitor(),
  interpretImport: interpretJavaImport,
  interpretTypeBinding: interpretJavaTypeBinding,
  bindingScopeFor: javaBindingScopeFor,
  importOwningScope: javaImportOwningScope,
  mergeBindings: (_scope, bindings) => javaMergeBindings(bindings),
  receiverBinding: javaReceiverBinding,
  arityCompatibility: javaArityCompatibility,
  resolveImportTarget: resolveJavaImportTarget,
  orderSameNameTypeCandidates: orderJavaSameNameTypeCandidates,

  // ── Route extraction ──
  extractDecoratorRoutes: extractSpringRoutes,
  extractRouteInheritanceTypes: extractSpringTypes,

  synthesizeStructureMembers: synthesizeLombokAccessors,

  // ── #2980: constant harvest + qualified-ref fold for non-literal mapping
  // paths (`@PostMapping(ApiPaths.SAVE_V1)`) — kept behind provider hooks so
  // the shared ingestion layers stay language-agnostic. The heuristic is
  // SYNTAX-driven (field/import shape), never a class-name pattern: constant
  // classes are routinely named `ApiPaths`/`Routes`/`Paths`, which a
  // `*Constants`-style gate would silently drop (review round-2 High finding).
  extractModuleConstants: extractJavaModuleConstants,
  // One gate, shared with the group side's `prepareRepo` pre-pass so the two
  // subsystems cannot disagree about which files define constants (see
  // JAVA_CONSTANT_FILE_RE — the previous divergence dropped constant
  // INTERFACES on this side only, which cost the graph its Route nodes while
  // the group still published the contract).
  moduleConstantHeuristic: (content) =>
    isJavaConstantFile(content) ||
    // Class imports and static (including on-demand) imports can bind a
    // constant ref. Ordinary `import a.b.*;` is not a Java type import and is
    // not expanded by extractJavaModuleConstants, so it must not harvest.
    /\bimport\s+(?:static\s+[\w.]+(?:\.\*)?|[\w.]+)\s*;/.test(content),
  prepareRouteConstants: prepareJavaRouteConstants,
  foldRoutePathOperands: foldJavaOperands,
});
