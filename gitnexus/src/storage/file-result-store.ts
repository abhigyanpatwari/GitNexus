/** Bounded packs of independently addressed file results. Packs are immutable once published. */
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { linkOrCopyFile, writeFileAtomic } from './fs-atomic.js';
import {
  decodeFileResultSection,
  MAX_FILE_RESULT_SECTION_BYTES,
  type EncodedFileResult,
} from './file-result-codec.js';
import type { V8CacheHit } from './v8-sidecar.js';

const FORMAT = 1;
const PACK_BYTES = 32 * 1024 * 1024;
const KEY = /^[a-f0-9]{64}$/;
const PACK = /^[a-f0-9-]{36}\.pack$/;
const MAX_INDEX_BYTES = 128 * 1024 * 1024;
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export interface FileResultReference {
  key: string;
  path: string;
  pack: string;
  offset: number;
  factsLength: number;
  scopesLength: number;
  factsHash: string;
  scopesHash: string;
}
export interface FileResultStore {
  directory: string;
  identity: string;
  records: Map<string, FileResultReference>;
  /** Only the run-owned writer mutates an active pack. Readers never append. */
  activePack?: { name: string; bytes: number };
}

export function emptyFileResultStore(directory: string, identity: string): FileResultStore {
  return { directory, identity, records: new Map() };
}

function validReference(value: unknown): value is FileResultReference {
  if (!value || typeof value !== 'object') return false;
  const r = value as FileResultReference;
  return (
    typeof r.key === 'string' &&
    KEY.test(r.key) &&
    typeof r.path === 'string' &&
    typeof r.pack === 'string' &&
    PACK.test(r.pack) &&
    Number.isSafeInteger(r.offset) &&
    r.offset >= 0 &&
    Number.isSafeInteger(r.factsLength) &&
    r.factsLength > 0 &&
    r.factsLength <= MAX_FILE_RESULT_SECTION_BYTES + 5 &&
    Number.isSafeInteger(r.scopesLength) &&
    r.scopesLength > 0 &&
    r.scopesLength <= MAX_FILE_RESULT_SECTION_BYTES + 5 &&
    Number.isSafeInteger(r.offset + r.factsLength + r.scopesLength) &&
    typeof r.factsHash === 'string' &&
    KEY.test(r.factsHash) &&
    typeof r.scopesHash === 'string' &&
    KEY.test(r.scopesHash)
  );
}

export async function loadFileResultStore(
  directory: string,
  identity: string,
): Promise<FileResultStore> {
  const store = emptyFileResultStore(directory, identity);
  try {
    const file = path.join(directory, 'index.json');
    if ((await fs.stat(file)).size > MAX_INDEX_BYTES) return store;
    const data: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!data || typeof data !== 'object') return store;
    const index = data as { format?: unknown; identity?: unknown; records?: unknown };
    if (index.format !== FORMAT || index.identity !== identity || !Array.isArray(index.records))
      return store;
    for (const ref of index.records) {
      if (!validReference(ref) || store.records.has(ref.key))
        return emptyFileResultStore(directory, identity);
      store.records.set(ref.key, ref);
    }
  } catch {
    // Derived data: absent, truncated or incompatible manifests are cold misses.
  }
  return store;
}

export async function writeFileResultIndex(store: FileResultStore): Promise<void> {
  await fs.mkdir(store.directory, { recursive: true });
  await writeFileAtomic(
    path.join(store.directory, 'index.json'),
    JSON.stringify({
      format: FORMAT,
      identity: store.identity,
      records: [...store.records.values()],
    }),
  );
}

/** Append a batch in one write per bounded pack; record offsets only after success. */
export async function appendFileResults(
  store: FileResultStore,
  records: readonly EncodedFileResult[],
): Promise<void> {
  await fs.mkdir(store.directory, { recursive: true });
  let pending: Uint8Array[] = [];
  let refs: FileResultReference[] = [];
  let bytes = 0;
  const flush = async () => {
    if (!refs.length) return;
    try {
      await fs.appendFile(
        path.join(store.directory, store.activePack!.name),
        Buffer.concat(pending),
        { mode: 0o600 },
      );
      store.activePack!.bytes += bytes;
      for (const ref of refs) store.records.set(ref.key, ref);
    } catch (error) {
      // A short append must never shift a later record onto an assumed offset.
      store.activePack = undefined;
      throw error;
    } finally {
      pending = [];
      refs = [];
      bytes = 0;
    }
  };
  for (const record of records) {
    if (!record.cacheable) continue;
    const length = record.facts.length + record.scopes.length;
    if (!store.activePack || store.activePack.bytes + bytes + length > PACK_BYTES) {
      await flush();
      store.activePack = { name: `${randomUUID()}.pack`, bytes: 0 };
    }
    const ref: FileResultReference = {
      key: record.key,
      path: record.path,
      pack: store.activePack.name,
      offset: store.activePack.bytes + bytes,
      factsLength: record.facts.length,
      scopesLength: record.scopes.length,
      factsHash: digest(record.facts),
      scopesHash: digest(record.scopes),
    };
    if (!validReference(ref)) throw new Error('Invalid encoded file result');
    refs.push(ref);
    pending.push(record.facts, record.scopes);
    bytes += length;
  }
  await flush();
}

