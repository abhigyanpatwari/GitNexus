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
import path from 'node:path';
import { brokerForProtocol } from './protocol.js';

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
/** Bounded so one pathological document cannot dominate a run. */
const MAX_OPERATIONS_PER_DOCUMENT = 5_000;
/** Bounded so a mis-aimed path (a whole repository, `/`) cannot walk forever. */
const MAX_DOCUMENTS = 2_000;
const MAX_DIRECTORY_DEPTH = 8;
/** Only the first chunk is sniffed for the root key before a full parse. */
const SNIFF_BYTES = 4096;

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
  /** The file could not be read (permissions, vanished mid-walk). */
  | 'unreadable'
  /** Larger than {@link MAX_DOCUMENT_BYTES}. */
  | 'oversized'
  /** The document held more operations than one run will read. */
  | 'operation-cap'
  /** `operations[].channel.$ref` is absent or not a local channel pointer. */
  | 'no-channel-reference'
  /** The `$ref` resolved to no channel in this document. */
  | 'channel-not-found'
  /** The channel names no `address`, so there is nothing to key on. */
  | 'no-address'
  /** `action` is neither `send` nor `receive`. */
  | 'unrecognized-action'
  /** Neither the operation's bindings nor its channel's servers name a
   *  protocol. Silence about the broker is not a claim about it, but a
   *  `Destination` cannot be keyed without one. */
  | 'protocol-unknown'
  /** The operation's bindings and its channel's servers name DIFFERENT
   *  brokers, or one of them names several. A destination keyed on the wrong
   *  broker joins a stranger; keyed on the right one it joins its pair. With
   *  the document contradicting itself there is no way to tell which, and a
   *  coin flip here is a false connection half the time. */
  | 'protocol-disagreement';

export interface AsyncApiOperation {
  /** Absolute path of the document this operation came from. */
  readonly documentPath: string;
  /** The `operations` map key, kept for provenance and for a later pass that
   *  wants to resolve an operation to the symbol implementing it. */
  readonly operationId: string;
  readonly action: 'send' | 'receive';
  readonly address: string;
  /** Normalized broker — the first half of the `Destination` key. */
  readonly broker: string;
  /** The protocol exactly as the document spelled it, before normalization. */
  readonly protocol: string;
  /** Message names referenced by the operation, in document order. Carried for
   *  provenance only: nothing keys on them. */
  readonly messageNames: readonly string[];
}

export interface AsyncApiReadResult {
  readonly operations: readonly AsyncApiOperation[];
  /** Files considered — every candidate extension under the configured path. */
  readonly documentsScanned: number;
  /** Files that parsed as an AsyncAPI 3.x document. */
  readonly documentsAccepted: number;
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
 * case; `channels['constructor']` must miss rather than return a function.
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

/**
 * Decode one JSON Pointer reference token.
 *
 * Two encodings stack here and their order is fixed by RFC 6901: the pointer
 * lives in a URI fragment, so percent-encoding comes off first, and only then
 * the pointer's own escapes — `~1` before `~0`, or a literal `~1` produced by
 * decoding `~01` would be mistaken for a slash.
 */
function decodePointerToken(token: string): string {
  let decoded = token;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    // A stray `%` is not an encoding error worth losing the reference over.
  }
  return decoded.split('~1').join('/').split('~0').join('~');
}

/** `#/channels/<token>` → the channel name, or `undefined` for anything else. */
function channelNameFromRef(ref: string): string | undefined {
  const prefix = '#/channels/';
  if (!ref.startsWith(prefix)) return undefined;
  const token = ref.slice(prefix.length);
  if (token === '' || token.includes('/')) return undefined;
  return decodePointerToken(token);
}

/** Distinct normalized brokers named by a bindings object's keys. */
function brokersFromBindings(bindings: unknown): Set<string> {
  const out = new Set<string>();
  const record = asRecord(bindings);
  if (record === undefined) return out;
  for (const key of Object.keys(record)) {
    const broker = brokerForProtocol(key);
    if (broker !== undefined) out.add(broker);
  }
  return out;
}

