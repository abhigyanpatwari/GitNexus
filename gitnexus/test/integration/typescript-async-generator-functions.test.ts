import { describe, expect, it } from 'vitest';
import { parseFilesWithWorkers } from '../helpers/worker-parse.js';

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

    expect(functionNames).toContain('userText');
    expect(functionNames).toContain('runCoachLoop');
  });
});
