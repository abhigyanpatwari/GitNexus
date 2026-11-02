/** Worker-side input snapshots. No parsers are loaded into the test process. */
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_CAPTURE_KEY = '__gitnexusScenarioFixtureCapture';
const MAX_FILES = 200;
const MAX_BYTES = 200_000;
const MAX_TOTAL_BYTES = 2_000_000;
const MAX_RECORD_BYTES = 20_000_000;
const MAX_EVENTS = 2_000;
// Tests may replace JSON.stringify. Observation must not call their mock or change read results.
const stringify = JSON.stringify;
const posix = (value: string): string => value.replace(/\\/g, '/');
const excluded = (name: string): boolean =>
  /^\.env(?:\.|$)/.test(name) && !name.endsWith('.example');

export interface CapturedFixture {
  kind: 'repository' | 'read';
  root: string;
  /** Relative paths and immutable UTF-8 text, captured before cleanup. */
  files: [string, string][];
  unresolved: string[];
  suite?: string;
}

export class FixtureCapture {
  readonly snapshots: Record<string, CapturedFixture> = Object.create(null);
  private pending: string[] = [];
  private bytes = 0;
  private events = 0;
  private busy = false;
  private readonly roots = new Map<string, Map<string, string>>();
  private readonly suite = new AsyncLocalStorage<string>();

  inSuite<T>(id: string, run: () => T): T {
    return this.suite.run(id, run);
  }

  drain(): string[] {
    this.roots.clear();
    return this.pending.splice(0);
  }

  private save(snapshot: CapturedFixture): void {
    const suite = this.suite.getStore();
    if (suite !== undefined) snapshot = { ...snapshot, suite };
    if (++this.events > MAX_EVENTS) {
      snapshot = {
        kind: 'read',
        root: '<capture>',
        files: [],
        unresolved: ['runtime capture event limit'],
      };
    }
    let key = createHash('sha256').update(stringify(snapshot)).digest('hex');
    if (this.snapshots[key] === undefined) {
      const size = snapshot.files.reduce((n, [, text]) => n + Buffer.byteLength(text), 0);
      if (this.bytes + size > MAX_RECORD_BYTES) {
        snapshot = {
          ...snapshot,
          files: [],
          unresolved: [...snapshot.unresolved, 'runtime capture byte limit'],
        };
        key = createHash('sha256').update(stringify(snapshot)).digest('hex');
      } else this.bytes += size;
      this.snapshots[key] = snapshot;
    }
    // Identical repeated reads do not change the input set in a window.
    if (!this.pending.includes(key)) this.pending.push(key);
  }

