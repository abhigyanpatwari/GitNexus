/**
 * Read AsyncAPI 3.x documents off disk and normalize their operations into
 * broker addresses.
 *
 * Deliberately OUTSIDE `frameworks/spring/`. An AsyncAPI document is a
 * published artifact, not a Spring one: it is emitted by generators across
 * Java, Kotlin, TypeScript, Go and Python toolchains, and it is written by hand
 * as often as it is generated. The entry criterion here is therefore the
 * DOCUMENT FORMAT — a root `asyncapi` key — and never the generator. Nothing in
 * this module may branch on `x-generator`, on a vendor extension, or on the
 * shape of an operation key: the moment it does, every service whose toolchain
 * spells things differently stops being read, and the failure is silent.
 *
 * ── WHY THIS IS WORTH READING AT ALL ──────────────────────────────────────
 *
 * A `@KafkaListener(topics = "${app.topic.in}")` names a configuration key, not
 * an address, and the address cascade correctly refuses to resolve it — two
 * services that merely wrote the same placeholder have said nothing about each
 * other. But the service's own published document states the address outright,
 * fully resolved, because the generator ran with the configuration applied.
 * That is a fact about the service that no amount of reading its source can
 * recover.
 *
 * ── WHAT THIS MODULE IS AFRAID OF ─────────────────────────────────────────
 *
 * Everything it emits becomes half of a JOIN KEY. A destination minted here
 * meets every other site in every other repository that names the same address
 * on the same broker — that is the whole value, and it is the whole hazard. A
 * missing destination is a visible gap; a wrong one is reported as a fact. So
 * the refusals below are not defensive clutter: each one is a case where the
 * document says something that LOOKS like an address and is not one, and where
 * accepting it would connect two services that have said nothing about each
 * other. The taxonomy is closed and countable for the same reason the source
 * cascade's is — a feature judged on its unresolved fraction needs the fraction
 * broken down by cause, or nobody can tell it what to go and fix.
 *
 * ── VERSION 2.x IS REFUSED, NOT MAPPED ────────────────────────────────────
 *
 * AsyncAPI 2.x describes a channel from the READER's point of view: `publish`
 * means "you may publish here", so the documenting application RECEIVES, and
 * `subscribe` means the application SENDS. Version 3.0 renamed these to the
 * application's own `receive` / `send`. Mapping 2.x naively therefore reverses
 * every direction in the async graph — and reverses it INVISIBLY, because both
 * roles still exist, every edge is still emitted, and the graph stays
 * connected. Nothing fails; the arrows simply point the wrong way.
 *
 * The inversion is one line to write and impossible to test against a real
 * corpus we do not have, and the 2.x wording confused implementers badly enough
 * that some generators emitted it backwards. So 2.x is refused under its own
 * countable reason instead. A silent skip would be indistinguishable from "this
 * service publishes no document", which is the one thing the count has to be
 * able to tell us: if the refusal tally shows 2.x documents in the field, the
 * inversion earns its way in with evidence behind it.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { brokerForBindingKey, brokerForProtocol, isNonDestinationBroker } from './protocol.js';

// `js-yaml` is CJS; the rest of this repository reaches it the same way
// (`pipeline-phases/spring-config.ts`, `import-resolvers/node-workspace-packages.ts`).
const _require = createRequire(import.meta.url);
const yaml = _require('js-yaml') as typeof import('js-yaml');

/**
 * A published document is data, not code, so it is parsed under the JSON
 * schema — the same choice `core/group/config-parser.ts` makes for `group.yaml`.
 * No custom tags, no timestamps, no `yes`/`no` booleans: an address is whatever
 * the document literally spells, and nothing may be coerced into another type
 * on the way in.
 */
const DOCUMENT_SCHEMA = yaml.JSON_SCHEMA;

/** Generous for a specification, small enough that a mistake is caught. */
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
/** Bounded so one pathological document cannot dominate a run. Counted against
 *  operations EXAMINED, not accepted: a document with a hundred thousand
 *  refused operations costs the same walk as one with a hundred thousand good
 *  ones, and a cap that only counts successes does not bound the work. */
const MAX_OPERATIONS_PER_DOCUMENT = 5_000;
/** The same bound across the whole run, and counted the same way — EXAMINED,
 *  not accepted. Counting successes here reproduced the very defect the
 *  per-document cap was corrected for: a run whose every operation was refused
 *  never decremented the budget, so all two thousand documents were processed
 *  in full and the result still reported `truncated: false`. */
const MAX_TOTAL_OPERATIONS = 50_000;
/** Bounded so a mis-aimed path (a whole repository, `/`) cannot walk forever. */
const MAX_DOCUMENTS = 2_000;
/** Directory entries VISITED, not documents accepted. The document cap alone
 *  bounds nothing on a tree that contains no documents. */