/** Distinct normalized brokers named by the servers a channel references. */
function brokersFromChannelServers(
  channel: Record<string, unknown>,
  servers: Record<string, unknown> | undefined,
): { brokers: Set<string>; rawProtocol: string | undefined } {
  const out = new Set<string>();
  let rawProtocol: string | undefined;
  const refs = own(channel, 'servers');
  if (!Array.isArray(refs) || servers === undefined) return { brokers: out, rawProtocol };
  for (const entry of refs) {
    const ref = asString(own(entry, '$ref'));
    if (ref === undefined) continue;
    const prefix = '#/servers/';
    if (!ref.startsWith(prefix)) continue;
    const name = decodePointerToken(ref.slice(prefix.length));
    const protocol = asString(own(own(servers, name), 'protocol'));
    const broker = brokerForProtocol(protocol);
    if (broker === undefined) continue;
    rawProtocol ??= protocol;
    out.add(broker);
  }
  return { brokers: out, rawProtocol };
}

function messageNamesOf(operation: Record<string, unknown>): string[] {
  const messages = own(operation, 'messages');
  if (!Array.isArray(messages)) return [];
  const names: string[] = [];
  for (const entry of messages) {
    const ref = asString(own(entry, '$ref'));
    if (ref === undefined) continue;
    const marker = '/messages/';
    const at = ref.lastIndexOf(marker);
    if (at < 0) continue;
    const name = decodePointerToken(ref.slice(at + marker.length));
    if (name !== '') names.push(name);
  }
  return names;
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

/**
 * Normalize one parsed document. Pure — no filesystem, so the whole refusal
 * surface is testable from inline document literals.
 */
export function normalizeAsyncApiDocument(
  parsed: unknown,
  documentPath: string,
): { operations: AsyncApiOperation[]; refusals: Partial<Record<AsyncApiRefusal, number>> } {
  const refusals: Partial<Record<AsyncApiRefusal, number>> = {};
  const tally = makeTally(refusals);
  const operations: AsyncApiOperation[] = [];

  const raw = asRecord(parsed);
  if (raw === undefined) {
    tally.count('unparsable');
    return { operations, refusals };
  }

  const verdict = classifyVersion(raw);
  if (verdict !== 'read') {
    tally.count(verdict);
    return { operations, refusals };
  }

  const channels = asRecord(own(raw, 'channels'));
  const servers = asRecord(own(raw, 'servers'));
  const operationsRaw = asRecord(own(raw, 'operations'));
  if (operationsRaw === undefined) return { operations, refusals };

  for (const operationId of Object.keys(operationsRaw)) {
    if (operations.length >= MAX_OPERATIONS_PER_DOCUMENT) {
      tally.count('operation-cap');
      break;
    }
    const operation = asRecord(own(operationsRaw, operationId));
    if (operation === undefined) continue;

    const action = asString(own(operation, 'action'))?.trim().toLowerCase();
    if (action !== 'send' && action !== 'receive') {
      tally.count('unrecognized-action');
      continue;
    }

    const ref = asString(own(own(operation, 'channel'), '$ref'));
    const channelName = ref === undefined ? undefined : channelNameFromRef(ref);
    if (channelName === undefined) {
      tally.count('no-channel-reference');
      continue;
    }
    const channel = asRecord(own(channels, channelName));
    if (channel === undefined) {
      tally.count('channel-not-found');
      continue;
    }

    // The `address` field, not the channel KEY. A generator is free to key a
    // channel by anything unique; only `address` is defined as the thing the
    // broker is addressed by, and keying a node on a document-local map key
    // would join two services that merely organized their documents alike.
    const address = asString(own(channel, 'address'))?.trim();
    if (address === undefined || address === '') {
      tally.count('no-address');
      continue;
    }

    // Two independent readings of the same fact. Both are ordinary AsyncAPI —
    // neither is a vendor extension — and requiring them to agree is what turns
    // a broker guess into a broker reading.
    const fromBindings = brokersFromBindings(own(operation, 'bindings'));
    const { brokers: fromServers, rawProtocol } = brokersFromChannelServers(channel, servers);
    if (fromBindings.size > 1 || fromServers.size > 1) {
      tally.count('protocol-disagreement');
      continue;
    }
    const bindingBroker = [...fromBindings][0];
    const serverBroker = [...fromServers][0];
    if (bindingBroker !== undefined && serverBroker !== undefined && bindingBroker !== serverBroker) {
      tally.count('protocol-disagreement');
      continue;
    }
    const broker = bindingBroker ?? serverBroker;
    if (broker === undefined) {
      tally.count('protocol-unknown');
      continue;
    }

    operations.push({
      documentPath,
      operationId,
      action,
      address,
      broker,
      protocol: rawProtocol ?? [...fromBindings][0] ?? broker,
      messageNames: messageNamesOf(operation),
    });
  }

  return { operations, refusals };
}

/** Cheap pre-parse gate: does this file even claim to be an AsyncAPI document? */
function looksLikeDocument(head: string): boolean {
  return /(^|[\s{,"'])["']?asyncapi["']?\s*:/m.test(head);
}

async function collectCandidateFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DIRECTORY_DEPTH || found.length >= MAX_DOCUMENTS) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Sorted so the operation order a run produces is a function of the tree,
    // not of the order the filesystem happened to hand entries back.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (found.length >= MAX_DOCUMENTS) return;
      const full = path.join(dir, entry.name);
      // `withFileTypes` reports a symlink as neither file nor directory, so
      // links are skipped without ever being followed — a configured directory
      // must not become a route out of itself.
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && DOCUMENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(full);
      }
    }
  };
  await walk(root, 0);
  return found;
}