  /** Snapshot the supplied repository before ingestion (including worker-based ingestion). */
  repository(root: unknown): void {
    if (typeof root !== 'string' || this.busy) return;
    this.busy = true;
    const absolute = path.resolve(root);
    const snapshot: CapturedFixture = {
      kind: 'repository',
      root: posix(absolute),
      files: [],
      unresolved: [],
    };
    let total = 0;
    let visited = 0;
    const captureFile = (file: string, relative: string, stat: fs.Stats): void => {
      const fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
      );
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
          snapshot.unresolved.push(`${relative}: changed during capture`);
          return;
        }
        if (opened.size >= MAX_BYTES || total + opened.size > MAX_TOTAL_BYTES) {
          snapshot.unresolved.push(`${relative}: size limit`);
          return;
        }
        // One extra byte detects growth without reading an unbounded replacement.
        const bytes = Buffer.alloc(opened.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
          if (count === 0) break;
          length += count;
        }
        const after = fs.fstatSync(fd);
        if (
          length !== opened.size ||
          after.size !== opened.size ||
          after.mtimeMs !== opened.mtimeMs ||
          after.ctimeMs !== opened.ctimeMs
        ) {
          snapshot.unresolved.push(`${relative}: changed during capture`);
          return;
        }
        total += length;
        const text = bytes.subarray(0, length).toString('utf8');
        if (text.includes('\uFFFD') || text.includes('\0')) {
          snapshot.unresolved.push(`${relative}: binary or lossy text`);
        } else snapshot.files.push([relative || path.basename(file), text]);
      } finally {
        fs.closeSync(fd);
      }
    };
    const visit = (file: string, relative: string, depth: number): void => {
      if (
        ++visited > 1_000 ||
        depth > 30 ||
        snapshot.files.length >= MAX_FILES ||
        total >= MAX_TOTAL_BYTES
      ) {
        if (!snapshot.unresolved.includes('runtime repository capture limit'))
          snapshot.unresolved.push('runtime repository capture limit');
        return;
      }
      try {
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) {
          snapshot.unresolved.push(`${relative}: symbolic link not captured`);
          return;
        }
        if (stat.isDirectory()) {
          for (const name of fs.readdirSync(file).sort()) {
            if (name === '.git' || name === 'node_modules' || name === '.gitnexus') continue;
            visit(path.join(file, name), relative ? `${relative}/${name}` : name, depth + 1);
            if (visited > 1_000 || snapshot.files.length >= MAX_FILES || total >= MAX_TOTAL_BYTES)
              break;
          }
        } else if (stat.isFile()) {
          if (excluded(path.basename(file))) {
            snapshot.unresolved.push(`${relative}: excluded environment file`);
            return;
          }
          captureFile(file, relative, stat);
        }
      } catch {
        snapshot.unresolved.push(`${relative || '.'}: unreadable`);
      }
    };
    try {
      visit(absolute, '', 0);
      if (visited > 1_000 || snapshot.files.length >= MAX_FILES || total >= MAX_TOTAL_BYTES)
        snapshot.unresolved.push('runtime repository capture limit');
      this.roots.set(absolute, new Map(snapshot.files));
      this.save(snapshot);
    } finally {
      this.busy = false;
    }
  }

  read(file: unknown, value: unknown): void {
    if (this.busy) return;
    let absolute: string;
    try {
      absolute = path.resolve(
        file instanceof URL ? fileURLToPath(file) : typeof file === 'string' ? file : '',
      );
    } catch {
      return;
    }
    if (!(typeof file === 'string' || file instanceof URL)) return;
    if (Buffer.isBuffer(value) && value.length >= MAX_BYTES) {
      this.save({ kind: 'read', root: posix(absolute), files: [], unresolved: ['oversized text'] });
      return;
    }
    const text =
      typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : null;
    if (text === null) return;
    for (const [root, files] of this.roots) {
      if (files.get(posix(path.relative(root, absolute))) === text) return;
    }
    const unresolved: string[] = [];
    if (excluded(path.basename(absolute))) unresolved.push('excluded environment file');
    if (Buffer.byteLength(text) >= MAX_BYTES || text.includes('\uFFFD') || text.includes('\0'))
      unresolved.push('binary, lossy, or oversized text');
    this.save({
      kind: 'read',
      root: posix(absolute),
      files: unresolved.length ? [] : [[path.basename(absolute), text]],
      unresolved,
    });
  }

  /** Called at read initiation, so async completion cannot change which caller qualifies. */
  accepts(stack: string | undefined): boolean {
    if (this.busy) return false;
    const caller = (stack ?? '')
      .split('\n')
      .slice(1)
      .find(
        (line) =>
          !line.includes('node:') &&
          !line.includes('/path-coverage/fixture-capture.') &&
          /[/\\]/.test(line),
      );
    return (
      caller !== undefined && !caller.includes('node_modules') && /[/\\]test[/\\]/.test(caller)
    );
  }

  /** Install pass-through wrappers; errors and returned values keep their original behavior. */
  install(): () => void {
    const builtin = process.getBuiltinModule('node:fs');
    const promises = process.getBuiltinModule('node:fs/promises');
    const sync = builtin.readFileSync;
    const asyncRead = promises.readFile;
    const callback = builtin.readFile;
    const capture = this;
    builtin.readFileSync = function (...args: Parameters<typeof sync>) {
      const accepted = capture.accepts(new Error().stack);
      const result = Reflect.apply(sync, this, args);
      if (accepted) capture.read(args[0], result);
      return result;
    } as typeof sync;
    promises.readFile = async function (...args: Parameters<typeof asyncRead>) {
      const accepted = capture.accepts(new Error().stack);
      const result = await Reflect.apply(asyncRead, this, args);
      if (accepted) capture.read(args[0], result);
      return result;
    } as typeof asyncRead;
    builtin.readFile = function (...args: unknown[]) {
      const accepted = capture.accepts(new Error().stack);
      const done = args.at(-1);
      if (accepted && typeof done === 'function')
        args[args.length - 1] = (error: unknown, value: unknown) => {
          if (error == null) capture.read(args[0], value);
          Reflect.apply(done, undefined, [error, value]);
        };
      return Reflect.apply(callback, this, args);
    } as typeof callback;
    const previous = Reflect.get(globalThis, FIXTURE_CAPTURE_KEY);
    Reflect.set(globalThis, FIXTURE_CAPTURE_KEY, (root: unknown) => this.repository(root));
    syncBuiltinESMExports();
    return () => {
      builtin.readFileSync = sync;
      promises.readFile = asyncRead;
      builtin.readFile = callback;
      if (previous === undefined) Reflect.deleteProperty(globalThis, FIXTURE_CAPTURE_KEY);
      else Reflect.set(globalThis, FIXTURE_CAPTURE_KEY, previous);
      syncBuiltinESMExports();
    };
  }
}