/** Batch range reads reuse handles, close deterministically, and verify both sections. */
export async function readFileResults(
  store: FileResultStore,
  keys: readonly string[],
): Promise<Map<string, EncodedFileResult>> {
  const result = new Map<string, EncodedFileResult>();
  const handles = new Map<string, { handle: Awaited<ReturnType<typeof fs.open>>; size: number }>();
  try {
    for (const key of keys) {
      const ref = store.records.get(key);
      if (!validReference(ref)) continue;
      try {
        let handle = handles.get(ref.pack);
        if (!handle) {
          // A batch can span many old packs after edits. Bound descriptor use.
          if (handles.size >= 16) {
            for (const h of handles.values()) await h.handle.close();
            handles.clear();
          }
          const opened = await fs.open(path.join(store.directory, ref.pack), 'r');
          handle = { handle: opened, size: 0 };
          handles.set(ref.pack, handle);
          handle.size = (await opened.stat()).size;
        }
        const length = ref.factsLength + ref.scopesLength;
        if (ref.offset + length > handle.size) continue;
        const data = Buffer.allocUnsafe(length);
        let got = 0;
        while (got < length) {
          const read = await handle.handle.read(data, got, length - got, ref.offset + got);
          if (!read.bytesRead) break;
          got += read.bytesRead;
        }
        if (got !== length) continue;
        const facts = data.subarray(0, ref.factsLength),
          scopes = data.subarray(ref.factsLength);
        if (digest(facts) !== ref.factsHash || digest(scopes) !== ref.scopesHash) continue;
        result.set(key, { key, path: ref.path, facts, scopes, cacheable: true });
      } catch {
        /* One damaged record/pack does not discard unrelated files. */
      }
    }
  } finally {
    for (const entry of handles.values()) await entry.handle.close();
  }
  return result;
}

/** Pin immutable bytes before accepting a hit. References survive live-store rotation. */
export async function pinFileResults(
  store: FileResultStore,
  keys: readonly string[],
  storagePath: string,
): Promise<void> {
  const directory = path.join(storagePath, 'parsedfile-store', 'file-results');
  await fs.mkdir(directory, { recursive: true });
  const packs = new Set<string>();
  const refs: FileResultReference[] = [];
  for (const key of keys) {
    const ref = store.records.get(key);
    if (!ref) throw new Error('Missing packed scope reference');
    refs.push(ref);
    packs.add(ref.pack);
  }
  for (const pack of packs) {
    const target = path.join(directory, pack);
    // Pack names are random and immutable after publication. A stage pack is
    // append-only; previously referenced byte ranges never change.
    const source = path.join(store.directory, pack);
    const sourceSize = (await fs.stat(source)).size;
    const targetSize = await fs
      .stat(target)
      .then((s) => s.size)
      .catch(() => -1);
    if (targetSize < sourceSize) await linkOrCopyFile(source, target);
  }
  if (refs.length)
    await fs.appendFile(
      path.join(directory, 'scopes.ndjson'),
      // Separate a previous short append from this complete batch. A failed
      // append can leave a partial final line even though its hits were rejected.
      '\n' + refs.map((ref) => JSON.stringify(ref) + '\n').join(''),
      { mode: 0o600 },
    );
}

/** Stream only requested scope sections through the existing ParsedFile sanitizer. */
export async function* loadPackedFileScopes(
  storagePath: string,
  wantPaths: ReadonlySet<string>,
  internPool: Map<string, string>,
): AsyncGenerator<V8CacheHit> {
  const directory = path.join(storagePath, 'parsedfile-store', 'file-results');
  const manifest = path.join(directory, 'scopes.ndjson');
  try {
    await fs.access(manifest);
  } catch {
    return;
  }
  const stream = createReadStream(manifest);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const handles = new Map<string, { handle: Awaited<ReturnType<typeof fs.open>>; size: number }>();
  try {
    for await (const line of lines) {
      let ref: FileResultReference;
      try {
        ref = JSON.parse(line);
      } catch {
        continue;
      }
      if (!validReference(ref) || !wantPaths.has(ref.path)) continue;
      try {
        let opened = handles.get(ref.pack);
        if (!opened) {
          if (handles.size >= 16) {
            for (const entry of handles.values()) await entry.handle.close();
            handles.clear();
          }
          const handle = await fs.open(path.join(directory, ref.pack), 'r');
          opened = { handle, size: 0 };
          handles.set(ref.pack, opened);
          opened.size = (await handle.stat()).size;
        }
        if (ref.offset + ref.factsLength + ref.scopesLength > opened.size) continue;
        const handle = opened.handle;
        const data = Buffer.allocUnsafe(ref.scopesLength);
        let got = 0;
        while (got < data.length) {
          const read = await handle.read(
            data,
            got,
            data.length - got,
            ref.offset + ref.factsLength + got,
          );
          if (!read.bytesRead) break;
          got += read.bytesRead;
        }
        if (got !== data.length || digest(data) !== ref.scopesHash) continue;
        const loaded = decodeFileResultSection(data, ref.key, ref.path, 'scopes', internPool);
        if (loaded) yield loaded;
      } catch {
        // Match legacy shard loading: one unreadable snapshot is a miss.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
    for (const entry of handles.values()) await entry.handle.close();
  }
}
