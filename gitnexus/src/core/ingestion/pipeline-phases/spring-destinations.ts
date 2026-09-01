/**
 * Phase: springDestinations
 *
 * Materializes Spring async messaging as graph structure: a `Destination` node
 * per broker address, `CONSUMES_FROM` from every `@KafkaListener`-family
 * handler, and `PUBLISHES_TO` from every messaging-template publish. The
 * inbound and outbound facts are captured during parse and survive the parse
 * cache; until now nothing read them.
 *
 * Shaped after `Route` + `HANDLES_ROUTE` in `routes.ts` — a framework overlay
 * node keyed by the address it names, with the callable pointing at it.
 *
 * ── THE KEYING RULE, WHICH IS THE POINT OF THE PHASE ─────────────────────
 *
 * A `Destination` connects two services precisely because both sides mint the
 * SAME node id from the SAME address. That is the whole value, and it is also
 * the whole hazard: an address that could not be resolved must never be
 * allowed to key a node.
 *
 *     resolved    id = generateId('Destination', address)   `address` present
 *     unresolved  id = generateId('Destination', <site>)    `address` ABSENT
 *
 * Two unrelated services that each merely write `@KafkaListener(topics =
 * "${app.topic}")` have said nothing whatever about each other. Keyed on the
 * placeholder text they would land on one node and READ AS CONNECTED, in a
 * report, as a fact. A missing edge is visible as a gap; a false one is not.
 *
 * A status property would not have prevented this, and neither would a second
 * label: the id is what merges the nodes, and both sides would still compute
 * the same id. Only the KEY prevents it, so an unresolved destination is keyed
 * by its source LOCATION — a value no second file can produce.
 *
 * The same rule governs the `address` PROPERTY, which is the join key a
 * cross-repository pass would match on. It is written only when resolved. An
 * absent property cannot match another absent property, so the structural
 * guarantee survives being read back out of the database. The placeholder text
 * is kept in `name`, for a human reading the node; `name` must never be joined
 * on, and nothing in this repository does.
 *
 * @deps    parse, scopeResolution, springConfig
 * @reads   Spring messaging capture facts, Method/Function nodes, Property nodes
 * @writes  Destination nodes; CONSUMES_FROM / PUBLISHES_TO / USES edges
 */

