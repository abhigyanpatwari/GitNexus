#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const EVIDENCE_PROVENANCE_SCHEMA_VERSION = 2;
export const EVIDENCE_PROVENANCE_CANONICALIZATION =
  'gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records';

const ABSENT = 'absent';
const OBJECT_KINDS = new Set(['regular', 'symlink', 'gitlink', 'directory', ABSENT]);
const STATES = new Set([
  'clean',
  'staged',
  'unstaged',
  'untracked',
  'deleted',
  'renamed',
  'mixed',
  ABSENT,
]);
const RECORD_FIELDS = [
  'path',
  'state',
  'head_kind',
  'index_kind',
  'worktree_kind',
  'untracked_kind',
  'rename_from',
  'rename_to',
  'head_digest',
  'index_digest',
  'worktree_digest',
  'untracked_digest',
];
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });
const MAX_GIT_OUTPUT = 1024 * 1024 * 1024;
const MAX_PLAN_BYTES = 16 * 1024 * 1024;
const GENERATED_PLAN_READ_PATTERN = /^docs\/plans\/[^/]*gitnexus-plan[^/]*\.md$/;
const GENERATED_PLAN_WRITE_PATTERN =
  /^docs\/plans\/(\d{4}-\d{2}-\d{2})-gitnexus-plan-[a-z0-9]+(?:-[a-z0-9]+){2,4}\.md$/;
export const DIRECTORY_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxDepth: 256,
  maxBytes: 256 * 1024 * 1024,
});

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function statIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs]
    .map(String)
    .join(':');
}

function assertStableIdentity(before, after, label) {
  if (statIdentity(before) !== statIdentity(after)) {
    throw new Error(`${label} changed while evidence was being read`);
  }
}

function hashFile(file, mutationGuards, directoryTraversal) {
  const hash = createHash('sha256');
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error(`Expected a regular file at ${file}`);
    if (directoryTraversal) {
      directoryTraversal.bytes += before.size;
      if (directoryTraversal.bytes > BigInt(DIRECTORY_LIMITS.maxBytes)) {
        throw new Error(`Directory inventory exceeds ${DIRECTORY_LIMITS.maxBytes} content bytes`);
      }
    }
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    assertStableIdentity(before, after, file);
    mutationGuards.push({ type: 'stat', absolute: file, identity: statIdentity(after) });
  } finally {
    fs.closeSync(fd);
  }
  return `sha256:${hash.digest('hex')}`;
}

function git(repo, args, { allowFailure = false, input } = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: null,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
    input,
    maxBuffer: MAX_GIT_OUTPUT,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const stderr = Buffer.from(result.stderr ?? [])
      .toString('utf8')
      .trim();
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${stderr}`);
  }
  return {
    status: result.status,
    stdout: Buffer.from(result.stdout ?? []),
    stderr: Buffer.from(result.stderr ?? []),
  };
}

function decodeUtf8(bytes, label) {
  let decoded;
  try {
    decoded = UTF8_FATAL.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  return decoded;
}

export function normalizeRepoPath(input, label = 'path') {
  if (typeof input !== 'string') throw new Error(`${label} must be a string`);
  if (input.length === 0) throw new Error(`${label} must not be empty`);
  if (input.includes('\0')) throw new Error(`${label} must not contain NUL`);
  if (input.includes('\\')) throw new Error(`${label} must use POSIX '/' separators`);
  if (input !== input.normalize('NFC')) throw new Error(`${label} must already be Unicode NFC`);
  if (Buffer.from(input, 'utf8').toString('utf8') !== input) {
    throw new Error(`${label} contains an invalid Unicode scalar value`);
  }
  if (input.startsWith('/') || /^[A-Za-z]:\//.test(input)) {
    throw new Error(`${label} must be repo-relative`);
  }
  const components = input.split('/');
  if (components.some((component) => component === '' || component === '.' || component === '..')) {
    throw new Error(`${label} must be a normalized repo-relative path without dot segments`);
  }
  return input;
}

function requireString(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a literal boolean`);
  return value;
}

function normalizeSha256Digest(value, label = 'plan digest') {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be sha256:<64 lowercase hexadecimal characters>`);
  }
  return value;
}

function normalizeGeneratedPlanWritePath(input) {
  const normalized = normalizeRepoPath(input, 'generated plan path');
  const match = GENERATED_PLAN_WRITE_PATTERN.exec(normalized);
  if (!match) {
    throw new Error(
      'Generated-plan writes are restricted to docs/plans/YYYY-MM-DD-gitnexus-plan-<3-5-word-slug>.md',
    );
  }
  const parsedDate = new Date(`${match[1]}T00:00:00Z`);
  if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== match[1]) {
    throw new Error(`Generated-plan path has an invalid calendar date: ${match[1]}`);
  }
  return normalized;
}

function normalizeGeneratedPlanReadPath(input) {
  const normalized = normalizeRepoPath(input, 'existing plan path');
  if (!GENERATED_PLAN_READ_PATTERN.test(normalized)) {
    throw new Error('Existing-plan reads are restricted to docs/plans/*gitnexus-plan*.md');
  }
  return normalized;
}

function decodeRepoPath(bytes, label) {
  return normalizeRepoPath(decodeUtf8(bytes, label), label);
}

function splitNul(bytes) {
  const parts = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    parts.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start !== bytes.length) throw new Error('Git emitted a non-NUL-terminated record stream');
  return parts;
}

function splitFixedHeader(record, fieldCount, label) {
  const fields = [];
  let cursor = 0;
  for (let index = 0; index < fieldCount; index += 1) {
    const separator = record.indexOf(' ', cursor);
    if (separator < 0) throw new Error(`Malformed ${label} record`);
    fields.push(record.slice(cursor, separator));
    cursor = separator + 1;
  }
  return { fields, path: record.slice(cursor) };
}

function classifyXY(xy) {
  if (!/^[.MTADRCU?!]{2}$/.test(xy)) throw new Error(`Unsupported Git XY status: ${xy}`);
  const [indexState, worktreeState] = xy;
  if (indexState === 'U' || worktreeState === 'U') {
    throw new Error('Unmerged paths cannot be canonicalized; resolve the index first');
  }
  if (indexState !== '.' && worktreeState !== '.') return 'mixed';
  if (indexState === 'D' || worktreeState === 'D') return 'deleted';
  if (indexState !== '.') return 'staged';
  if (worktreeState !== '.') return 'unstaged';
  throw new Error(`Porcelain reported a non-dirty ordinary record (${xy})`);
}

function addDirtyRecord(records, record) {
  const incomingFacts = new Set(record.fact_states ?? [record.state]);
  const current = records.get(record.path);
  if (!current) {
    records.set(record.path, {
      ...record,
      fact_states: incomingFacts,
      has_untracked: record.has_untracked ?? record.state === 'untracked',
      directory_hint: record.directory_hint ?? false,
    });
    return;
  }
  const mergeEndpoint = (field) => {
    const left = current[field];
    const right = record[field];
    if (left && right && left !== right) {
      throw new Error(`Conflicting ${field} facts for ${JSON.stringify(record.path)}`);
    }
    return left ?? right ?? null;
  };
  const facts = new Set([...current.fact_states, ...incomingFacts]);
  current.fact_states = facts;
  current.state = facts.has('mixed') || facts.size > 1 ? 'mixed' : [...facts][0];
  current.rename_from = mergeEndpoint('rename_from');
  current.rename_to = mergeEndpoint('rename_to');
  current.has_untracked =
    current.has_untracked || record.has_untracked || record.state === 'untracked';
  current.directory_hint = current.directory_hint || record.directory_hint;
}

function readDirtySnapshot(repo) {
  const output = git(repo, [
    '-c',
    'diff.renameLimit=0',
    '-c',
    'status.renameLimit=0',
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
    '--find-renames=50%',
    '--ignore-submodules=none',
  ]).stdout;
  const tokens = splitNul(output);
  const records = new Map();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length === 0) continue;
    const kind = String.fromCharCode(token[0]);
    const text = decodeUtf8(token, 'git status record');

    if (kind === '1') {
      const parsed = splitFixedHeader(text, 8, 'ordinary status');
      const xy = parsed.fields[1];
      const repoPath = normalizeRepoPath(parsed.path, 'git status path');
      addDirtyRecord(records, {
        path: repoPath,
        state: classifyXY(xy),
        rename_from: null,
        rename_to: null,
        has_untracked: false,
      });
      continue;
    }

    if (kind === '2') {
      const parsed = splitFixedHeader(text, 9, 'rename status');
      const newPath = normalizeRepoPath(parsed.path, 'rename destination');
      index += 1;
      if (index >= tokens.length) throw new Error('Rename status is missing its source endpoint');
      const oldPath = decodeRepoPath(tokens[index], 'rename source');
      addDirtyRecord(records, {
        path: oldPath,
        state: 'renamed',
        rename_from: null,
        rename_to: newPath,
        has_untracked: false,
      });
      addDirtyRecord(records, {
        path: newPath,
        state: parsed.fields[1][1] === '.' ? 'renamed' : 'mixed',
        rename_from: oldPath,
        rename_to: null,
        has_untracked: false,
      });
      continue;
    }

    if (kind === '?') {
      const rawPath = text.slice(2);
      const directoryHint = rawPath.endsWith('/');
      const repoPath = normalizeRepoPath(
        directoryHint ? rawPath.slice(0, -1) : rawPath,
        'untracked path',
      );
      addDirtyRecord(records, {
        path: repoPath,
        state: 'untracked',
        rename_from: null,
        rename_to: null,
        has_untracked: true,
        directory_hint: directoryHint,
      });
      continue;
    }

    if (kind === 'u') {
      throw new Error('Unmerged paths cannot be canonicalized; resolve the index first');
    }
    if (kind !== '!') throw new Error(`Unsupported porcelain-v2 record kind: ${kind}`);
  }
  return { output, records };
}

function kindFromMode(mode) {
  if (mode === '040000') return 'directory';
  if (mode === '100644' || mode === '100755') return 'regular';
  if (mode === '120000') return 'symlink';
  if (mode === '160000') return 'gitlink';
  throw new Error(`Unsupported Git object mode: ${mode}`);
}

function readBatchObjects(repo, descriptors) {
  const requested = new Map();
  for (const descriptor of descriptors) {
    if (descriptor.kind === 'gitlink') continue;
    const expectedType = descriptor.kind === 'directory' ? 'tree' : 'blob';
    const prior = requested.get(descriptor.oid);
    if (prior && prior !== expectedType) {
      throw new Error(
        `Git object ${descriptor.oid} is requested as both ${prior} and ${expectedType}`,
      );
    }
    requested.set(descriptor.oid, expectedType);
  }
  if (requested.size === 0) return new Map();
  const input = Buffer.from(`${[...requested.keys()].join('\n')}\n`, 'ascii');
  const output = git(repo, ['cat-file', '--batch'], { input }).stdout;
  const digests = new Map();
  let cursor = 0;
  for (const [requestedOid, expectedType] of requested) {
    const newline = output.indexOf(10, cursor);
    if (newline < 0) throw new Error(`Missing cat-file header for ${requestedOid}`);
    const header = decodeUtf8(output.subarray(cursor, newline), 'cat-file header').split(' ');
    if (header.length !== 3 || header[0] !== requestedOid) {
      throw new Error(`Malformed cat-file header for ${requestedOid}`);
    }
    const [, actualType, sizeText] = header;
    const size = Number(sizeText);
    if (actualType !== expectedType || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Unexpected cat-file object metadata for ${requestedOid}`);
    }
    const start = newline + 1;
    const end = start + size;
    if (end >= output.length || output[end] !== 10) {
      throw new Error(`Truncated cat-file object ${requestedOid}`);
    }
    digests.set(requestedOid, sha256(output.subarray(start, end)));
    cursor = end + 1;
  }
  if (cursor !== output.length) throw new Error('cat-file emitted unexpected trailing bytes');
  return digests;
}

