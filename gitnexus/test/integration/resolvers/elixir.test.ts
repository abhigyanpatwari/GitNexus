import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import {
  getRelationships,
  runPipelineFromRepo,
  type PipelineResult,
  writeFixtureRepo,
} from './helpers.js';

describe('Elixir scope resolution', () => {
  let result: PipelineResult;
  let root = '';

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-elixir-resolver-'));
    writeFixtureRepo(root, {
      'lib/my_app.ex': `
        defmodule MyApp.Target do
          def run, do: :ok
        end
        defmodule MyApp.Caller do
          def invoke, do: MyApp.Target.run()
        end
      `,
    });
    result = await runPipelineFromRepo(root, () => {});
  }, 60_000);

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('registers the Elixir resolver and resolves qualified calls', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.some((edge) => edge.source === 'invoke' && edge.target === 'run')).toBe(true);
  });
});