const MAX_WALK_ENTRIES = 100_000;
const MAX_DIRECTORY_DEPTH = 8;
/** Servers per document. The channel-inherits-all-servers rule reads this map,
 *  and YAML aliases make a server about sixteen bytes, so an in-cap document
 *  can declare hundreds of thousands of them. */
const MAX_SERVERS_PER_DOCUMENT = 1_000;
/**
 * A leading byte-order mark, stripped before the file is sniffed or parsed.
 *
 * An editor that saves UTF-8 with a BOM puts one code point in front of the
 * root key, which is enough to make the sniff miss and refuse a perfectly good
 * document as `not-a-document`.
 */
const BOM = '\uFEFF';
/**
 * An address and an operation id both end up inside graph identifiers, and
 * `generateId` CONCATENATES rather than hashes (`lib/utils.ts`), so an
 * identifier is exactly as long as the text it was built from. One document
 * under every other cap — a multi-megabyte address plus five thousand
 * operations naming it — therefore mints five thousand multi-megabyte edge ids,
 * each flattened into a string key by the graph's `Map`.
 *
 * The BROKER is the third such string and is bounded in `protocol.ts`; the
 * count matters because an earlier version of this comment said "the two
 * strings that reach an id", left the third unbounded, and a one-megabyte
 * protocol was measured turning a one-megabyte document into a gigabyte of
 * resident identifiers.
 */
const MAX_ADDRESS_LENGTH = 2_048;
const MAX_OPERATION_ID_LENGTH = 512;

const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(['.yaml', '.yml', '.json']);

/**
 * Why a document, or one operation inside it, produced no address.
 *
 * A CLOSED, COUNTABLE set, and deliberately NOT `SpringDestinationRefusal`.
 * That union is documented as the reasons a *source-level candidate* produced
 * no address, and it is the denominator of the unresolved fraction the address
 * work is judged on. Folding document-level failures into it would silently
 * change what that number means — a repository whose specification directory
 * was mistyped would report a worse SOURCE, which is the opposite of the truth.
 *
 * Members are split wherever two causes are different FACTS about the input.
 * A tally whose member says "the document contradicts itself" when the document
 * is merely multi-protocol sends an operator to fix the wrong thing, and this
 * tally is the number the whole feature is judged on.
 */