function loadGitLayers(repo, neededPaths, headOid, indexOutput) {
  const headDescriptors = new Map();
  const headOutput = git(repo, ['ls-tree', '-r', '-t', '-z', '--full-tree', headOid]).stdout;
  for (const record of splitNul(headOutput)) {
    if (record.length === 0) continue;
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error('Malformed HEAD tree entry');
    const repoPath = decodeRepoPath(record.subarray(tab + 1), 'HEAD path');
    if (!neededPaths.has(repoPath)) continue;
    const header = decodeUtf8(record.subarray(0, tab), 'HEAD entry').split(' ');
    if (header.length !== 3) throw new Error(`Malformed HEAD entry for ${repoPath}`);
    const [mode, type, oid] = header;
    const objectKind = kindFromMode(mode);
    const expectedType =
      objectKind === 'directory' ? 'tree' : objectKind === 'gitlink' ? 'commit' : 'blob';
    if (type !== expectedType) throw new Error(`Unexpected HEAD object type for ${repoPath}`);
    headDescriptors.set(repoPath, { kind: objectKind, oid });
  }

  const indexDescriptors = new Map();
  for (const record of splitNul(indexOutput)) {
    if (record.length === 0) continue;
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error('Malformed index entry');
    const repoPath = decodeRepoPath(record.subarray(tab + 1), 'index path');
    if (!neededPaths.has(repoPath)) continue;
    const header = decodeUtf8(record.subarray(0, tab), 'index entry').split(' ');
    if (header.length !== 3) throw new Error(`Malformed index entry for ${repoPath}`);
    const [mode, oid, stage] = header;
    if (stage !== '0' || indexDescriptors.has(repoPath)) {
      throw new Error(`Unmerged index stages cannot be canonicalized for ${repoPath}`);
    }
    const objectKind = kindFromMode(mode);
    if (objectKind === 'directory') throw new Error('The Git index cannot contain a tree entry');
    indexDescriptors.set(repoPath, { kind: objectKind, oid });
  }

  const allDescriptors = [...headDescriptors.values(), ...indexDescriptors.values()];
  const objectDigests = readBatchObjects(repo, allDescriptors);
  const materialize = (descriptor) => {
    if (!descriptor) return { kind: ABSENT, digest: ABSENT };
    return {
      kind: descriptor.kind,
      digest:
        descriptor.kind === 'gitlink'
          ? sha256(Buffer.from(descriptor.oid, 'ascii'))
          : objectDigests.get(descriptor.oid),
    };
  };
  return {
    head(repoPath) {
      return materialize(headDescriptors.get(repoPath));
    },
    index(repoPath) {
      return materialize(indexDescriptors.get(repoPath));
    },
  };
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function serializeFields(prefixFields, records, fields) {
  const chunks = [];
  const append = (value) => {
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new Error('Canonical provenance fields must be NUL-free strings');
    }
    chunks.push(Buffer.from(value, 'utf8'), Buffer.from([0]));
  };
  for (const field of prefixFields) append(field);
  chunks.push(Buffer.from([0]));
  for (const record of records) {
    append('record');
    for (const field of fields) {
      append(field);
      append(record[field]);
    }
    chunks.push(Buffer.from([0]));
  }
  return Buffer.concat(chunks);
}

