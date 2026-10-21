/**
 * Library and runtime receivers name the program boundary (#3498 triage).
 *
 * A call whose receiver is a host global (`document`), a stdlib import (`os`,
 * `std`), a platform package root (`java.util`) or a value declared as a library
 * type (`Dictionary<…>`) reaches code no index contains. Its drop is
 * completeness, not uncertainty, so it must be recorded `external` — and the
 * same spelling must keep hedging wherever the program binds the name itself.
 *
 * The classifier unit tests (`unresolved-receivers.test.ts`) pin the verdicts on
 * real scope extraction. This exercises the wiring they deliberately skip: each
 * provider's data reaching the pass through `runScopeResolution`, for every
 * language that supplies it, in one multi-language repository.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getResolutionOutcomes,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';

const FILES: Record<string, string> = {
  'web/dom.ts': `export function attach(link: unknown): void {
  document.body.appendChild(link);
}

export function navigate(path: string): void {
  window.history.pushState(null, '', path);
}

export function decode(token: string): string {
  return Buffer.from(token, 'base64').toString();
}

export function typedParameter(document: Doc): void {
  document.body.render();
}
`,
  'web/env.ts': `export const API_BASE = process.env.API_BASE || '';
`,
  'py/settings.py': `import os
from pathlib import Path


def configure():
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")


def base_dir():
    return Path(__file__).resolve()


def shadowed(os):
    os.environ.update()
`,
  'zig/src/sorter.zig': `const std = @import("std");

pub fn sortItems(items: []u32) void {
    std.sort.pdq(u32, items, {}, lessThan);
}

fn lessThan(_: void, a: u32, b: u32) bool {
    return a < b;
}
`,
  'java/src/App.java': `public class App {
    public void run() {
        java.util.Optional<String> opt = java.util.Optional.of("x");
    }
}
`,
  'cs/App.cs': `using System.Collections.Generic;

namespace Demo
{
    public class User { }

    public class App
    {
        private Dictionary<string, User> data = new Dictionary<string, User>();

        public void Greet()
        {
            System.Console.WriteLine("hello");
        }

        public void ReadKeys()
        {
            foreach (var key in this.data.Keys) { }
        }
    }
}
`,
};

describe('Library and runtime receivers name the program boundary (#3498)', () => {
  let repoDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-receiver-origin-library-'));
    writeFixtureRepo(repoDir, FILES);
    result = await runPipelineFromRepo(repoDir, () => {}, {});
  }, 120000);

  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  const dropsAt = (filePath: string, line: number, name: string) =>
    getResolutionOutcomes(result).filter(
      (outcome) =>
        outcome.kind === 'suppressed' &&
        outcome.reason === 'receiver-unresolved' &&
        outcome.filePath === filePath &&
        outcome.range.startLine === line &&
        outcome.name === name,
    );

  it.each([
    ['a DOM global', 'web/dom.ts', 2, 'appendChild'],
    ['a browser global', 'web/dom.ts', 6, 'pushState'],
    ['the Node Buffer global', 'web/dom.ts', 10, 'toString'],
    ['the Node process global', 'web/env.ts', 1, 'API_BASE'],
    ['a Python stdlib namespace import', 'py/settings.py', 6, 'setdefault'],
    ['a Python stdlib named import', 'py/settings.py', 10, 'resolve'],
    ['the Zig standard library', 'zig/src/sorter.zig', 4, 'pdq'],
    ['the Java platform package root', 'java/src/App.java', 3, 'of'],
    ['the C# System namespace', 'cs/App.cs', 13, 'WriteLine'],
    ['a C# field declared as a library type', 'cs/App.cs', 18, 'Keys'],
  ] as const)('records a drop rooted at %s as external', (_label, filePath, line, name) => {
    const drops = dropsAt(filePath, line, name);
    expect(drops.length).toBeGreaterThan(0);
    expect(drops).toEqual(drops.map(() => expect.objectContaining({ receiverOrigin: 'external' })));
  });

  it.each([
    ['a TypeScript parameter named document', 'web/dom.ts', 14, 'render'],
    ['a Python parameter named os', 'py/settings.py', 14, 'update'],
  ] as const)('keeps a drop on %s hedged', (_label, filePath, line, name) => {
    const drops = dropsAt(filePath, line, name);
    expect(drops.length).toBeGreaterThan(0);
    expect(drops).not.toContainEqual(expect.objectContaining({ receiverOrigin: 'external' }));
  });
});