export type AsyncApiRefusal =
  /** The file parsed but has no root `asyncapi` key: not a document at all. */
  | 'not-a-document'
  /** Root `asyncapi: 2.x`. See the header — refused, never mapped. */
  | 'asyncapi-2-unsupported'
  /** A root `asyncapi` key naming a version this module does not read. */
  | 'unsupported-version'
  /** Malformed YAML/JSON, or a root that is not an object. */
  | 'unparsable'
  /** The file could not be read, or is not a regular file (a FIFO, a device). */
  | 'unreadable'
  /** A subdirectory could not be listed. Counted rather than skipped: under a
   *  mixed-permission cache half the documents can be invisible while the run
   *  otherwise reports a clean, complete read. */
  | 'directory-unreadable'
  /** Larger than {@link MAX_DOCUMENT_BYTES}. */
  | 'oversized'
  /** The document held more operations than one run will examine. */
  | 'operation-cap'
  /** The run as a whole reached {@link MAX_TOTAL_OPERATIONS}. */
  | 'total-operation-cap'
  /** The document declares more servers than the channel-inheritance rule will
   *  read. */
  | 'server-cap'
  /** The walk hit a bound before it finished, so the document set is a floor
   *  rather than the whole of what the configured path holds. A truncated read
   *  that reported nothing would be indistinguishable from a complete one. */
  | 'walk-truncated'
  /** `operations[].channel.$ref` is absent or not a local channel pointer. */
  | 'no-channel-reference'
  /** The `$ref` resolved to no channel in this document. */
  | 'channel-not-found'
  /** The channel entry is itself a Reference Object, which this module does not
   *  follow. Distinct from `no-address` on purpose: a `$ref`-ed channel HAS an
   *  address, somewhere this reader did not look, and filing it under
   *  `no-address` tells an operator their documents omit addresses when the
   *  real answer is that the reader stops one hop short. */
  | 'unresolved-channel-reference'
  /** The channel names no `address`, so there is nothing to key on. */
  | 'no-address'
  /**
   * The address is a TEMPLATE, not an address: the channel declares non-empty
   * `parameters`, or the address carries a `{…}` placeholder.
   *
   * This is the document-side twin of the source cascade's
   * `overridable-config-default`, and it exists for the identical reason. Two
   * services that both publish `{env}.orders` have named a pattern they share,
   * not a queue they share — one deploys with `env=prod` and the other with
   * `env=staging`, and keying on the template text merges them into a single
   * node with a publisher on one side and a subscriber on the other. That is a
   * false connection built entirely from conformant AsyncAPI: `parameters` and
   * `{param}` are core 3.x vocabulary, not a vendor quirk.
   */
  | 'templated-address'
  /** Longer than {@link MAX_ADDRESS_LENGTH}. */
  | 'address-too-long'
  /** Longer than {@link MAX_OPERATION_ID_LENGTH}. */
  | 'operation-id-too-long'
  /** `action` is neither `send` nor `receive`. */
  | 'unrecognized-action'
  /** Neither the operation's bindings nor the servers its channel resolves to
   *  name a protocol. Silence about the broker is not a claim about it, but a
   *  `Destination` cannot be keyed without one. */
  | 'protocol-unknown'
  /** The operation's OWN two statements about its broker — its bindings and the
   *  servers its channel explicitly lists — name different brokers. The
   *  document contradicts itself, and a destination keyed on the wrong broker
   *  joins a stranger. */
  | 'protocol-disagreement'
  /** The channel lists no `servers`, so it inherits all of them, and they do
   *  not agree on one broker. The document does NOT contradict itself here —
   *  it is simply multi-protocol and this channel did not choose — which is why
   *  this is not `protocol-disagreement`. */
  | 'ambiguous-server-default'
  /**
   * The channel inherits the document's servers, but that map was CAPPED at
   * {@link MAX_SERVERS_PER_DOCUMENT}, so the brokers read are a subset.
   *
   * Distinct from `ambiguous-server-default`, and the distinction is the whole
   * point: unanimity across a subset is not unanimity. A document whose first
   * thousand servers are Kafka and whose thousand-and-first is JMS reads as
   * unanimously Kafka, and every operation inheriting it would be attributed to
   * a broker the complete set does not agree on.
   */
  | 'capped-server-default'
  /**
   * A server this operation depends on is a Reference Object this reader could
   * not resolve — a pointer outside `#/servers` and `#/components/servers`, a
   * name that is absent, or a reference to another reference.
   *
   * Refused rather than skipped. Skipping one server of several silently
   * narrows the evidence, and a narrowed set is what makes a mixed document
   * look like it agrees with itself.
   */
  | 'unresolved-server-reference'
  /** The broker is HTTP or WebSocket, where the host rather than the address is
   *  the namespace. See `isNonDestinationBroker`. */
  | 'not-a-destination-protocol';

export interface AsyncApiOperation {
  /** Absolute path of the document this operation came from. */
  readonly documentPath: string;
  /** The `operations` map key, kept for provenance and carried into the edge
   *  `reason` so a reader can find the operation the edge came from. */
  readonly operationId: string;
  readonly action: 'send' | 'receive';
  readonly address: string;
  /** Normalized broker — the first half of the `Destination` key. */
  readonly broker: string;
}

export interface AsyncApiReadResult {
  readonly operations: readonly AsyncApiOperation[];
  /** Files considered — every candidate extension under the configured path. */
  readonly documentsScanned: number;
  /** Files that parsed as an AsyncAPI 3.x document and yielded an operation. */
  readonly documentsAccepted: number;
  /** Entries skipped because they were symbolic links. Not a refusal — the skip
   *  is deliberate — but counted, because a cache written by other tooling is
   *  very often a symlink farm, and an operator whose whole cache was skipped
   *  would otherwise see a result identical to a wrong path. */
  readonly symlinksSkipped: number;
  /** True when a bound stopped the walk or the operation count, so every number
   *  here is a floor rather than a total. */
  readonly truncated: boolean;
  /** Every refusal, document-level and operation-level, by reason. */
  readonly refusals: Readonly<Partial<Record<AsyncApiRefusal, number>>>;
}

interface Tally {
  count(reason: AsyncApiRefusal): void;
}

function makeTally(sink: Partial<Record<AsyncApiRefusal, number>>): Tally {
  return {
    count: (reason) => {
      sink[reason] = (sink[reason] ?? 0) + 1;
    },
  };
}

/**
 * Own-property read that cannot be answered by the prototype chain.
 *
 * A document is untrusted input and its keys are attacker-chosen in the general
 * case. `channels['constructor']` misses because {@link asRecord} rejects a
 * function — but `channels['__proto__']` would otherwise resolve to
 * `Object.prototype`, which IS an object and would sail through as an empty
 * channel. This guard, not the type test, is what stops that one.
 */