function resolveOwnGitTopLevel(absolute) {
  const result = git(absolute, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (result.status !== 0) return null;
  let topLevel;
  try {
    topLevel = fs.realpathSync(decodeUtf8(result.stdout, 'nested repository root').trim());
  } catch {
    return null;
  }
  return topLevel === fs.realpathSync(absolute) ? topLevel : null;
}

function readOwnGitlinkHead(absolute) {
  const topLevel = resolveOwnGitTopLevel(absolute);
  if (!topLevel) {
    throw new Error(`Gitlink worktree is not its own repository: ${absolute}`);
  }
  const result = git(absolute, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  if (result.status !== 0)
    throw new Error(`Cannot resolve checked-out gitlink HEAD at ${absolute}`);
  const oid = decodeUtf8(result.stdout, 'gitlink HEAD').trim();
  if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new Error(`Invalid gitlink object ID at ${absolute}`);
  const status = git(absolute, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
    '--ignored=matching',
    '--ignore-submodules=none',
  ]).stdout;
  if (status.length !== 0) {
    throw new Error(
      `Checked-out gitlink is dirty at ${absolute}; commit or clean staged, unstaged, untracked, and ignored changes before snapshotting`,
    );
  }
  return { oid, topLevel };
}

function readStableSymlink(absolute, mutationGuards) {
  const before = fs.lstatSync(absolute, { bigint: true });
  const target = fs.readlinkSync(absolute, { encoding: 'buffer' });
  const after = fs.lstatSync(absolute, { bigint: true });
  assertStableIdentity(before, after, absolute);
  mutationGuards.push({
    type: 'symlink',
    absolute,
    identity: statIdentity(after),
    target: Buffer.from(target),
  });
  return { kind: 'symlink', digest: sha256(target) };
}

function digestDirectory(root, mutationGuards, testHooks) {
  const traversal = { entries: 0, bytes: 0n };
  const walk = (directory, depth) => {
    if (depth > DIRECTORY_LIMITS.maxDepth) {
      throw new Error(`Directory inventory exceeds depth ${DIRECTORY_LIMITS.maxDepth}`);
    }
    const before = fs.lstatSync(directory, { bigint: true });
    if (!before.isDirectory()) throw new Error(`Expected a directory at ${directory}`);
    const children = fs
      .readdirSync(directory, { withFileTypes: true, encoding: 'buffer' })
      .map((child) => ({
        child,
        name: decodeUtf8(Buffer.from(child.name), 'directory entry name'),
      }))
      .sort((left, right) => compareUtf8(left.name, right.name));
    const ownRepository = children.some(({ name }) => name === '.git')
      ? resolveOwnGitTopLevel(directory)
      : null;
    const entries = [];
    for (const { name: childName } of children) {
      if (ownRepository && childName === '.git') continue;
      normalizeRepoPath(childName, 'directory entry name');
      const absolute = path.join(directory, childName);
      const childStat = fs.lstatSync(absolute, { bigint: true });
      traversal.entries += 1;
      if (traversal.entries > DIRECTORY_LIMITS.maxEntries) {
        throw new Error(`Directory inventory exceeds ${DIRECTORY_LIMITS.maxEntries} entries`);
      }
      testHooks?.onDirectoryEntry?.({ absolute, count: traversal.entries, depth: depth + 1 });

      let layer;
      let descendants = [];
      if (childStat.isFile()) {
        layer = {
          kind: 'regular',
          digest: hashFile(absolute, mutationGuards, traversal),
        };
      } else if (childStat.isSymbolicLink()) {
        layer = readStableSymlink(absolute, mutationGuards);
      } else if (childStat.isDirectory()) {
        const nested = walk(absolute, depth + 1);
        layer = { kind: 'directory', digest: nested.digest };
        descendants = nested.entries.map((entry) => ({
          ...entry,
          path: `${childName}/${entry.path}`,
        }));
      } else {
        throw new Error(`Unsupported filesystem object at ${absolute}`);
      }
      entries.push({ path: childName, kind: layer.kind, digest: layer.digest }, ...descendants);
    }
    const after = fs.lstatSync(directory, { bigint: true });
    assertStableIdentity(before, after, directory);
    mutationGuards.push({ type: 'stat', absolute: directory, identity: statIdentity(after) });
    entries.sort((left, right) => compareUtf8(left.path, right.path));
    const bytes = serializeFields(['gitnexus-evidence-directory', 'schema_version', '1'], entries, [
      'path',
      'kind',
      'digest',
    ]);
    return { digest: sha256(bytes), entries };
  };
  return walk(root, 0).digest;
}

function filesystemObject(absolute, expectedKind, mutationGuards, testHooks) {
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { kind: ABSENT, digest: ABSENT };
    }
    throw error;
  }

  if (expectedKind === 'gitlink') {
    if (!stat.isDirectory()) throw new Error(`Expected gitlink directory at ${absolute}`);
    const { oid, topLevel } = readOwnGitlinkHead(absolute);
    mutationGuards.push({ type: 'gitlink', absolute, oid, topLevel });
    return { kind: 'gitlink', digest: sha256(Buffer.from(oid, 'ascii')) };
  }
  if (stat.isFile()) return { kind: 'regular', digest: hashFile(absolute, mutationGuards) };
  if (stat.isSymbolicLink()) return readStableSymlink(absolute, mutationGuards);
  if (stat.isDirectory()) {
    return { kind: 'directory', digest: digestDirectory(absolute, mutationGuards, testHooks) };
  }
  throw new Error(`Unsupported filesystem object at ${absolute}`);
}

function guardPathParents(repo, repoPath, mutationGuards) {
  const components = repoPath.split('/');
  let current = repo;
  const rootStat = fs.lstatSync(repo, { bigint: true });
  mutationGuards.push({
    type: 'directory',
    absolute: repo,
    identity: stableDirectoryIdentity(rootStat),
  });
  for (const component of components.slice(0, -1)) {
    current = path.join(current, component);
    let stat;
    try {
      stat = fs.lstatSync(current, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to traverse symlink parent for ${repoPath}`);
    }
    if (!stat.isDirectory()) return;
    mutationGuards.push({
      type: 'directory',
      absolute: current,
      identity: stableDirectoryIdentity(stat),
    });
  }
}

function recordAnchoredAbsence(repo, repoPath, mutationGuards) {
  requireDescriptorAnchoring();
  const flags =
    fs.constants.O_RDONLY |
    fs.constants.O_DIRECTORY |
    fs.constants.O_NOFOLLOW |
    (fs.constants.O_CLOEXEC ?? 0);
  const descriptors = [];
  let retainedFd;
  try {
    let currentFd = fs.openSync(repo, flags);
    descriptors.push(currentFd);
    const components = repoPath.split('/');
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index];
      const child = descriptorPath(currentFd, component);
      let childStat;
      try {
        childStat = fs.lstatSync(child, { bigint: true });
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
        const parentStat = fs.fstatSync(currentFd, { bigint: true });
        if (!parentStat.isDirectory()) {
          throw new Error(`Absence parent is no longer a directory for ${repoPath}`);
        }
        retainedFd = currentFd;
        mutationGuards.push({
          type: 'absence',
          fd: retainedFd,
          childName: component,
          repoPath,
          parentIdentity: stableDirectoryIdentity(parentStat),
          parentMutationIdentity: statIdentity(parentStat),
        });
        for (const fd of descriptors) {
          if (fd !== retainedFd) fs.closeSync(fd);
        }
        return;
      }
      if (index === components.length - 1) {
        throw new Error(`${repoPath} appeared while its absence was being anchored`);
      }
      if (childStat.isSymbolicLink() || !childStat.isDirectory()) {
        throw new Error(`Refusing a non-directory parent while anchoring absence for ${repoPath}`);
      }
      const nextFd = fs.openSync(child, flags);
      descriptors.push(nextFd);
      currentFd = nextFd;
    }
    throw new Error(`Could not anchor absence for ${repoPath}`);
  } catch (error) {
    for (const fd of descriptors) {
      if (fd === retainedFd) continue;
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the primary absence-anchoring error.
      }
    }
    throw error;
  }
}

function materializeRecord(repo, statusRecord, layers, mutationGuards, testHooks) {
  const head = layers.head(statusRecord.path);
  const index = layers.index(statusRecord.path);
  const expectedKind = index.kind === 'gitlink' || head.kind === 'gitlink' ? 'gitlink' : null;
  guardPathParents(repo, statusRecord.path, mutationGuards);
  const filesystem = filesystemObject(
    path.join(repo, ...statusRecord.path.split('/')),
    expectedKind,
    mutationGuards,
    testHooks,
  );
  if (filesystem.kind === ABSENT) recordAnchoredAbsence(repo, statusRecord.path, mutationGuards);
  if (statusRecord.directory_hint && filesystem.kind !== 'directory') {
    throw new Error(
      `Git reported an embedded directory but found ${filesystem.kind}: ${statusRecord.path}`,
    );
  }
  const isUntracked = statusRecord.has_untracked || (head.kind === ABSENT && index.kind === ABSENT);
  const worktree = isUntracked ? { kind: ABSENT, digest: ABSENT } : filesystem;
  const untracked = isUntracked ? filesystem : { kind: ABSENT, digest: ABSENT };

  return {
    path: statusRecord.path,
    object_kind: {
      head: head.kind,
      index: index.kind,
      worktree: worktree.kind,
      untracked: untracked.kind,
    },
    state: statusRecord.state,
    rename_from: statusRecord.rename_from,
    rename_to: statusRecord.rename_to,
    head_digest: head.digest,
    index_digest: index.digest,
    worktree_digest: worktree.digest,
    untracked_digest: untracked.digest,
  };
}

function canonicalRecord(manifestEntry) {
  const record = {
    path: manifestEntry.path,
    state: manifestEntry.state,
    head_kind: manifestEntry.object_kind.head,
    index_kind: manifestEntry.object_kind.index,
    worktree_kind: manifestEntry.object_kind.worktree,
    untracked_kind: manifestEntry.object_kind.untracked,
    rename_from: manifestEntry.rename_from ?? ABSENT,
    rename_to: manifestEntry.rename_to ?? ABSENT,
    head_digest: manifestEntry.head_digest,
    index_digest: manifestEntry.index_digest,
    worktree_digest: manifestEntry.worktree_digest,
    untracked_digest: manifestEntry.untracked_digest,
  };
  if (!STATES.has(record.state)) throw new Error(`Unsupported evidence state: ${record.state}`);
  for (const kindField of ['head_kind', 'index_kind', 'worktree_kind', 'untracked_kind']) {
    if (!OBJECT_KINDS.has(record[kindField])) {
      throw new Error(`Unsupported object kind: ${record[kindField]}`);
    }
  }
  return record;
}

export function serializeDirtyRecords(entries) {
  const records = entries
    .map(canonicalRecord)
    .sort((left, right) => compareUtf8(left.path, right.path));
  for (let index = 1; index < records.length; index += 1) {
    if (records[index - 1].path === records[index].path) {
      throw new Error(`Duplicate canonical dirty path: ${records[index].path}`);
    }
  }
  return serializeFields(
    ['gitnexus-evidence-provenance', 'schema_version', String(EVIDENCE_PROVENANCE_SCHEMA_VERSION)],
    records,
    RECORD_FIELDS,
  );
}

function assertRepository(repoInput) {
  const repo = fs.realpathSync(requireString(repoInput, 'repo'));
  const topLevelResult = git(repo, ['rev-parse', '--show-toplevel']);
  const topLevel = fs.realpathSync(decodeUtf8(topLevelResult.stdout, 'repository root').trim());
  if (topLevel !== repo) throw new Error(`--repo must be the Git worktree root (${topLevel})`);
  return repo;
}

function resolveAdministrativePath(repo, gitPath) {
  const raw = decodeUtf8(
    git(repo, ['rev-parse', '--git-path', gitPath]).stdout,
    `Git administrative path ${gitPath}`,
  ).trim();
  return path.resolve(repo, raw);
}

function captureControlFile(absolute, label) {
  let before;
  try {
    before = fs.lstatSync(absolute, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { absolute, label, kind: ABSENT };
    }
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} must be a regular no-follow file`);
  }
  const fd = fs.openSync(
    absolute,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_CLOEXEC ?? 0),
  );
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || statIdentity(opened) !== statIdentity(before)) {
      throw new Error(`${label} changed while its descriptor opened`);
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    assertStableIdentity(opened, after, label);
    return {
      absolute,
      label,
      kind: 'regular',
      identity: statIdentity(after),
      digest: `sha256:${hash.digest('hex')}`,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function verifyControlFile(guard) {
  const current = captureControlFile(guard.absolute, guard.label);
  if (
    current.kind !== guard.kind ||
    current.identity !== guard.identity ||
    current.digest !== guard.digest
  ) {
    throw new Error(`${guard.label} changed while evidence was materialized`);
  }
}

function captureHeadGuards(repo) {
  const symbolic = git(repo, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true });
  const paths = new Set(['HEAD', 'logs/HEAD', 'packed-refs']);
  if (symbolic.status === 0) {
    const ref = decodeUtf8(symbolic.stdout, 'symbolic HEAD ref').trim();
    if (!/^refs\/[A-Za-z0-9._\/-]+$/.test(ref) || ref.includes('..')) {
      throw new Error(`Invalid symbolic HEAD ref: ${ref}`);
    }
    paths.add(ref);
    paths.add(`logs/${ref}`);
  }
  return [...paths].map((gitPath) =>
    captureControlFile(resolveAdministrativePath(repo, gitPath), `Git ${gitPath}`),
  );
}

function stableDirectoryIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode].map(String).join(':');
}

function stableFileIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size].map(String).join(':');
}

function requireDescriptorAnchoring() {
  if (
    process.platform !== 'linux' ||
    fs.constants.O_DIRECTORY === undefined ||
    fs.constants.O_NOFOLLOW === undefined ||
    !fs.existsSync('/proc/self/fd')
  ) {
    throw new Error(
      'Safe generated-plan writes require Linux /proc/self/fd and O_DIRECTORY/O_NOFOLLOW; refusing an unanchored write',
    );
  }
}

function descriptorPath(fd, childName) {
  const base = `/proc/self/fd/${fd}`;
  return childName === undefined ? base : path.join(base, childName);
}

function externalDescriptorPath(fd, childName) {
  const base = `/proc/${process.pid}/fd/${fd}`;
  return childName === undefined ? base : path.join(base, childName);
}

const RENAME_NOREPLACE_SCRIPT = String.raw`
import ctypes
import errno
import os
import sys

libc = ctypes.CDLL(None, use_errno=True)
try:
    renameat2 = libc.renameat2
except AttributeError:
    print("libc does not expose renameat2", file=sys.stderr)
    raise SystemExit(125)

renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
result = renameat2(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 1)
if result != 0:
    error_number = ctypes.get_errno()
    error_name = errno.errorcode.get(error_number, "UNKNOWN")
    print(f"renameat2 RENAME_NOREPLACE failed: {error_name}: {os.strerror(error_number)}", file=sys.stderr)
    raise SystemExit(17 if error_number == errno.EEXIST else 126)
`;

let atomicMoverPath;

function spawnHeldExecutable(executable, args, options) {
  const before = fs.fstatSync(executable.fd, { bigint: true });
  if (!before.isFile() || statIdentity(before) !== executable.identity) {
    throw new Error('Validated Python executable changed before invocation');
  }
  const result = spawnSync('/proc/self/fd/3', args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe', executable.fd],
  });
  const after = fs.fstatSync(executable.fd, { bigint: true });
  assertStableIdentity(before, after, 'validated Python executable');
  return result;
}

function validatedPathExecutable(candidate) {
  if (!path.isAbsolute(candidate)) return null;
  const candidateDirectory = path.dirname(candidate);
  let resolvedDirectory;
  let resolved;
  let directoryStats;
  let executableStat;
  try {
    resolvedDirectory = fs.realpathSync(candidateDirectory);
    resolved = fs.realpathSync(candidate);
    const resolvedExecutableDirectory = fs.realpathSync(path.dirname(resolved));
    directoryStats = [...new Set([resolvedDirectory, resolvedExecutableDirectory])].map(
      (directory) => fs.statSync(directory),
    );
    executableStat = fs.lstatSync(resolved);
    fs.accessSync(resolved, fs.constants.X_OK);
  } catch {
    return null;
  }
  if (
    directoryStats.some((stat) => !stat.isDirectory()) ||
    !executableStat.isFile() ||
    executableStat.isSymbolicLink()
  ) {
    return null;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const trustedOwner = (stat) => uid === null || stat.uid === 0 || stat.uid === uid;
  if (
    directoryStats.some((stat) => !trustedOwner(stat) || (stat.mode & 0o022) !== 0) ||
    !trustedOwner(executableStat) ||
    (executableStat.mode & 0o022) !== 0
  ) {
    return null;
  }
  return resolved;
}

function resolveAtomicMover() {
  if (atomicMoverPath) return atomicMoverPath;
  const candidates = new Set();
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (entry && path.isAbsolute(entry)) candidates.add(path.join(entry, 'python3'));
  }
  for (const entry of ['/usr/local/bin/python3', '/usr/bin/python3', '/bin/python3']) {
    candidates.add(entry);
  }
  for (const candidate of candidates) {
    const resolved = validatedPathExecutable(candidate);
    if (!resolved) continue;
    let fd;
    try {
      fd = fs.openSync(
        resolved,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_CLOEXEC ?? 0),
      );
    } catch {
      continue;
    }
    const opened = fs.fstatSync(fd, { bigint: true });
    const executable = { fd, identity: statIdentity(opened), resolved };
    const version = spawnHeldExecutable(
      executable,
      ['-I', '-S', '-c', 'import sys; print(sys.version_info[0])'],
      {
        encoding: 'utf8',
        env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
        timeout: 10_000,
        windowsHide: true,
      },
    );
    if (version.status === 0 && version.stdout.trim() === '3') {
      atomicMoverPath = executable;
      return executable;
    }
    fs.closeSync(fd);
  }
  throw new Error(
    'Safe generated-plan publication requires a trusted absolute Python 3 PATH candidate with libc renameat2 support',
  );
}