/**
 * Read every AsyncAPI 3.x document under an explicitly configured path.
 *
 * `configuredPath` is resolved against the repository root, so an absolute path
 * to a cache populated out of band and a repo-relative directory of committed
 * documents are both natural — the same contract `springActuatorPath` offers
 * for Actuator snapshots, and for the same reason: the artifact is not a source
 * file, and where it comes from is the operator's business, not this module's.
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

  const root = path.resolve(repoPath, configuredPath);
  let files: string[];
  try {
    const stat = await fs.stat(root);
    files = stat.isDirectory() ? await collectCandidateFiles(root) : [root];
  } catch {
    tally.count('unreadable');
    return { operations, documentsScanned, documentsAccepted, refusals };
  }

  for (const file of files) {
    documentsScanned += 1;
    let content: string;
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_DOCUMENT_BYTES) {
        tally.count('oversized');
        continue;
      }
      content = await fs.readFile(file, 'utf-8');
    } catch {
      tally.count('unreadable');
      continue;
    }

    // Sniff before parsing. A configured directory may hold hundreds of
    // unrelated YAML files, and parsing each one to discover it is not a
    // document is the difference between a bounded cost and a per-file one.
    if (!looksLikeDocument(content.slice(0, SNIFF_BYTES))) {
      tally.count('not-a-document');
      continue;
    }

    let parsed: unknown;
    try {
      parsed = yaml.load(content, { schema: DOCUMENT_SCHEMA });
    } catch {
      tally.count('unparsable');
      continue;
    }

    const result = normalizeAsyncApiDocument(parsed, file);
    for (const [reason, count] of Object.entries(result.refusals)) {
      refusals[reason as AsyncApiRefusal] = (refusals[reason as AsyncApiRefusal] ?? 0) + count;
    }
    if (result.operations.length > 0) documentsAccepted += 1;
    operations.push(...result.operations);
  }

  return { operations, documentsScanned, documentsAccepted, refusals };
}
