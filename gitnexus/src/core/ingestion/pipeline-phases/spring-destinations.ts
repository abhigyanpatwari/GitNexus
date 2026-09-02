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
 * node keyed by what it names, with the callable pointing at it, down to the
 * detail that the key pairs the address with the one dimension that can make
 * two same-named things different places: the method for a Route, the broker
 * here.
 *
 * ── THE KEYING RULE, WHICH IS THE POINT OF THE PHASE ─────────────────────
 *
 * A `Destination` connects two services precisely because both sides mint the
 * SAME node id from the SAME address on the SAME broker. That is the whole
 * value, and it is also the whole hazard: an address that could not be resolved
 * must never be allowed to key a node.
 *
 *     resolved    id = generateId('Destination', `<broker> <address>`)  `address` present
 *     unresolved  id = generateId('Destination', <site>)                `address` ABSENT
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
 * guarantee survives being read back out of the database. The unresolved
 * spelling is kept in `name`, for a human reading the node.
 *
 * The BROKER is part of the connecting key rather than a reason to withdraw
 * one — see {@link destinationNodeKey}, which owns that argument and the
 * evidence for it. Two brokers claiming one address is therefore an ordinary
 * two-node situation here, exactly like `GET /x` and `POST /x`, and this phase
 * needs no vocabulary for it: nothing is being taken away, so there is nothing
 * to diagnose.
 *
 * `name` must never be used to join two destinations, and nothing does — but
 * the stronger claim that nothing reads it at all would be false. `Destination`
 * is in `VALID_NODE_LABELS`, and `mcp/local/local-backend.ts` resolves a
 * symbol with an unlabeled `WHERE n.name = $symName`, so a destination can be
 * returned by name like any other node. That is a lookup, not a join: it
 * matches a caller-supplied string against one node, never one destination
 * against another, so it cannot manufacture the connection this phase exists to
 * prevent.
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
  parseSpringStringLiteral,
  resolveSpringDestination,
  selectConsumerDestinationArguments,
  selectProducerDestinationArguments,
  type SpringDestinationCandidate,
  type SpringDestinationRefusal,
  type SpringDestinationResolution,
  type SpringDestinationSelection,
} from '../frameworks/spring/destinations.js';
import { destinationNodeKey } from '../destination-key.js';
import { getProviderForFile } from '../languages/index.js';
import { isDev } from '../utils/env.js';
import type { ModuleConstants } from '../route-extractors/constant-resolver.js';
import type { ParseOutput } from './parse.js';
import type { PipelineContext, PipelinePhase, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';

export interface SpringDestinationsOutput {
  /** Destination nodes keyed by `(broker, address)`, and which therefore
   *  connect to every other site that named the same address on the same
   *  broker. */
  readonly resolvedDestinations: number;
  /** Destination nodes keyed by source location, and therefore unable to
   *  connect: the address did not resolve. */
  readonly unresolvedDestinations: number;
  /** CONSUMES_FROM + PUBLISHES_TO edges emitted. */
  readonly edges: number;
  /**
   * Every refusal, counted by reason. This is the phase's real measure: the
   * feature is judged on the unresolved FRACTION, and a silent skip would hide
   * exactly the number that says whether it works.
   */
  readonly refusalsByReason: Readonly<Record<string, number>>;
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
  /** Owner callable's scope id. Unique per callable even when the range is
   *  absent, which is the only reason an unresolved key is site-unique on the
   *  handler side — see {@link destinationNodeId}. */
  readonly ownerScopeId: string;
  readonly candidate: SpringDestinationCandidate;
  readonly resolution: SpringDestinationResolution;
}

/**
 * Identity for a destination node.
 *
 * The connecting key is `(broker, address)` and nothing else — not the file,
 * not the site. That is what lets a publisher in one module and a subscriber in
 * another meet on one node, which is the entire point, and it is minted by the
 * framework-neutral {@link destinationNodeKey} so a non-Spring producer can mint
 * the same identity without importing anything Spring.
 *
 * The broker is IN that key rather than a reason to withhold one. The argument
 * for it, including the inferred-broker objection and why the previous rule was
 * worse, lives on `destinationNodeKey` — one copy, next to the code that
 * decides it.
 *
 * The site key has to identify the site EXACTLY. It carries the file path, so
 * no second file can ever produce it — that is the cross-repository guarantee,
 * and nothing added below can weaken it. Everything else in the key is there to
 * keep two sites inside ONE file apart, which is the same false identity at a
 * smaller scale:
 *
 *   - the owner SCOPE ID, because two callables can start on the same line and
 *     because `ownerRange` is optional on a handler fact — keyed on the line
 *     alone, a file whose handlers carried no range collapsed every consumer in
 *     it onto line 0;
 *   - the full owner RANGE, which separates two sites the scope id cannot (a
 *     scope id is stable, but two callables that share one are still two
 *     callables);
 *   - the raw TEXT plus argument and element position, because two publishes to
 *     two different placeholders inside one method share the owner entirely.
 *
 * The residual: two publishes with identical text at identical argument
 * positions inside ONE callable share a node. They are indistinguishable to
 * this phase — a producer fact carries the owner's range, not the call's — and
 * merging two publishes of the same unreadable address from one method is the
 * one collapse that asserts nothing false about anybody.
 */
function destinationNodeId(site: DestinationSite): string {
  if (site.resolution.kind === 'resolved') {
    return generateId(
      'Destination',
      destinationNodeKey(site.candidate.broker, site.resolution.address),
    );
  }
  const { candidate, ownerRange } = site;
  const position =
    ownerRange === undefined
      ? 'no-range'
      : `${ownerRange.startLine}:${ownerRange.startCol}:${ownerRange.endLine}:${ownerRange.endCol}`;
  return generateId(
    'Destination',
    [
      site.filePath,
      site.ownerScopeId,
      position,
      candidate.role,
      candidate.source,
      candidate.argIndex,
      candidate.elementIndex,
      candidate.rawText,
    ].join(':'),
  );
}

/**
 * Display spelling for a destination's `name`.
 *
 * A resolved destination's `name` is its address, bare. An unresolved one keeps
 * the source text — but unquoted, so the two are spelled the same way. Keeping
 * the quotes on one and not the other made the same value read differently
 * depending on whether it resolved, for no gain to the human the property
 * exists for.
 */
function destinationDisplayName(rawText: string): string {
  return parseSpringStringLiteral(rawText) ?? rawText.trim();
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
      // The owning language's capability, not its name. In an interpolating
      // language `"orders-$env"` is a runtime template rather than an address
      // and `"${app.topic}"` is a template rather than a Spring placeholder;
      // the resolver needs to know which regime it is in, and this phase must
      // not learn which language that is (AGENTS.md — shared ingestion code
      // plugs language behaviour in through provider hooks).
      const interpolatesStringLiterals = provider?.interpolatesStringLiterals === true;
      const record = (
        selection: SpringDestinationSelection,
        ownerScopeId: string,
        ownerRange: Range | undefined,
      ): void => {
        for (const refusal of selection.refusals) countRefusal(refusal.reason);
        for (const candidate of selection.candidates) {
          const resolution = resolveSpringDestination(candidate, {
            constant,
            interpolatesStringLiterals,
          });
          if (resolution.kind === 'unresolved') countRefusal(resolution.reason);
          sites.push({
            filePath,
            ...(ownerRange === undefined ? {} : { ownerRange }),
            ownerScopeId,
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
          record(selection, String(handler.ownerScopeId), handler.ownerRange);
        }
      }
      for (const producer of facts.producers) {
        record(
          selectProducerDestinationArguments(producer),
          String(producer.ownerScopeId),
          producer.ownerRange,
        );
      }
    }
    if (sites.length === 0) {
      return {
        resolvedDestinations: 0,
        unresolvedDestinations: 0,
        edges: 0,
        refusalsByReason,
        configKeyLinks: 0,
      };
    }

    // ── Emit ──────────────────────────────────────────────────────────────
    //
    // A single pass. There used to be a preliminary one that looked for an
    // address claimed by two brokers so the emit could withdraw it from both —
    // the disagreement had to be known before the first node was minted,
    // because re-keying a node after it has grown an edge is the kind of work
    // that is easy to get half-right. With the broker in the key there is
    // nothing to decide up front: each site's identity is a function of that
    // site alone, so no other site can change it and no lookahead is needed.
    const owners = callableOwnersByRange(ctx.graph);
    const configProperties = springConfigPropertiesByKey(ctx.graph);
    const linkedConfigKeys = new Set<string>();
    let resolvedDestinations = 0;
    let unresolvedDestinations = 0;
    let edges = 0;
    let configKeyLinks = 0;

    for (const site of sites) {
      const { candidate, resolution } = site;
      // The one predicate the rest of the loop is written against: may this
      // site's node be keyed by its address, and therefore meet another site on
      // it? Exactly when the address resolved. Otherwise the node gets its
      // location-based key, no `address` property, and its own file.
      const connects = resolution.kind === 'resolved';
      const nodeId = destinationNodeId(site);
      const isNew = ctx.graph.getNode(nodeId) === undefined;
      if (isNew) {
        if (connects) resolvedDestinations += 1;
        else unresolvedDestinations += 1;
        ctx.graph.addNode({
          id: nodeId,
          label: 'Destination',
          properties: {
            // For a resolved address this equals `address`. For an unresolved
            // one it is the UNRESOLVED SPELLING, unquoted, kept so a human
            // reading the node sees what the source actually said. Either way
            // it is kept out of `address` unless the node connects, so nothing
            // joins on it.
            //
            // Note that `name` is the ADDRESS, not the node key: two nodes on
            // one spelling over two brokers share a `name` and differ by id.
            // That is deliberate — `name` is for a human, and telling them the
            // topic is called `kafka orders` would be a lie.
            name:
              resolution.kind === 'resolved'
                ? resolution.address
                : destinationDisplayName(candidate.rawText),
            // A CONNECTING destination carries NO location, and that is load
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
            // The cost used to be the opposite error — a destination whose
            // last referrer was deleted lingered as an edgeless orphan until a
            // full rebuild — and that is no longer paid. Because the per-file
            // predicate can neither remove such a node nor admit a newly
            // introduced one, the whole layer is instead delete-alled
            // (`deleteAllDestinations`) and re-included graph-wide
            // (`isGraphWideNode`) on every incremental writeback. Both halves
            // move together: the delete without the re-include drops the layer,
            // and the re-include without the delete duplicates every edge.
            //
            // A NON-CONNECTING destination is the opposite case — it belongs to
            // exactly one site, its id already says so, and it SHOULD be
            // deleted and re-created with its file.
            // `''`, not absent: `NodeProperties.filePath` is required, and the
            // empty string is the established spelling for a node with no file
            // (`pipeline-phases/communities.ts` does the same). It is equally
            // unmatchable by the `IN` predicate and the CSV writes it as an
            // empty field, which COPY loads as NULL.
            ...(connects
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
            // `address` IS THE JOIN KEY and is written ONLY when the node
            // connects. See the module header: an absent property cannot match
            // another absent property, so the structural guarantee survives
            // being read back out of the database.
            //
            // `resolution` always says how the node got here — the provenance
            // of a real address, or the named refusal that stopped one. Every
            // value in the column now comes from the resolver's own closed
            // vocabulary, because the phase no longer has a verdict of its own
            // to record: nothing is withdrawn here.
            ...(resolution.kind === 'resolved'
              ? { address: resolution.address, resolution: resolution.via }
              : { resolution: resolution.reason }),
            ...(resolution.kind === 'unresolved' && resolution.configKey !== undefined
              ? { configKey: resolution.configKey }
              : {}),
            // The `${key:default}` default text. Kept because the source wrote
            // it and throwing it away would make an overridable default
            // indistinguishable from a bare `${key}`; NOT an address and never
            // part of the id, because configuration can override it and this
            // graph cannot see whether it did.
            ...(resolution.kind === 'unresolved' && resolution.configDefault !== undefined
              ? { configDefault: resolution.configDefault }
              : {}),
            broker: candidate.broker,
          },
        });
      }

      // Link a placeholder's KEY to the configuration entries that could supply
      // it — `${key}` and `${key:default}` alike, since a default changes
      // nothing about where the real value comes from. This is PROVENANCE, not
      // resolution: the node stays unresolved and keeps its location-based id
      // even when Property nodes are found, because the VALUE is still not in
      // the graph and letting a Property sighting upgrade the node would
      // reintroduce the false connection the keying rule exists to prevent.
      // `${}` names no key at all and reports none, so nothing is ever looked
      // up under the empty string.
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

    if (isDev) {
      logger.info(
        `📮 Spring destinations: ${resolvedDestinations} resolved, ${unresolvedDestinations} unresolved, ${edges} edges`,
      );
    }

    return {
      resolvedDestinations,
      unresolvedDestinations,
      edges,
      refusalsByReason,
      configKeyLinks,
    };
  },
};