function own(container: unknown, key: string): unknown {
  if (typeof container !== 'object' || container === null) return undefined;
  if (!Object.prototype.hasOwnProperty.call(container, key)) return undefined;
  return (container as Record<string, unknown>)[key];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** URI-fragment percent-decode. Malformed `%` sequences refuse the pointer. */
function decodeFragment(ref: string): string | undefined {
  try {
    return decodeURIComponent(ref);
  } catch (err) {
    // Malformed percent-escapes throw URIError. Anything else is a real bug.
    if (!(err instanceof URIError)) throw err;
    return undefined;
  }
}

/** RFC 6901's own escapes, `~1` before `~0` — a literal `~1` produced by
 *  decoding `~01` would otherwise be mistaken for a slash. */
function unescapePointerToken(token: string): string {
  return token.split('~1').join('/').split('~0').join('~');
}

/**
 * Trailing name of `<prefix><token>` on an already-decoded fragment.
 *
 * DECODE, THEN SEGMENT. RFC 6901 percent-decodes the URI fragment first; only
 * then is the result split on `/`. Testing the raw text for a separator lets
 * `#/channels/orders%2Fv1` through as one segment and then decode it into two,
 * inventing a channel named `orders/v1`. A real slash in a name is `~1`.
 */
function nameAfterPrefix(decoded: string, prefix: string): string | undefined {
  if (!decoded.startsWith(prefix)) return undefined;
  const token = decoded.slice(prefix.length);
  if (token === '' || token.includes('/')) return undefined;
  return unescapePointerToken(token);
}

function pointerName(ref: string, prefix: string): string | undefined {
  const decoded = decodeFragment(ref);
  if (decoded === undefined) return undefined;
  return nameAfterPrefix(decoded, prefix);
}

/**
 * Distinct brokers named by a bindings object's own keys.
 *
 * Routed through `brokerForBindingKey`, which answers only for AsyncAPI's
 * binding vocabulary — `$ref` and `x-` extensions share this namespace
 * legitimately and are not brokers. See `protocol.ts` for why this differs from
 * the pass-through applied to `servers[].protocol`.
 */
function brokersFromBindings(bindings: unknown): Set<string> {
  const out = new Set<string>();
  const record = asRecord(bindings);
  if (record === undefined) return out;
  for (const key of Object.keys(record)) {
    const broker = brokerForBindingKey(key);
    if (broker !== undefined) out.add(broker);
  }
  return out;
}

/**
 * The broker one Servers Object entry names, following at most one local `$ref`.
 *
 * The Servers Object's patterned field is `Server Object | Reference Object`,
 * so an entry may legitimately be `{ $ref: '#/components/servers/prod' }`.
 * Reading `protocol` off the raw value drops every one of those, and a dropped
 * server is not neutral here: in a mixed set it removes the disagreeing half
 * and makes partial evidence look unanimous, which is exactly how a confident
 * WRONG broker gets attributed.
 *
 * `unresolved` is reported rather than swallowed so the caller can refuse the
 * attribution instead of answering from the servers it happened to understand.
 * A reference to a reference counts as unresolved too: one hop covers every
 * document shape seen in practice, and chasing a chain over untrusted input
 * would need a cycle guard before it were safe at all.
 */
function serverBroker(
  entry: unknown,
  root: Record<string, unknown>,
): { broker: string | undefined; unresolved: boolean } {
  const ref = asString(own(entry, '$ref'));
  if (ref === undefined) {
    return { broker: brokerForProtocol(asString(own(entry, 'protocol'))), unresolved: false };
  }
  const target = resolveLocalServerRef(ref, root);
  if (target === undefined || own(target, '$ref') !== undefined) {
    return { broker: undefined, unresolved: true };
  }
  return { broker: brokerForProtocol(asString(own(target, 'protocol'))), unresolved: false };
}

/** `#/servers/<name>` or `#/components/servers/<name>` → that Server Object. */
function resolveLocalServerRef(
  ref: string,
  root: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const decoded = decodeFragment(ref);
  if (decoded === undefined) return undefined;
  const direct = nameAfterPrefix(decoded, '#/servers/');
  if (direct !== undefined) return asRecord(own(asRecord(own(root, 'servers')), direct));
  const inComponents = nameAfterPrefix(decoded, '#/components/servers/');
  if (inComponents === undefined) return undefined;
  const components = asRecord(own(asRecord(own(root, 'components')), 'servers'));
  return asRecord(own(components, inComponents));
}

/**
 * Brokers of the servers a channel names explicitly.
 *
 * An EMPTY array is not an explicit choice. The specification defines the two
 * cases identically — "If `servers` is absent or empty, this channel MUST be
 * available on all the servers defined in the Servers Object" — so reporting
 * `explicit: true` after a zero-iteration loop blocks the inherited fallback
 * and drops a perfectly valid operation as `protocol-unknown`.
 *
 * A channel's `servers` MUST hold Reference Objects — the specification says so
 * in as many words, and forbids Server Objects there by name — so an entry that
 * is not a resolvable local reference is counted `unresolved` rather than read.
 */
function brokersFromChannelRefs(
  channel: Record<string, unknown>,
  root: Record<string, unknown>,
): { brokers: Set<string>; explicit: boolean; unresolved: boolean } {
  const out = new Set<string>();
  const refs = own(channel, 'servers');
  if (!Array.isArray(refs) || refs.length === 0) {
    return { brokers: out, explicit: false, unresolved: false };
  }
  const servers = asRecord(own(root, 'servers'));
  let unresolved = false;
  for (const entry of refs) {
    const ref = asString(own(entry, '$ref'));
    const name = ref === undefined ? undefined : pointerName(ref, '#/servers/');
    const target = name === undefined ? undefined : own(servers, name);
    if (target === undefined) {
      unresolved = true;
      continue;
    }
    const resolved = serverBroker(target, root);
    if (resolved.unresolved) {
      unresolved = true;
      continue;
    }
    if (resolved.broker !== undefined) out.add(resolved.broker);
  }
  return { brokers: out, explicit: true, unresolved };
}

/**
 * Every broker the document's servers name, computed ONCE per document.
 *
 * A channel that names no `servers` is available on all of them — the
 * specification's own default, not an inference. Computing it per operation was
 * quadratic in `servers × operations`, which an in-cap document can drive to
 * minutes.
 */
function brokersOfAllServers(root: Record<string, unknown>): {
  brokers: Set<string>;
  capped: boolean;
  unresolved: boolean;
} {
  const out = new Set<string>();
  const servers = asRecord(own(root, 'servers'));
  if (servers === undefined) return { brokers: out, capped: false, unresolved: false };
  let seen = 0;
  for (const name in servers) {
    if (!Object.prototype.hasOwnProperty.call(servers, name)) continue;
    seen += 1;
    if (seen > MAX_SERVERS_PER_DOCUMENT) {
      // Inherited resolution refuses a capped map before asking it to agree
      // with itself, so the brokers of the first thousand entries are unused.
      return { brokers: out, capped: true, unresolved: false };
    }
  }
  let unresolved = false;
  for (const name in servers) {
    if (!Object.prototype.hasOwnProperty.call(servers, name)) continue;
    const resolved = serverBroker(own(servers, name), root);
    if (resolved.unresolved) unresolved = true;
    else if (resolved.broker !== undefined) out.add(resolved.broker);
  }
  return { brokers: out, capped: false, unresolved };
}

/**
 * Root `asyncapi` version → readable, refused, or not a document at all.
 *
 * Compared on the MAJOR component only. A 3.1 document adds fields this module
 * does not read and changes none it does; refusing it would lose real
 * destinations over a minor-version digit.
 */
function classifyVersion(raw: Record<string, unknown>): 'read' | AsyncApiRefusal {
  const declared = asString(own(raw, 'asyncapi'))?.trim();
  if (declared === undefined || declared === '') return 'not-a-document';
  const major = declared.split('.')[0];
  if (major === '3') return 'read';
  if (major === '2') return 'asyncapi-2-unsupported';
  return 'unsupported-version';
}

export interface NormalizedDocument {
  operations: AsyncApiOperation[];
  refusals: Partial<Record<AsyncApiRefusal, number>>;
  /** Operations EXAMINED, which is what the caps count. */
  examined: number;
  /** A bound stopped this document short. */
  truncated: boolean;
}

/**
 * Normalize one parsed document. Pure — no filesystem, so the whole refusal
 * surface is testable from inline document literals.
 *
 * `budget` is the number of operations the RUN may still examine.
 */
export function normalizeAsyncApiDocument(
  parsed: unknown,
  documentPath: string,
  budget: number = MAX_TOTAL_OPERATIONS,
): NormalizedDocument {
  const refusals: Partial<Record<AsyncApiRefusal, number>> = {};
  const tally = makeTally(refusals);
  const operations: AsyncApiOperation[] = [];
  let examined = 0;
  let truncated = false;

  const raw = asRecord(parsed);
  if (raw === undefined) {
    tally.count('unparsable');
    return { operations, refusals, examined, truncated };
  }

  const verdict = classifyVersion(raw);
  if (verdict !== 'read') {
    tally.count(verdict);
    return { operations, refusals, examined, truncated };
  }

  const channels = asRecord(own(raw, 'channels'));
  const operationsRaw = asRecord(own(raw, 'operations'));
  if (operationsRaw === undefined) return { operations, refusals, examined, truncated };

  const allServers = brokersOfAllServers(raw);
  if (allServers.capped) {
    tally.count('server-cap');
    truncated = true;
  }

  for (const operationId of Object.keys(operationsRaw)) {
    if (examined >= MAX_OPERATIONS_PER_DOCUMENT) {
      tally.count('operation-cap');
      truncated = true;
      break;
    }
    if (examined >= budget) {
      tally.count('total-operation-cap');
      truncated = true;
      break;
    }
    examined += 1;

    const operation = asRecord(own(operationsRaw, operationId));
    if (operation === undefined) {
      tally.count('unparsable');
      continue;
    }

    if (operationId.length > MAX_OPERATION_ID_LENGTH) {
      tally.count('operation-id-too-long');
      continue;
    }

    const action = asString(own(operation, 'action'))?.trim().toLowerCase();
    if (action !== 'send' && action !== 'receive') {
      tally.count('unrecognized-action');
      continue;
    }

    const ref = asString(own(own(operation, 'channel'), '$ref'));
    const channelName = ref === undefined ? undefined : pointerName(ref, '#/channels/');
    if (channelName === undefined) {
      tally.count('no-channel-reference');
      continue;
    }
    const channel = asRecord(own(channels, channelName));
    if (channel === undefined) {
      tally.count('channel-not-found');
      continue;
    }
    if (own(channel, '$ref') !== undefined && own(channel, 'address') === undefined) {
      tally.count('unresolved-channel-reference');
      continue;
    }

    // The `address` field, not the channel KEY. A generator is free to key a
    // channel by anything unique; only `address` is defined as the thing the
    // broker is addressed by, and keying a node on a document-local map key
    // would join two services that merely organized their documents alike.
    //
    // NOT TRIMMED, deliberately. The source cascade keeps an address exactly as
    // written — `" orders "` is its own node and does not join `"orders"` — on
    // the grounds that a missing connection beats a false one. Two producers of
    // one key must not hold opposite whitespace policies, and of the two
    // available answers this is the one that errs away from joining.
    const address = asString(own(channel, 'address'));
    if (address === undefined || address.trim() === '') {
      tally.count('no-address');
      continue;
    }
    if (address.length > MAX_ADDRESS_LENGTH) {
      tally.count('address-too-long');
      continue;
    }
    // A non-empty `parameters` map is the specification's own statement that
    // the address is a template. An EMPTY one states nothing — generators emit
    // empty containers routinely — so it must not refuse a literal address; the
    // `{` test below covers documents that template without declaring.
    const parameters = asRecord(own(channel, 'parameters'));
    if ((parameters !== undefined && Object.keys(parameters).length > 0) || address.includes('{')) {
      tally.count('templated-address');
      continue;
    }

    // BINDINGS FIRST. They are the operation's own statement about its broker;
    // the servers are the channel's. Unioning every server before consulting
    // the bindings made a document that declares both a REST server and a Kafka
    // server lose every operation it states, filed under a reason that says the
    // document contradicts itself — when the contradiction was manufactured
    // here by asking a question the operation had already answered.
    //
    // The CHANNEL's bindings count as well. They are a statement about the same
    // operation made one level up, and a conformant document may carry only
    // those — `channels: { orders: { bindings: { kafka: {} } } }` with no
    // operation binding and no usable server protocol was dropped as
    // `protocol-unknown` while the document had said plainly which broker it
    // meant. Where both levels speak and disagree, the document contradicts
    // itself and neither answer may be used.
    const fromBindings = brokersFromBindings(own(operation, 'bindings'));
    for (const broker of brokersFromBindings(own(channel, 'bindings'))) {
      fromBindings.add(broker);
    }
    if (fromBindings.size > 1) {
      tally.count('protocol-disagreement');
      continue;
    }
    const bindingBroker = [...fromBindings][0];

    const explicitServers = brokersFromChannelRefs(channel, raw);
    let broker: string | undefined;
    if (bindingBroker !== undefined) {
      // Cross-check only against servers the channel named itself, and only
      // when they are unanimous. An inherited multi-protocol server set is not
      // a claim about THIS operation.
      const explicitBroker =
        explicitServers.brokers.size === 1 ? [...explicitServers.brokers][0] : undefined;
      if (explicitBroker !== undefined && explicitBroker !== bindingBroker) {
        tally.count('protocol-disagreement');
        continue;
      }
      broker = bindingBroker;
    } else if (explicitServers.explicit) {
      if (explicitServers.unresolved) {
        tally.count('unresolved-server-reference');
        continue;
      }
      if (explicitServers.brokers.size > 1) {
        tally.count('protocol-disagreement');
        continue;
      }
      broker = [...explicitServers.brokers][0];
    } else {
      // Order matters: an INCOMPLETE set must be refused before it is asked
      // whether it agrees, because a subset agrees with itself for free.
      if (allServers.capped) {
        tally.count('capped-server-default');
        continue;
      }
      if (allServers.unresolved) {
        tally.count('unresolved-server-reference');
        continue;
      }
      if (allServers.brokers.size > 1) {
        tally.count('ambiguous-server-default');
        continue;
      }
      broker = [...allServers.brokers][0];
    }

    if (broker === undefined) {
      tally.count('protocol-unknown');
      continue;
    }
    if (isNonDestinationBroker(broker)) {
      tally.count('not-a-destination-protocol');
      continue;
    }

    operations.push({ documentPath, operationId, action, address, broker });
  }

  return { operations, refusals, examined, truncated };
}

/**
 * Cheap pre-parse gate: does this file even claim to be an AsyncAPI document?
 *
 * Scans the WHOLE text, which is already bounded by {@link MAX_DOCUMENT_BYTES}
 * and already in memory. A fixed window is the wrong shape of bound here: it
 * decides the answer by where the key happens to sit rather than by whether the
 * key is there, so any window is a false negative waiting for a file with a
 * longer preamble. Sixty-four kilobytes replaced four for exactly that reason
 * and inherited exactly that defect — a licence header, a `$schema` block and a
 * long `info.description` clear it easily. The gate exists to skip the YAML
 * PARSE, which is the expensive half; a linear scan of the same bytes is not.
 */
function looksLikeDocument(text: string): boolean {
  if (!text.includes('asyncapi')) return false;
  return /(^|[\s{,"'])["']?asyncapi["']?\s*:/m.test(text);
}

interface WalkResult {
  files: string[];
  symlinksSkipped: number;
  truncated: boolean;
  unreadableDirectories: number;
}

async function collectCandidateFiles(root: string): Promise<WalkResult> {
  const files: string[] = [];
  let symlinksSkipped = 0;
  let unreadableDirectories = 0;
  let visited = 0;
  let truncated = false;
  // Distinct from `truncated`: a GLOBAL budget is exhausted and no further work
  // is useful, whereas depth exhaustion in one branch says nothing about its
  // siblings. Conflating them made a single over-deep subdirectory discard
  // every remaining document in the walk, with the outcome decided by
  // alphabetical ordering — a strictly worse failure than the one the
  // truncation reporting was added to fix.
  let exhausted = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (exhausted) return;
    if (depth > MAX_DIRECTORY_DEPTH) {
      truncated = true;
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      unreadableDirectories += 1;
      truncated = true;
      return;
    }
    // Sorted so the operation order a run produces is a function of the tree,
    // not of the order the filesystem happened to hand entries back.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (exhausted) return;
      visited += 1;
      if (visited > MAX_WALK_ENTRIES || files.length >= MAX_DOCUMENTS) {
        truncated = true;
        exhausted = true;
        return;
      }
      const full = path.join(dir, entry.name);
      // `withFileTypes` reports a symlink as neither file nor directory, so
      // links are skipped without ever being followed — a configured directory
      // must not become a route out of itself. Counted rather than dropped in
      // silence: a symlinked cache would otherwise look exactly like a wrong
      // path.
      if (entry.isSymbolicLink()) {
        symlinksSkipped += 1;
      } else if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (
        entry.isFile() &&
        DOCUMENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        files.push(full);
      }
    }
  };

  await walk(root, 0);
  return { files, symlinksSkipped, truncated, unreadableDirectories };
}

/**
 * Read one candidate file under a hard byte ceiling.
 *
 * Modelled on `frameworks/spring/actuator-runtime.ts`'s `readPayloadFile`, and
 * for the reason its comment gives: the size gate and the read share ONE handle
 * so both observe the same inode. Checking `fs.stat(path)` and then re-resolving
 * that path in `fs.readFile` lets whatever writes the directory swap the file
 * between the two calls, which makes the cap advisory (CodeQL
 * js/file-system-race). The out-of-band cache this option exists to read is
 * written by other tooling by definition, so the race is the normal condition
 * here rather than an exotic one.
 *
 * The read LOOPS, like its model. POSIX permits a short read on a regular file,
 * and a single read was measured never short across seven hundred reads on
 * APFS — but the deployments this option targets put the cache on NFS, SMB or a
 * FUSE mount, and FUSE filesystems using `direct_io` do return short counts.
 * The consequence of one short read is silent: a document truncated at a line
 * boundary still parses, so operations vanish with `refusals: {}` and
 * `truncated: false`, indistinguishable from a document that had fewer.
 *
 * The `isFile` test on the same handle is what the path-based version could not
 * do at all. Without it the single-file configuration accepts anything `stat`
 * follows: a character device reports size 0 and then streams until Node throws
 * at two gigabytes, and a FIFO never returns at all.
 *
 * `O_NONBLOCK` is what makes that test reachable, and it was not obvious — it
 * was found by writing the FIFO test and watching it TIME OUT rather than fail.
 * Opening a FIFO for reading blocks in `open(2)` until some writer opens the
 * other end, so a type check performed after the open never runs: the analyze
 * hangs there, holding its repository lock, with no error to report. The flag
 * makes the open return immediately for a FIFO and is a no-op for the regular
 * files this actually wants (measured: identical byte count, digest and timing
 * with and without it), which is why it costs nothing to keep.
 */
async function readBoundedFile(file: string): Promise<string | 'oversized' | 'unreadable'> {
  let handle: import('node:fs/promises').FileHandle | undefined;
  try {
    // `O_NONBLOCK` is absent on some platforms; falling back to a plain
    // read-only open there keeps behaviour identical for regular files.
    const nonBlocking = (fsConstants.O_NONBLOCK ?? 0) | fsConstants.O_RDONLY;
    handle = await fs.open(file, nonBlocking);
    const stat = await handle.stat();
    if (!stat.isFile()) return 'unreadable';
    if (stat.size > MAX_DOCUMENT_BYTES) return 'oversized';
    const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MAX_DOCUMENT_BYTES) return 'oversized';
    return buffer.subarray(0, bytesRead).toString('utf-8');
  } catch {
    return 'unreadable';
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Read every AsyncAPI 3.x document under an explicitly configured path.
 *
 * `configuredPath` is resolved against the repository root, so an absolute path
 * to a cache populated out of band and a repo-relative directory of committed
 * documents are both natural — the same shape `springActuatorPath` offers for
 * Actuator snapshots. The READ is wider than that neighbour's, and the
 * difference is worth stating rather than glossed as "the same contract": the
 * Actuator loader probes five fixed filenames in one directory, while this
 * walks recursively under the caps above and opens every candidate it finds.
 *
 * There is deliberately NO glob-based auto-discovery. Scanning a repository for
 * anything that parses as a document would make every existing index grow nodes
 * on its next run with nobody having asked for it.
 */
export async function readAsyncApiDocuments(
  repoPath: string,
  configuredPath: string,
): Promise<AsyncApiReadResult> {
  const refusals: Partial<Record<AsyncApiRefusal, number>> = {};
  const tally = makeTally(refusals);
  const operations: AsyncApiOperation[] = [];
  let documentsScanned = 0;
  let documentsAccepted = 0;
  let symlinksSkipped = 0;
  let truncated = false;
  let examinedTotal = 0;

  const root = path.resolve(repoPath, configuredPath);
  let files: string[];
  try {
    const stat = await fs.stat(root);
    if (stat.isDirectory()) {
      const walked = await collectCandidateFiles(root);
      files = walked.files;
      symlinksSkipped = walked.symlinksSkipped;
      truncated = walked.truncated;
      for (let i = 0; i < walked.unreadableDirectories; i += 1) tally.count('directory-unreadable');
      if (truncated && walked.unreadableDirectories === 0) tally.count('walk-truncated');
    } else {
      files = [root];
    }
  } catch {
    tally.count('unreadable');
    return {
      operations,
      documentsScanned,
      documentsAccepted,
      symlinksSkipped,
      truncated,
      refusals,
    };
  }

  for (const file of files) {
    documentsScanned += 1;
    const content = await readBoundedFile(file);
    if (content === 'oversized' || content === 'unreadable') {
      tally.count(content);
      continue;
    }

    const text = content.startsWith(BOM) ? content.slice(BOM.length) : content;

    // Sniff before parsing. A configured directory may hold hundreds of
    // unrelated YAML files, and parsing each one to discover it is not a
    // document is the difference between a bounded cost and a per-file one.
    if (!looksLikeDocument(text)) {
      tally.count('not-a-document');
      continue;
    }

    let parsed: unknown;
    try {
      parsed = yaml.load(text, { schema: DOCUMENT_SCHEMA });
    } catch {
      tally.count('unparsable');
      continue;
    }

    const remaining = MAX_TOTAL_OPERATIONS - examinedTotal;
    if (remaining <= 0) {
      tally.count('total-operation-cap');
      truncated = true;
      break;
    }

    const result = normalizeAsyncApiDocument(parsed, file, remaining);
    examinedTotal += result.examined;
    if (result.truncated) truncated = true;
    for (const [reason, count] of Object.entries(result.refusals)) {
      refusals[reason as AsyncApiRefusal] = (refusals[reason as AsyncApiRefusal] ?? 0) + count;
    }
    if (result.operations.length > 0) documentsAccepted += 1;
    operations.push(...result.operations);
  }

  return { operations, documentsScanned, documentsAccepted, symlinksSkipped, truncated, refusals };
}