import type { GraphNode, Range } from 'gitnexus-shared';
import { generateId } from '../../../lib/utils.js';
import { logger } from '../../logger.js';
import type { KnowledgeGraph } from '../../graph/types.js';
import { SPRING_CONFIG_DESCRIPTION } from '../frameworks/spring/config-bindings.js';
import {
  resolveSpringDestination,
  selectConsumerDestinationArguments,
  selectProducerDestinationArguments,
  type SpringDestinationBroker,
  type SpringDestinationCandidate,
  type SpringDestinationRefusal,
  type SpringDestinationResolution,
  type SpringDestinationSelection,
} from '../frameworks/spring/destinations.js';
import { getProviderForFile } from '../languages/index.js';
import { isDev } from '../utils/env.js';
import type { ModuleConstants } from '../route-extractors/constant-resolver.js';
import type { ParseOutput } from './parse.js';
import type { PipelineContext, PipelinePhase, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';

export interface SpringDestinationsOutput {
  /** Destination nodes whose address resolved, and which therefore connect. */
  readonly resolvedDestinations: number;
  /** Destination nodes keyed by source location because nothing resolved. */
  readonly unresolvedDestinations: number;
  /** CONSUMES_FROM + PUBLISHES_TO edges emitted. */
  readonly edges: number;
  /**
   * Every refusal, counted by reason. This is the phase's real measure: the
   * feature is judged on the unresolved FRACTION, and a silent skip would hide
   * exactly the number that says whether it works.
   */
  readonly refusalsByReason: Readonly<Record<string, number>>;
  /**
   * Addresses seen with more than one broker. Recorded, never merged away and
   * never dropped: the broker is a guess made from a receiver's NAME, and a
   * wrongly guessed broker must not be allowed to break a real connection
   * between a publisher and a subscriber that agree on the address.
   */
  readonly brokerConflicts: number;
  /** Destination -> Property provenance edges for `${key}` placeholders. */
  readonly configKeyLinks: number;
}

/**
 * Exact-range index of callable nodes, mirroring the bridge in
 * `non-http-handlers.ts`.
 *
 * A duplicate range maps to `null` rather than to one of its nodes: two
 * callables sharing a span means the index cannot say which one publishes, and
 * attributing the publish to an arbitrary one of them is the failure this
 * phase is least able to detect afterwards. The File-level edge below is the
 * fallback, so a `null` here costs precision, not the fact.
 */
function callableOwnersByRange(graph: KnowledgeGraph): ReadonlyMap<string, GraphNode | null> {
  const owners = new Map<string, GraphNode | null>();
  for (const node of graph.iterNodes()) {
    if (
      (node.label !== 'Method' && node.label !== 'Function') ||
      typeof node.properties.filePath !== 'string'
    ) {
      continue;
    }
    const key = `${node.properties.filePath}\0${node.properties.startLine}\0${node.properties.endLine}`;
    owners.set(key, owners.has(key) ? null : node);
  }
  return owners;
}

/** Capture ranges are 1-based; graph nodes carry 0-based lines. */
function ownerKey(filePath: string, range: Range): string {
  return `${filePath}\0${range.startLine - 1}\0${range.endLine - 1}`;
}

/**
 * Spring configuration `Property` nodes grouped by KEY.
 *
 * Deliberately a multimap. `spring-config.ts` keys a Property node per FILE
 * (`spring-config:<file>:<key>`), so one key declared in `application.yml` and
 * again in `application-prod.yml` is TWO nodes. Linking to only the first would
 * silently pin a destination to an arbitrary profile. An EMPTY match set is
 * normal, not an error — a key may be supplied by an environment variable or a
 * config server and never appear in a checked-in file at all.
 */
function springConfigPropertiesByKey(graph: KnowledgeGraph): ReadonlyMap<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Property') continue;
    const description = node.properties.description;
    if (typeof description !== 'string' || !description.startsWith(SPRING_CONFIG_DESCRIPTION)) {
      continue;
    }
    const key = node.properties.name;
    if (typeof key !== 'string' || key === '') continue;
    const existing = byKey.get(key);
    if (existing === undefined) byKey.set(key, [node.id]);
    else existing.push(node.id);
  }
  return byKey;
}

/**
 * Fold a constant reference against the harvested repo constants, using the
 * owning provider's own fold when it declares one.
 *
 * Only providers that declare `extractModuleConstants` contribute to the table,
 * so a language that harvests nothing simply resolves nothing here and the
 * cascade records `unresolved-constant`. That is a countable gap, not a wrong
 * answer.
 */
function makeConstantResolver(
  filePath: string,
  repo: ReadonlyMap<string, ModuleConstants>,
): ((name: string) => string | null) | undefined {
  if (repo.size === 0) return undefined;
  const fold = getProviderForFile(filePath)?.foldRoutePathOperands;
  if (fold === undefined) return undefined;
  return (name: string): string | null => fold(filePath, [{ kind: 'ref', name }], repo);
}

interface DestinationSite {
  readonly filePath: string;
  /** Owner callable's capture range, when the fact carried one. */
  readonly ownerRange?: Range;
  readonly candidate: SpringDestinationCandidate;
  readonly resolution: SpringDestinationResolution;
}

/**
 * Identity for a destination node.
 *
 * The resolved key is the address and NOTHING else — not the broker, not the
 * file. That is what lets a publisher in one module and a subscriber in another
 * meet on one node, which is the entire point. The broker rides as a property
 * precisely so a mistaken broker guess cannot split a real pair.
 *
 * The unresolved key is the SITE. It carries the file path, so no second file
 * can ever produce it, which is the structural guarantee. It also carries the
 * raw text, because file plus owner line plus argument position is not by
 * itself unique — two publishes to two different placeholders inside one method
 * share all three, and merging those would be a false identity of exactly the
 * kind this key exists to prevent, merely at a smaller scale. Adding the text
 * cannot weaken the cross-file guarantee: the file path is still in the key.
 */
