import { before, after } from 'node:test';
import { createPipelineFixture } from '../../../../test/helpers/resolution-fixture.js';

export * from '../../../../test/helpers/resolution-fixture.js';

export function useFixture(prefix: string, files: Record<string, string>) {
  const fixture = createPipelineFixture(prefix, files);
  before(fixture.setUp, { timeout: 60_000 });
  after(fixture.cleanUp);
  return fixture.read;
}