function atomicMoveNoReplace(source, destination) {
  const mover = resolveAtomicMover();
  const result = spawnHeldExecutable(
    mover,
    ['-I', '-S', '-c', RENAME_NOREPLACE_SCRIPT, source, destination],
    {
      encoding: 'utf8',
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
      timeout: 10_000,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status === 17) return false;
  if (result.status !== 0) {
    throw new Error(
      `Atomic no-replace move failed (${result.status}): ${(result.stderr ?? '').trim()}`,
    );
  }
  return true;
}

function lstatOptional(absolute) {
  try {
    return fs.lstatSync(absolute, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

function openPlanParent(
  repo,
  parentComponents,
  { createMissing = true, purpose = 'Generated-plan' } = {},
) {
  requireDescriptorAnchoring();
  const flags =
    fs.constants.O_RDONLY |
    fs.constants.O_DIRECTORY |
    fs.constants.O_NOFOLLOW |
    (fs.constants.O_CLOEXEC ?? 0);
  const descriptors = [];
  try {
    let currentFd = fs.openSync(repo, flags);
    descriptors.push(currentFd);
    const rootStat = fs.fstatSync(currentFd, { bigint: true });
    const chain = [{ expectedPath: repo, identity: stableDirectoryIdentity(rootStat) }];
    const traversed = [];
    for (const component of parentComponents) {
      traversed.push(component);
      const anchoredChild = descriptorPath(currentFd, component);
      let childStat;
      let created = false;
      try {
        childStat = fs.lstatSync(anchoredChild, { bigint: true });
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
        if (!createMissing) {
          throw new Error(`${purpose} parent does not exist: ${traversed.join('/')}`);
        }
        fs.mkdirSync(anchoredChild, { mode: 0o755 });
        childStat = fs.lstatSync(anchoredChild, { bigint: true });
        created = true;
      }
      if (childStat.isSymbolicLink() || !childStat.isDirectory()) {
        throw new Error(`${purpose} parent is not a real directory: ${traversed.join('/')}`);
      }
      const parentFd = currentFd;
      const childFd = fs.openSync(anchoredChild, flags);
      descriptors.push(childFd);
      currentFd = childFd;
      if (created) {
        fs.fsyncSync(childFd);
        fs.fsyncSync(parentFd);
      }
      const expected = path.join(repo, ...traversed);
      const actual = fs.realpathSync(descriptorPath(currentFd));
      if (actual !== expected) {
        throw new Error(`${purpose} parent escaped the repository: ${traversed.join('/')}`);
      }
      const openedStat = fs.fstatSync(currentFd, { bigint: true });
      chain.push({ expectedPath: expected, identity: stableDirectoryIdentity(openedStat) });
    }
    const stat = fs.fstatSync(currentFd, { bigint: true });
    return {
      descriptors,
      fd: currentFd,
      identity: stableDirectoryIdentity(stat),
      expectedPath: path.join(repo, ...parentComponents),
      chain,
    };
  } catch (error) {
    closeDescriptors(descriptors);
    throw error;
  }
}

function closeDescriptors(descriptors) {
  for (const fd of [...descriptors].reverse()) {
    try {
      fs.closeSync(fd);
    } catch {
      // Preserve the primary write result/error.
    }
  }
}

function resolveGitDirectory(repo) {
  const result = git(repo, ['rev-parse', '--absolute-git-dir']);
  return fs.realpathSync(decodeUtf8(result.stdout, 'Git administrative directory').trim());
}

function openBackupVault(repo, { createMissing = true } = {}) {
  const gitDirectory = resolveGitDirectory(repo);
  const handle = openPlanParent(gitDirectory, ['gitnexus-plan-backups'], {
    createMissing,
    purpose: 'Git-admin backup vault',
  });
  fs.fchmodSync(handle.fd, 0o700);
  fs.fsyncSync(handle.fd);
  const stat = fs.fstatSync(handle.fd, { bigint: true });
  handle.identity = stableDirectoryIdentity(stat);
  handle.chain[handle.chain.length - 1].identity = handle.identity;
  return { ...handle, gitDirectory };
}

function validatePlanParent(parentHandle) {
  const descriptorStat = fs.fstatSync(parentHandle.fd, { bigint: true });
  if (
    !descriptorStat.isDirectory() ||
    stableDirectoryIdentity(descriptorStat) !== parentHandle.identity
  ) {
    throw new Error('Generated-plan parent descriptor changed during the write');
  }
  const descriptorRealPath = fs.realpathSync(descriptorPath(parentHandle.fd));
  if (descriptorRealPath !== parentHandle.expectedPath) {
    throw new Error('Generated-plan parent moved or was replaced during the write');
  }
  for (const item of parentHandle.chain) {
    const lexicalStat = fs.lstatSync(item.expectedPath, { bigint: true });
    if (
      lexicalStat.isSymbolicLink() ||
      !lexicalStat.isDirectory() ||
      stableDirectoryIdentity(lexicalStat) !== item.identity
    ) {
      throw new Error('Generated-plan lexical parent no longer matches its directory descriptor');
    }
  }
}

function inspectPlanDestination(
  finalPath,
  { replace, expectedIdentity, mustBeAbsent = false } = {},
) {
  let stat;
  try {
    stat = fs.lstatSync(finalPath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      if (expectedIdentity) throw new Error('Generated plan disappeared during the write');
      return null;
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Generated-plan destination must be a regular file, never a symlink');
  }
  if (mustBeAbsent) throw new Error('Generated plan appeared during the write');
  const identity = statIdentity(stat);
  if (!replace)
    throw new Error('Generated plan already exists; use --replace only for Deepen mode');
  if (expectedIdentity && identity !== expectedIdentity) {
    throw new Error('Generated plan changed during the write');
  }
  return identity;
}

function openExistingPlanDestination(finalPath, replace) {
  const identity = inspectPlanDestination(finalPath, { replace });
  if (identity === null) {
    if (replace) throw new Error('Deepen mode requires an existing generated plan to replace');
    return { fd: undefined, identity: null, stableIdentity: null };
  }
  const fd = fs.openSync(
    finalPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_CLOEXEC ?? 0),
  );
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || statIdentity(opened) !== identity) {
      throw new Error('Generated plan changed while its no-follow descriptor was opened');
    }
    return { fd, identity, stableIdentity: stableFileIdentity(opened) };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function validateOpenPlanDestination(destination) {
  if (destination.fd === undefined) return;
  const opened = fs.fstatSync(destination.fd, { bigint: true });
  if (!opened.isFile() || statIdentity(opened) !== destination.identity) {
    throw new Error('Generated plan changed through its open descriptor');
  }
}

function writeAll(fd, contents) {
  let offset = 0;
  while (offset < contents.length) {
    const written = fs.writeSync(fd, contents, offset, contents.length - offset);
    if (written <= 0) throw new Error('Generated-plan write made no progress');
    offset += written;
  }
}

function hashOpenFile(fd, label) {
  const before = fs.fstatSync(fd, { bigint: true });
  if (!before.isFile()) throw new Error(`${label} is no longer a regular file`);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  for (;;) {
    const count = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (count === 0) break;
    hash.update(buffer.subarray(0, count));
    position += count;
  }
  const after = fs.fstatSync(fd, { bigint: true });
  assertStableIdentity(before, after, label);
  return {
    digest: `sha256:${hash.digest('hex')}`,
    identity: stableFileIdentity(after),
    size: after.size,
  };
}

function validateCommittedPlan(finalPath, tempFd, expectedTemp, testHooks) {
  const before = fs.lstatSync(finalPath, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    stableFileIdentity(before) !== expectedTemp.identity
  ) {
    throw new Error('Generated-plan destination failed its first post-write identity check');
  }
  const finalFd = fs.openSync(
    finalPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_CLOEXEC ?? 0),
  );
  try {
    const opened = fs.fstatSync(finalFd, { bigint: true });
    if (!opened.isFile() || stableFileIdentity(opened) !== expectedTemp.identity) {
      throw new Error('Generated-plan destination changed while its no-follow descriptor opened');
    }
    testHooks?.afterFinalOpen?.({ fd: finalFd, finalPath });
    const committedViaTemp = hashOpenFile(tempFd, 'generated-plan committed file');
    const committedViaPath = hashOpenFile(finalFd, 'generated-plan destination descriptor');
    const after = fs.lstatSync(finalPath, { bigint: true });
    const openedAfter = fs.fstatSync(finalFd, { bigint: true });
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      stableFileIdentity(after) !== expectedTemp.identity ||
      stableFileIdentity(openedAfter) !== expectedTemp.identity ||
      committedViaTemp.identity !== expectedTemp.identity ||
      committedViaPath.identity !== expectedTemp.identity ||
      committedViaTemp.digest !== expectedTemp.digest ||
      committedViaPath.digest !== expectedTemp.digest
    ) {
      throw new Error('Generated-plan destination failed post-write verification');
    }
  } finally {
    fs.closeSync(finalFd);
  }
}

function copyOpenFile(sourceFd, destinationFd, label) {
  const before = fs.fstatSync(sourceFd, { bigint: true });
  if (!before.isFile()) throw new Error(`${label} source is no longer a regular file`);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  for (;;) {
    const count = fs.readSync(sourceFd, buffer, 0, buffer.length, position);
    if (count === 0) break;
    writeAll(destinationFd, buffer.subarray(0, count));
    position += count;
  }
  const after = fs.fstatSync(sourceFd, { bigint: true });
  assertStableIdentity(before, after, `${label} source`);
  return after;
}

function openVerifiedPathFile(absolute, label) {
  const before = fs.lstatSync(absolute, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} is not a regular no-follow file`);
  }
  const fd = fs.openSync(
    absolute,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_CLOEXEC ?? 0),
  );
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || stableFileIdentity(opened) !== stableFileIdentity(before)) {
      throw new Error(`${label} changed while its descriptor opened`);
    }
    const layer = hashOpenFile(fd, label);
    const after = fs.lstatSync(absolute, { bigint: true });
    if (after.isSymbolicLink() || !after.isFile() || stableFileIdentity(after) !== layer.identity) {
      throw new Error(`${label} changed after verification`);
    }
    return { fd, layer };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function readPlanSafely({ repo: repoInput, generatedPlanPath, testHooks } = {}) {
  const repo = assertRepository(repoInput);
  const generatedPlan = normalizeGeneratedPlanReadPath(generatedPlanPath);
  const components = generatedPlan.split('/');
  const finalName = components.pop();
  const parentHandle = openPlanParent(repo, components, {
    createMissing: false,
    purpose: 'Loaded-plan',
  });
  let fd;
  try {
    validatePlanParent(parentHandle);
    const finalPath = descriptorPath(parentHandle.fd, finalName);
    let before;
    try {
      before = fs.lstatSync(finalPath, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        throw new Error(`Loaded plan does not exist: ${generatedPlan}`);
      }
      throw error;
    }
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error('Loaded plan must be a regular file, never a symlink');
    }
    fd = fs.openSync(
      finalPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_CLOEXEC ?? 0),
    );
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || statIdentity(opened) !== statIdentity(before)) {
      throw new Error('Loaded plan changed while its no-follow descriptor opened');
    }
    testHooks?.afterPlanOpen?.({ fd, finalPath });
    const chunks = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_PLAN_BYTES) throw new Error(`Loaded plan exceeds ${MAX_PLAN_BYTES} bytes`);
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const contents = Buffer.concat(chunks, total);
    decodeUtf8(contents, 'loaded plan');
    const after = fs.fstatSync(fd, { bigint: true });
    assertStableIdentity(opened, after, 'loaded plan');
    const pathAfter = fs.lstatSync(finalPath, { bigint: true });
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      statIdentity(pathAfter) !== statIdentity(after)
    ) {
      throw new Error('Loaded plan changed before its receipt was produced');
    }
    validatePlanParent(parentHandle);
    return {
      generated_plan_path: generatedPlan,
      bytes_read: contents.length,
      plan_digest: sha256(contents),
      plan_bytes_base64: contents.toString('base64'),
    };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    closeDescriptors(parentHandle.descriptors);
  }
}

function artifactGitPath(name) {
  return `gitnexus-plan-backups/${name}`;
}

function verifyVaultArtifactFromFreshRoot(repo, gitPath, expectedLayer) {
  const components = gitPath.split('/');
  if (components.length !== 2 || components[0] !== 'gitnexus-plan-backups') {
    throw new Error(`Invalid Git-admin artifact path: ${gitPath}`);
  }
  const freshVault = openBackupVault(repo, { createMissing: false });
  try {
    validatePlanParent(freshVault);
    const opened = openVerifiedPathFile(
      descriptorPath(freshVault.fd, components[1]),
      `Git-admin artifact ${gitPath}`,
    );
    try {
      if (
        opened.layer.identity !== expectedLayer.identity ||
        opened.layer.digest !== expectedLayer.digest
      ) {
        throw new Error(`Git-admin artifact changed before fresh-root verification: ${gitPath}`);
      }
    } finally {
      fs.closeSync(opened.fd);
    }
  } finally {
    closeDescriptors(freshVault.descriptors);
  }
}

function createVaultCopyFromFd(repo, vault, sourceFd, role) {
  validatePlanParent(vault);
  const name = `.gitnexus-plan-${role}-${process.pid}-${randomBytes(16).toString('hex')}.bak`;
  const absolute = descriptorPath(vault.fd, name);
  const destinationFd = fs.openSync(
    absolute,
    fs.constants.O_RDWR |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW |
      (fs.constants.O_CLOEXEC ?? 0),
    0o600,
  );
  let destination;
  try {
    const sourceStat = copyOpenFile(sourceFd, destinationFd, role);
    fs.fchmodSync(destinationFd, Number(sourceStat.mode & 0o777n));
    fs.fsyncSync(destinationFd);
    const source = hashOpenFile(sourceFd, role);
    destination = hashOpenFile(destinationFd, `${role} vault copy`);
    if (source.size !== destination.size || source.digest !== destination.digest) {
      throw new Error(`${role} vault copy does not match its held source descriptor`);
    }
    const pathStat = fs.lstatSync(absolute, { bigint: true });
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      stableFileIdentity(pathStat) !== destination.identity
    ) {
      throw new Error(`${role} vault path changed during preservation`);
    }
    fs.fsyncSync(vault.fd);
  } finally {
    fs.closeSync(destinationFd);
  }
  const gitPath = artifactGitPath(name);
  verifyVaultArtifactFromFreshRoot(repo, gitPath, destination);
  return { role, gitPath, layer: destination };
}

function createVaultCopyFromBytes(repo, vault, contents, role) {
  validatePlanParent(vault);
  const name = `.gitnexus-plan-${role}-${process.pid}-${randomBytes(16).toString('hex')}.bak`;
  const absolute = descriptorPath(vault.fd, name);
  const fd = fs.openSync(
    absolute,
    fs.constants.O_RDWR |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW |
      (fs.constants.O_CLOEXEC ?? 0),
    0o600,
  );
  let layer;
  try {
    writeAll(fd, contents);
    fs.fchmodSync(fd, 0o644);
    fs.fsyncSync(fd);
    layer = hashOpenFile(fd, `${role} vault copy`);
    if (layer.size !== BigInt(contents.length) || layer.digest !== sha256(contents)) {
      throw new Error(`${role} vault copy does not match the intended plan bytes`);
    }
    const pathStat = fs.lstatSync(absolute, { bigint: true });
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      stableFileIdentity(pathStat) !== layer.identity
    ) {
      throw new Error(`${role} vault path changed during preservation`);
    }
    fs.fsyncSync(vault.fd);
  } finally {
    fs.closeSync(fd);
  }
  const gitPath = artifactGitPath(name);
  verifyVaultArtifactFromFreshRoot(repo, gitPath, layer);
  return { role, gitPath, layer };
}

function movePathToVault(repo, sourceHandle, sourceName, vault, role) {
  const source = descriptorPath(sourceHandle.fd, sourceName);
  if (!lstatOptional(source)) return null;
  const name = `.gitnexus-plan-${role}-${process.pid}-${randomBytes(16).toString('hex')}.bak`;
  const destination = descriptorPath(vault.fd, name);
  const moved = atomicMoveNoReplace(
    externalDescriptorPath(sourceHandle.fd, sourceName),
    externalDescriptorPath(vault.fd, name),
  );
  if (!moved) throw new Error(`${role} preservation destination unexpectedly exists`);
  fs.fsyncSync(sourceHandle.fd);
  if (vault.fd !== sourceHandle.fd) fs.fsyncSync(vault.fd);
  const sourceAfter = lstatOptional(source);
  const destinationAfter = lstatOptional(destination);
  if (sourceAfter || !destinationAfter) {
    throw new Error(`${role} could not be atomically moved into the Git-admin vault`);
  }
  const opened = openVerifiedPathFile(destination, `${role} Git-admin artifact`);
  const gitPath = artifactGitPath(name);
  verifyVaultArtifactFromFreshRoot(repo, gitPath, opened.layer);
  return { role, gitPath, layer: opened.layer, fd: opened.fd };
}

function formatPreservedArtifacts(artifacts) {
  if (artifacts.length === 0) return '';
  return `; preserved Git-admin artifacts: ${artifacts
    .map((artifact) => `${artifact.role}=git-path:${artifact.gitPath}`)
    .join(', ')}`;
}

export function writePlanSafely({
  repo: repoInput,
  generatedPlanPath,
  contents: inputContents,
  replace = false,
  expectedPlanPath,
  expectedPlanDigest,
  testHooks,
} = {}) {
  const shouldReplace = requireBoolean(replace, 'replace');
  if (!Buffer.isBuffer(inputContents) && typeof inputContents !== 'string') {
    throw new Error('contents must be a string or Buffer');
  }
  let expectedDigest;
  if (shouldReplace) {
    expectedDigest = normalizeSha256Digest(
      expectedPlanDigest,
      'expectedPlanDigest from the read-plan receipt',
    );
  } else if (expectedPlanPath !== undefined || expectedPlanDigest !== undefined) {
    throw new Error('expectedPlanPath and expectedPlanDigest are valid only when replace is true');
  }
  const repo = assertRepository(repoInput);
  const generatedPlan = normalizeGeneratedPlanWritePath(generatedPlanPath);
  if (shouldReplace) {
    const receiptPath = normalizeGeneratedPlanWritePath(
      requireString(expectedPlanPath, 'expectedPlanPath from the read-plan receipt'),
    );
    if (receiptPath !== generatedPlan) {
      throw new Error(
        'expectedPlanPath from the read-plan receipt must exactly match generatedPlanPath',
      );
    }
  }
  const contents = Buffer.isBuffer(inputContents)
    ? Buffer.from(inputContents)
    : Buffer.from(inputContents, 'utf8');
  decodeUtf8(contents, 'generated plan');
  if (contents.length > MAX_PLAN_BYTES) {
    throw new Error(`Generated plan exceeds ${MAX_PLAN_BYTES} bytes`);
  }
  const components = generatedPlan.split('/');
  const finalName = components.pop();
  let parentHandle;
  let vaultHandle;
  let tempPath;
  let tempName;
  let tempFd;
  let finalPath;
  let expectedTemp;
  let originalDestination;
  let priorBackup;
  const preservedArtifacts = [];
  try {
    parentHandle = openPlanParent(repo, components);
    vaultHandle = openBackupVault(repo);
    resolveAtomicMover();
    const parentDevice = fs.fstatSync(parentHandle.fd, { bigint: true }).dev;
    const vaultDevice = fs.fstatSync(vaultHandle.fd, { bigint: true }).dev;
    if (parentDevice !== vaultDevice) {
      throw new Error(
        'Generated-plan parent and Git-admin backup vault must share a filesystem for atomic publication',
      );
    }
    testHooks?.afterParentOpen?.({ fd: parentHandle.fd, path: parentHandle.expectedPath });
    validatePlanParent(parentHandle);
    validatePlanParent(vaultHandle);
    finalPath = descriptorPath(parentHandle.fd, finalName);
    originalDestination = openExistingPlanDestination(finalPath, shouldReplace);
    tempName = `.gitnexus-plan-${process.pid}-${randomBytes(16).toString('hex')}.tmp`;
    tempPath = descriptorPath(parentHandle.fd, tempName);
    tempFd = fs.openSync(
      tempPath,
      fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW |
        (fs.constants.O_CLOEXEC ?? 0),
      0o600,
    );
    writeAll(tempFd, contents);
    fs.fchmodSync(tempFd, 0o644);
    fs.fsyncSync(tempFd);
    expectedTemp = hashOpenFile(tempFd, 'generated-plan temporary file');
    if (expectedTemp.size !== BigInt(contents.length) || expectedTemp.digest !== sha256(contents)) {
      throw new Error('Generated-plan temporary file failed verification');
    }

    testHooks?.beforeRename?.({
      fd: parentHandle.fd,
      path: parentHandle.expectedPath,
      tempPath,
    });
    validatePlanParent(parentHandle);
    validatePlanParent(vaultHandle);
    validateOpenPlanDestination(originalDestination);
    const tempPathStat = fs.lstatSync(tempPath, { bigint: true });
    const currentTemp = hashOpenFile(tempFd, 'generated-plan temporary file');
    if (
      tempPathStat.isSymbolicLink() ||
      !tempPathStat.isFile() ||
      stableFileIdentity(tempPathStat) !== expectedTemp.identity ||
      currentTemp.identity !== expectedTemp.identity ||
      currentTemp.digest !== expectedTemp.digest
    ) {
      throw new Error('Generated-plan temporary path or content changed before rename');
    }

    if (shouldReplace) {
      testHooks?.beforeBackupMove?.({ fd: parentHandle.fd, finalPath });
      const originalLayer = hashOpenFile(originalDestination.fd, 'prior generated plan');
      if (originalLayer.digest !== expectedDigest) {
        throw new Error(
          'Generated plan no longer matches the exact digest from the read-plan receipt',
        );
      }
      validatePlanParent(parentHandle);
      validateOpenPlanDestination(originalDestination);
      inspectPlanDestination(finalPath, {
        replace: true,
        expectedIdentity: originalDestination.identity,
      });
      priorBackup = movePathToVault(repo, parentHandle, finalName, vaultHandle, 'prior-plan');
      if (!priorBackup) {
        throw new Error('Existing generated plan disappeared before preservation');
      }
      preservedArtifacts.push(priorBackup);
      if (
        priorBackup.layer.identity !== originalDestination.stableIdentity ||
        priorBackup.layer.digest !== originalLayer.digest
      ) {
        preservedArtifacts.push(
          createVaultCopyFromFd(repo, vaultHandle, originalDestination.fd, 'expected-prior-plan'),
        );
        throw new Error('Destination raced while the prior plan was moved into preservation');
      }
      if (lstatOptional(finalPath)) {
        throw new Error('Destination reappeared after the prior plan was preserved');
      }
    }

    testHooks?.beforePublication?.({
      fd: parentHandle.fd,
      finalPath,
      tempPath,
      replace: shouldReplace,
    });
    validatePlanParent(parentHandle);
    validatePlanParent(vaultHandle);
    const finalTempPathStat = fs.lstatSync(tempPath, { bigint: true });
    const finalTemp = hashOpenFile(tempFd, 'generated-plan temporary file');
    if (
      finalTempPathStat.isSymbolicLink() ||
      !finalTempPathStat.isFile() ||
      stableFileIdentity(finalTempPathStat) !== expectedTemp.identity ||
      finalTemp.identity !== expectedTemp.identity ||
      finalTemp.digest !== expectedTemp.digest
    ) {
      throw new Error('Generated-plan temporary path or content changed at publication');
    }
    atomicMoveNoReplace(
      externalDescriptorPath(parentHandle.fd, tempName),
      externalDescriptorPath(parentHandle.fd, finalName),
    );
    if (lstatOptional(tempPath) || !lstatOptional(finalPath)) {
      throw new Error('Generated-plan publication was refused because the destination raced');
    }
    fs.fsyncSync(parentHandle.fd);
    testHooks?.afterPublication?.({ fd: parentHandle.fd, finalPath });
    testHooks?.afterRename?.({ fd: parentHandle.fd, finalPath });
    validatePlanParent(parentHandle);
    validatePlanParent(vaultHandle);
    validateCommittedPlan(finalPath, tempFd, expectedTemp, testHooks);
    const receipt = { generated_plan_path: generatedPlan, bytes_written: contents.length };
    if (priorBackup) receipt.prior_plan_backup_git_path = priorBackup.gitPath;
    return receipt;
  } catch (error) {
    const preservationErrors = [];
    let intendedPreserved = preservedArtifacts.some(
      (artifact) =>
        expectedTemp &&
        artifact.layer.identity === expectedTemp.identity &&
        artifact.layer.digest === expectedTemp.digest,
    );
    if (parentHandle && vaultHandle && tempName) {
      try {
        const movedTemp = movePathToVault(
          repo,
          parentHandle,
          tempName,
          vaultHandle,
          'unpublished-plan',
        );
        if (movedTemp) {
          preservedArtifacts.push(movedTemp);
          intendedPreserved =
            Boolean(expectedTemp) &&
            movedTemp.layer.identity === expectedTemp.identity &&
            movedTemp.layer.digest === expectedTemp.digest;
          fs.closeSync(movedTemp.fd);
        }
      } catch (preservationError) {
        preservationErrors.push(preservationError);
      }
    }
    if (vaultHandle && expectedTemp && !intendedPreserved) {
      try {
        preservedArtifacts.push(
          createVaultCopyFromBytes(repo, vaultHandle, contents, 'intended-plan'),
        );
      } catch (preservationError) {
        preservationErrors.push(preservationError);
      }
    }
    if (vaultHandle && originalDestination?.fd !== undefined) {
      try {
        const originalLayer = hashOpenFile(originalDestination.fd, 'prior generated plan');
        const priorPreserved = preservedArtifacts.some(
          (artifact) => artifact.layer.digest === originalLayer.digest,
        );
        if (!priorPreserved) {
          preservedArtifacts.push(
            createVaultCopyFromFd(repo, vaultHandle, originalDestination.fd, 'expected-prior-plan'),
          );
        }
      } catch (preservationError) {
        preservationErrors.push(preservationError);
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    const artifactSummary = formatPreservedArtifacts(preservedArtifacts);
    const preservationSummary =
      preservationErrors.length === 0
        ? ''
        : `; preservation failures: ${preservationErrors
            .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
            .join(' | ')}`;
    if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EROFS') {
      throw new Error(
        `Cannot safely write generated plan: checkout is read-only or its parent is not writable (${error.code})${artifactSummary}${preservationSummary}`,
      );
    }
    throw new Error(`${message}${artifactSummary}${preservationSummary}`);
  } finally {
    if (priorBackup?.fd !== undefined) {
      try {
        fs.closeSync(priorBackup.fd);
      } catch {
        // Preserve the primary write result/error.
      }
    }
    if (originalDestination?.fd !== undefined) {
      try {
        fs.closeSync(originalDestination.fd);
      } catch {
        // Preserve the primary write result/error.
      }
    }
    if (tempFd !== undefined) {
      try {
        fs.closeSync(tempFd);
      } catch {
        // Preserve the primary write result/error.
      }
    }
    if (vaultHandle) closeDescriptors(vaultHandle.descriptors);
    if (parentHandle) closeDescriptors(parentHandle.descriptors);
  }
}

export function snapshotEvidence({
  repo: repoInput,
  generatedPlanPath,
  citedPaths = [],
  testHooks,
} = {}) {
  if (!Array.isArray(citedPaths) || citedPaths.some((entry) => typeof entry !== 'string')) {
    throw new Error('citedPaths must be an array of strings');
  }
  const repo = assertRepository(repoInput);
  const generatedPlan = normalizeGeneratedPlanWritePath(generatedPlanPath);
  const normalizedCitations = new Set(
    citedPaths.map((citedPath) => normalizeRepoPath(citedPath, 'cited path')),
  );
  const initialHead = git(repo, ['rev-parse', '--verify', 'HEAD']).stdout;
  const head = decodeUtf8(initialHead, 'HEAD commit').trim();
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error('HEAD did not resolve to a full object ID');
  const initialDirty = readDirtySnapshot(repo);
  const initialIndex = git(repo, ['ls-files', '--stage', '-z']).stdout;
  const indexGuard = captureControlFile(resolveAdministrativePath(repo, 'index'), 'Git index');
  const headGuards = captureHeadGuards(repo);
  const dirty = initialDirty.records;
  const mutationGuards = [];

  try {
    testHooks?.afterAnchorCapture?.({ headCommit: head });
    for (const citedPath of [...normalizedCitations]) {
      const status = dirty.get(citedPath);
      if (status?.rename_from) normalizedCitations.add(status.rename_from);
      if (status?.rename_to) normalizedCitations.add(status.rename_to);
    }

    const neededPaths = new Set([...dirty.keys(), ...normalizedCitations]);
    const layers = loadGitLayers(repo, neededPaths, head, initialIndex);
    testHooks?.afterGitLayerLoad?.({ headCommit: head });
    const globalEntries = [...dirty.values()]
      .filter((record) => record.path !== generatedPlan)
      .map((record) => materializeRecord(repo, record, layers, mutationGuards, testHooks));
    const citedEntries = [...normalizedCitations].sort(compareUtf8).map((repoPath) => {
      const status = dirty.get(repoPath) ?? {
        path: repoPath,
        state: 'clean',
        rename_from: null,
        rename_to: null,
        has_untracked: false,
      };
      const entry = materializeRecord(repo, status, layers, mutationGuards, testHooks);
      const present = Object.values(entry.object_kind).some((kind) => kind !== ABSENT);
      if (!present) entry.state = ABSENT;
      else if (entry.state === 'clean' && entry.object_kind.untracked !== ABSENT) {
        entry.state = 'untracked';
      }
      return entry;
    });
    const dirtyBytes = serializeDirtyRecords(globalEntries);
    const verifyGuards = () => {
      for (const guard of mutationGuards) {
        if (guard.type === 'stat') {
          const current = fs.lstatSync(guard.absolute, { bigint: true });
          if (statIdentity(current) !== guard.identity) {
            throw new Error(`${guard.absolute} changed before evidence materialization completed`);
          }
        } else if (guard.type === 'directory') {
          const current = fs.lstatSync(guard.absolute, { bigint: true });
          if (!current.isDirectory() || stableDirectoryIdentity(current) !== guard.identity) {
            throw new Error(`${guard.absolute} changed before evidence materialization completed`);
          }
        } else if (guard.type === 'symlink') {
          const before = fs.lstatSync(guard.absolute, { bigint: true });
          const target = fs.readlinkSync(guard.absolute, { encoding: 'buffer' });
          const after = fs.lstatSync(guard.absolute, { bigint: true });
          assertStableIdentity(before, after, guard.absolute);
          if (statIdentity(after) !== guard.identity || !Buffer.from(target).equals(guard.target)) {
            throw new Error(`${guard.absolute} changed before evidence materialization completed`);
          }
        } else if (guard.type === 'gitlink') {
          const current = readOwnGitlinkHead(guard.absolute);
          if (current.oid !== guard.oid || current.topLevel !== guard.topLevel) {
            throw new Error(`${guard.absolute} changed before evidence materialization completed`);
          }
        } else if (guard.type === 'absence') {
          const parent = fs.fstatSync(guard.fd, { bigint: true });
          if (
            !parent.isDirectory() ||
            stableDirectoryIdentity(parent) !== guard.parentIdentity ||
            statIdentity(parent) !== guard.parentMutationIdentity
          ) {
            throw new Error(`Absence anchor changed for ${guard.repoPath}`);
          }
          try {
            fs.lstatSync(descriptorPath(guard.fd, guard.childName), { bigint: true });
          } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
          }
          throw new Error(`${guard.repoPath} appeared before evidence materialization completed`);
        }
      }
      for (const guard of headGuards) verifyControlFile(guard);
      verifyControlFile(indexGuard);
    };
    testHooks?.afterMaterialize?.();
    verifyGuards();
    testHooks?.afterFirstGuardPass?.();
    const finalDirty = readDirtySnapshot(repo);
    const finalHead = git(repo, ['rev-parse', '--verify', 'HEAD']).stdout;
    const finalIndex = git(repo, ['ls-files', '--stage', '-z']).stdout;
    if (
      !initialDirty.output.equals(finalDirty.output) ||
      !initialHead.equals(finalHead) ||
      !initialIndex.equals(finalIndex)
    ) {
      throw new Error(
        'HEAD, index, or working-tree status changed while evidence was materialized',
      );
    }
    verifyGuards();

    return {
      schema_version: EVIDENCE_PROVENANCE_SCHEMA_VERSION,
      head_commit: head,
      generated_plan_path: generatedPlan,
      global_dirty_digest: {
        algorithm: 'sha256',
        canonicalization: EVIDENCE_PROVENANCE_CANONICALIZATION,
        value: sha256(dirtyBytes).slice('sha256:'.length),
      },
      cited_path_manifest: citedEntries,
    };
  } finally {
    const closed = new Set();
    for (const guard of mutationGuards) {
      if (guard.type !== 'absence' || closed.has(guard.fd)) continue;
      closed.add(guard.fd);
      try {
        fs.closeSync(guard.fd);
      } catch {
        // Preserve the primary snapshot result/error.
      }
    }
  }
}

function parseCli(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('--') ? args.shift() : 'snapshot';
  if (!['snapshot', 'read-plan', 'write-plan'].includes(command)) {
    throw new Error(`Unsupported command: ${command}`);
  }
  const allowed = {
    snapshot: new Set(['--repo', '--generated-plan', '--cited', '--schema-version']),
    'read-plan': new Set(['--repo', '--generated-plan']),
    'write-plan': new Set([
      '--repo',
      '--generated-plan',
      '--replace',
      '--expected-plan-path',
      '--expected-plan-digest',
    ]),
  }[command];
  let repo;
  let generatedPlanPath;
  let schemaVersion = EVIDENCE_PROVENANCE_SCHEMA_VERSION;
  let replace = false;
  let expectedPlanPath;
  let expectedPlanDigest;
  const citedPaths = [];
  const seen = new Set();
  while (args.length > 0) {
    const flag = args.shift();
    if (typeof flag !== 'string' || !flag.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${flag}`);
    }
    if (!allowed.has(flag)) throw new Error(`${flag} is not valid for ${command}`);
    if (flag === '--replace') {
      if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
      seen.add(flag);
      replace = true;
      continue;
    }
    if (flag !== '--cited' && seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    const value = args.shift();
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--repo') repo = value;
    else if (flag === '--generated-plan') generatedPlanPath = value;
    else if (flag === '--cited') citedPaths.push(value);
    else if (flag === '--schema-version') {
      if (!/^\d+$/.test(value)) throw new Error('--schema-version must be an integer');
      schemaVersion = Number(value);
    } else if (flag === '--expected-plan-path') expectedPlanPath = value;
    else if (flag === '--expected-plan-digest') expectedPlanDigest = value;
  }
  if (!repo) throw new Error('--repo is required');
  if (!generatedPlanPath) throw new Error('--generated-plan is required');
  if (command === 'snapshot' && schemaVersion !== EVIDENCE_PROVENANCE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported evidence provenance schema ${schemaVersion}; schema 1 is legacy and must be conservatively re-anchored`,
    );
  }
  if (command === 'write-plan') {
    if (replace && (expectedPlanPath === undefined || expectedPlanDigest === undefined)) {
      throw new Error(
        '--replace requires --expected-plan-path and --expected-plan-digest from read-plan',
      );
    }
    if (!replace && (expectedPlanPath !== undefined || expectedPlanDigest !== undefined)) {
      throw new Error('--expected-plan-path and --expected-plan-digest require --replace');
    }
  }
  return {
    command,
    repo,
    generatedPlanPath,
    citedPaths,
    replace,
    expectedPlanPath,
    expectedPlanDigest,
  };
}

function readStdinBounded() {
  const chunks = [];
  let total = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (;;) {
    const count = fs.readSync(0, buffer, 0, buffer.length, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_PLAN_BYTES) throw new Error(`Generated plan exceeds ${MAX_PLAN_BYTES} bytes`);
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks, total);
}

function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    let result;
    if (options.command === 'write-plan') {
      result = writePlanSafely({ ...options, contents: readStdinBounded() });
    } else if (options.command === 'read-plan') {
      result = readPlanSafely(options);
    } else {
      result = snapshotEvidence(options);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `evidence-provenance: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) main();
