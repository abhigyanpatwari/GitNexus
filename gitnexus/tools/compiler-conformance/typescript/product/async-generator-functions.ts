import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseFilesWithWorkers } from '../../../../test/helpers/worker-parse.js';

describe('TypeScript async generator functions', () => {
  it('indexes exported async function* declarations as Function nodes', async () => {
    const { graph } = await parseFilesWithWorkers([
      {
        path: 'src/coach.ts',
        content: `
          export function userText(input: string): string {
            return input.trim();
          }

          export async function* runCoachLoop(input: string): AsyncGenerator<string> {
            yield userText(input);
          }
        `,
      },
    ]);

    const functionNames = new Set(
      graph.nodes.filter((node) => node.label === 'Function').map((node) => node.properties.name),
    );

    assert.ok(functionNames.has('userText'));
    assert.ok(functionNames.has('runCoachLoop'));
  });
});