function destinationNodeId(site: DestinationSite): string {
  if (site.resolution.kind === 'resolved') {
    return generateId('Destination', site.resolution.address);
  }
  const { candidate } = site;
  const line = site.ownerRange?.startLine ?? 0;
  return generateId(
    'Destination',
    [
      site.filePath,
      line,
      candidate.role,
      candidate.source,
      candidate.argIndex,
      candidate.elementIndex,
      candidate.rawText,
    ].join(':'),
  );
}

function edgeReason(candidate: SpringDestinationCandidate): string {
  const argument = candidate.argName ?? `arg${candidate.argIndex}`;
  const element = `${argument}[${candidate.elementIndex}]`;
  const exchange = candidate.exchange === undefined ? '' : ` exchange=${candidate.exchange}`;
  return `spring-${candidate.source}:${element}${exchange}`;
}

export const springDestinationsPhase: PipelinePhase<SpringDestinationsOutput> = {
  name: 'springDestinations',
  // `parse` supplies the file list and the harvested constants; `scopeResolution`
  // must have run so the Method/Function nodes exist AND so each provider's
  // `applyCaptureSideChannel` has restored the messaging facts onto the main
  // thread; `springConfig` must have run so the Property nodes a `${key}`
  // placeholder links to are already in the graph.
  deps: ['parse', 'scopeResolution', 'springConfig'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<SpringDestinationsOutput> {
    // `allPaths`, NOT `parsedFiles`. On any run with a storage path — which is
    // every run of the CLI — worker-produced ParsedFiles are flushed to a disk
    // store and `ParseOutput.parsedFiles` comes back EMPTY, with
    // scope-resolution streaming them back per language. Iterating it therefore
    // found nothing in production while every in-process test passed, because a
    // direct pipeline call has no storage path and keeps them in memory.
    //
    // The fact stores are keyed by file path and are populated by the same
    // streaming pass, so the path list is the right cursor for them anyway: it
    // does not care how the ParsedFile got to scope resolution.
    const { allPaths, moduleConstants } = getPhaseOutput<ParseOutput>(deps, 'parse');
    const refusalsByReason: Record<string, number> = {};
    const countRefusal = (reason: SpringDestinationRefusal): void => {
      refusalsByReason[reason] = (refusalsByReason[reason] ?? 0) + 1;
    };

    // ── Gather: facts → candidates → resolutions ──────────────────────────
    const sites: DestinationSite[] = [];
    for (const filePath of allPaths) {
      const provider = getProviderForFile(filePath);
      const facts = provider?.getSpringMessagingFacts?.(filePath);
      if (facts === undefined) continue;
      if (facts.handlers.length === 0 && facts.producers.length === 0) continue;

      // Built lazily and reused for the whole file: the fold state behind it is
      // per-call, but resolving the provider and checking the table is not free
      // and every candidate in the file wants the same closure.
      const constant = makeConstantResolver(filePath, moduleConstants);
      const record = (
        selection: SpringDestinationSelection,
        ownerRange: Range | undefined,
      ): void => {
        for (const refusal of selection.refusals) countRefusal(refusal.reason);
        for (const candidate of selection.candidates) {
          const resolution = resolveSpringDestination(candidate, { constant });
          if (resolution.kind === 'unresolved') countRefusal(resolution.reason);
          sites.push({
            filePath,
            ...(ownerRange === undefined ? {} : { ownerRange }),
            candidate,
            resolution,
          });
        }
      };

      for (const handler of facts.handlers) {
        for (const annotation of handler.annotations) {
          // A Kotlin use-site target describes a generated property element, not
          // the callable, so its arguments are not this handler's.
          if (annotation.useSiteTarget !== undefined) continue;
          const selection = selectConsumerDestinationArguments(annotation.name, annotation.args);
          if (selection === null) continue;
          record(selection, handler.ownerRange);
        }
      }
      for (const producer of facts.producers) {
        record(selectProducerDestinationArguments(producer), producer.ownerRange);
      }
    }
    if (sites.length === 0) {
      return {
        resolvedDestinations: 0,
        unresolvedDestinations: 0,
        edges: 0,
        refusalsByReason,
        brokerConflicts: 0,
        configKeyLinks: 0,
      };
    }

    // ── Emit ──────────────────────────────────────────────────────────────
    const owners = callableOwnersByRange(ctx.graph);
    const configProperties = springConfigPropertiesByKey(ctx.graph);
    const brokersByNode = new Map<string, Set<SpringDestinationBroker>>();
    const linkedConfigKeys = new Set<string>();
    let resolvedDestinations = 0;
    let unresolvedDestinations = 0;
    let edges = 0;
    let configKeyLinks = 0;

    for (const site of sites) {
      const { candidate, resolution } = site;
      const nodeId = destinationNodeId(site);
      const isNew = ctx.graph.getNode(nodeId) === undefined;
      if (isNew) {
        if (resolution.kind === 'resolved') resolvedDestinations += 1;
        else unresolvedDestinations += 1;
        ctx.graph.addNode({
          id: nodeId,
          label: 'Destination',
          properties: {
            // For a resolved destination this equals `address`. For an
            // unresolved one it is the UNRESOLVED SPELLING, kept so a human
            // reading the node sees what the source actually said — and kept
            // out of `address` so nothing joins on it.
            name: resolution.kind === 'resolved' ? resolution.address : candidate.rawText,
            // A RESOLVED destination carries NO location, and that is load
            // bearing rather than cosmetic.
            //
            // It is shared by every site that names the address, so no single
            // file identifies it — but more importantly, the incremental
            // writeback deletes by location: `deleteNodesForFiles` issues
            // `MATCH (n:<table>) WHERE n.filePath IN [...] DETACH DELETE n` for
            // every changed file. Stamping the first-seen file here would make
            // a shared destination collateral damage whenever THAT file
            // changed, and DETACH DELETE would take its edges from every OTHER
            // file with it. Those files are not in the write set, so their
            // edges would never be rebuilt: a publisher and a subscriber that
            // genuinely agree on an address would silently stop being
            // connected, depending on which of them the indexer happened to
            // walk first. Omitting the property makes the `IN` predicate unable
            // to match, so the node survives the writeback and every referrer
            // keeps its edge.
            //
            // The cost is the opposite error, and it is the one worth taking: a
            // destination whose last referrer is deleted lingers with no edges
            // until a full rebuild. That is additive and visible, where the
            // other is subtractive and silent.
            //
            // An UNRESOLVED destination is the opposite case — it belongs to
            // exactly one site, its id already says so, and it SHOULD be
            // deleted and re-created with its file.
            // `''`, not absent: `NodeProperties.filePath` is required, and the
            // empty string is the established spelling for a node with no file
            // (`pipeline-phases/communities.ts` does the same). It is equally
            // unmatchable by the `IN` predicate and the CSV writes it as an
            // empty field, which COPY loads as NULL.
            ...(resolution.kind === 'resolved'
              ? { filePath: '' }
              : {
                  filePath: site.filePath,
                  ...(site.ownerRange === undefined
                    ? {}
                    : {
                        startLine: site.ownerRange.startLine - 1,
                        endLine: site.ownerRange.endLine - 1,
                      }),
                }),
            // WRITTEN ONLY WHEN RESOLVED. See the module header: this is the
            // cross-repository join key, and an absent property cannot match.
            ...(resolution.kind === 'resolved'
              ? { address: resolution.address, resolution: resolution.via }
              : { resolution: resolution.reason }),
            ...(resolution.kind === 'unresolved' && resolution.configKey !== undefined
              ? { configKey: resolution.configKey }
              : {}),
            broker: candidate.broker,
          },
        });
      }

      // Broker agreement is tracked per NODE, so it can only ever be raised for
      // a resolved destination — an unresolved one is keyed by site and cannot
      // be reached twice.
      let brokers = brokersByNode.get(nodeId);
      if (brokers === undefined) {
        brokers = new Set();
        brokersByNode.set(nodeId, brokers);
      }
      brokers.add(candidate.broker);

      // Link an unresolvable `${key}` to the configuration keys that could
      // supply it. This is PROVENANCE, not resolution: the node stays
      // unresolved and keeps its location-based id even when Property nodes are
      // found, because the VALUE is still not in the graph and letting a
      // Property sighting upgrade the node would reintroduce the false
      // connection the keying rule exists to prevent.
      if (resolution.kind === 'unresolved' && resolution.configKey !== undefined) {
        for (const propertyId of configProperties.get(resolution.configKey) ?? []) {
          const linkId = `${nodeId}->${propertyId}`;
          if (linkedConfigKeys.has(linkId)) continue;
          linkedConfigKeys.add(linkId);
          ctx.graph.addRelationship({
            id: generateId('USES', linkId),
            sourceId: nodeId,
            targetId: propertyId,
            type: 'USES',
            confidence: 1.0,
            reason: `spring-destination:config-key:${resolution.configKey}`,
          });
          configKeyLinks += 1;
        }
      }

      // One edge per address. An array-valued `topics` really does subscribe to
      // several places, and each gets its own edge rather than a group node, so
      // "who reads from `a`" stays one hop. `reason` carries which argument and
      // which element it came from.
      const type = candidate.role === 'consumer' ? 'CONSUMES_FROM' : 'PUBLISHES_TO';
      const owner =
        site.ownerRange === undefined
          ? undefined
          : (owners.get(ownerKey(site.filePath, site.ownerRange)) ?? undefined);
      // Prefer the callable; fall back to its File when the owner is unknown or
      // ambiguous. Unlike `routes.ts` this does NOT emit both — there is no
      // legacy File-level consumer to keep working here, and a second edge per
      // publish would double the async surface of the graph for no query.
      const sourceId = owner?.id ?? generateId('File', site.filePath);
      if (owner === undefined && ctx.graph.getNode(sourceId) === undefined) continue;
      const reason = edgeReason(candidate);
      ctx.graph.addRelationship({
        id: generateId(type, `${sourceId}->${nodeId}:${reason}`),
        sourceId,
        targetId: nodeId,
        type,
        confidence: 1.0,
        reason,
      });
      edges += 1;
    }

    // ── One address, two brokers ──────────────────────────────────────────
    let brokerConflicts = 0;
    for (const [nodeId, brokers] of brokersByNode) {
      if (brokers.size < 2) continue;
      brokerConflicts += 1;
      const node = ctx.graph.getNode(nodeId);
      if (node === undefined) continue;
      // Neither merged away nor dropped. The broker was inferred from a
      // receiver's NAME (see `message-producers.ts`), so a disagreement is far
      // more likely to be a bad guess than two real brokers sharing an address
      // — and dropping the node on that suspicion would delete a connection the
      // two sides genuinely agree on. The disagreement is recorded instead, in
      // full, so a reader can see it and a query can filter on it.
      node.properties.brokerConflict = [...brokers].sort().join(',');
    }

    if (isDev) {
      logger.info(
        `📮 Spring destinations: ${resolvedDestinations} resolved, ${unresolvedDestinations} unresolved, ${edges} edges` +
          (brokerConflicts > 0 ? `, ${brokerConflicts} broker conflict(s)` : ''),
      );
    }

    return {
      resolvedDestinations,
      unresolvedDestinations,
      edges,
      refusalsByReason,
      brokerConflicts,
      configKeyLinks,
    };
  },
};
