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
  'java/src/App.java': `public class App {
    public void run() {
        java.util.Optional<String> opt = java.util.Optional.of("x");
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

  it.each([['the Java platform package root', 'java/src/App.java', 3, 'of']] as const)(
    'records a drop rooted at %s as external',
    (_label, filePath, line, name) => {
      const drops = dropsAt(filePath, line, name);
      expect(drops.length).toBeGreaterThan(0);
      expect(drops).toEqual(
        drops.map(() => expect.objectContaining({ receiverOrigin: 'external' })),
      );
    },
  );
});
