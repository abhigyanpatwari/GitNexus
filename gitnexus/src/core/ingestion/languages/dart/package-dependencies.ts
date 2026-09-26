import type { ParsedFile } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import { generateId } from '../../../../lib/utils.js';
import type { DartPackageConfig } from './package-config.js';
import { dartPackageImportName } from './package-uri.js';

const MAX_DEPENDENCIES = 100_000;
const MAX_TRAVERSALS = 1_000_000;

/** Incremental metadata. Not an initialization edge — excluded from cycle checks. */
export const DART_PACKAGE_IDENTITY_REASON = 'dart-scope: package identity dependency';

/** Package identity is an input dependency, including unresolved/ambiguous imports. */
export function emitDartPackageDependencies(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  resolutionConfig?: unknown,
): void {
  const config = resolutionConfig as DartPackageConfig | undefined;
  if (!config?.manifestsByName) return;

  const consumersByManifest = new Map<string, Set<string>>();
  let dependencyCount = 0;
  const addConsumer = (consumers: Set<string>, sourceId: string): void => {
    if (consumers.has(sourceId)) return;
    if (++dependencyCount > MAX_DEPENDENCIES) {
      throw new Error(
        'Dart package dependency limit exceeded; narrow the workspace with .gitnexusignore.',
      );
    }
    consumers.add(sourceId);
  };
  const fileIds = new Set(parsedFiles.map((parsed) => generateId('File', parsed.filePath)));
  for (const parsed of parsedFiles) {
    const sourceId = generateId('File', parsed.filePath);
    if (!graph.getNode(sourceId)) continue;
    for (const imp of parsed.parsedImports) {
      const raw = imp.targetRaw;
      if (typeof raw !== 'string') continue;
      const packageName = dartPackageImportName(raw);
      if (packageName === null) continue;
      for (const manifest of config.manifestsByName.get(packageName) ?? []) {
        let consumers = consumersByManifest.get(manifest);
        if (!consumers) consumersByManifest.set(manifest, (consumers = new Set()));
        addConsumer(consumers, sourceId);
      }
    }
  }
  if (consumersByManifest.size === 0) return;

  // New manifests are not present in the old DB's importer closure. Carry
  // identity dependencies through the freshly resolved imports as well, so
  // one-hop incremental boundary expansion rewrites downstream consumers.
  const importers = new Map<string, Set<string>>();
  for (const edge of graph.iterRelationshipsByType('IMPORTS')) {
    if (!fileIds.has(edge.sourceId) || !fileIds.has(edge.targetId)) continue;
    let sources = importers.get(edge.targetId);
    if (!sources) importers.set(edge.targetId, (sources = new Set()));
    sources.add(edge.sourceId);
  }
  let traversals = 0;
  for (const [manifest, consumers] of consumersByManifest) {
    const targetId = generateId('File', manifest);
    if (!graph.getNode(targetId)) {
      throw new Error(`Dart package manifest is missing from the indexed file set: ${manifest}`);
    }
    // Set iteration visits additions and deduplicates cycles without recursion.
    for (const sourceId of consumers) {
      for (const importer of importers.get(sourceId) ?? []) {
        if (++traversals > MAX_TRAVERSALS) {
          throw new Error(
            'Dart package dependency traversal limit exceeded; narrow the workspace with .gitnexusignore.',
          );
        }
        addConsumer(consumers, importer);
      }
    }
  }
  // Validate the complete closure before publishing any dependency edges.
  for (const [manifest, consumers] of consumersByManifest) {
    const targetId = generateId('File', manifest);
    for (const sourceId of consumers) {
      graph.addRelationship({
        id: generateId('IMPORTS', `${sourceId}->${targetId}`),
        sourceId,
        targetId,
        type: 'IMPORTS',
        confidence: 1,
        reason: DART_PACKAGE_IDENTITY_REASON,
      });
    }
  }
}
