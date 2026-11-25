import { beforeAll, afterAll } from 'vitest';
import { createPipelineFixture } from '../../helpers/resolution-fixture.js';

export * from '../../helpers/resolution-fixture.js';

export function useFixture(prefix: string, files: Record<string, string>) {
  const fixture = createPipelineFixture(prefix, files);
  beforeAll(fixture.setUp, 60_000);
  afterAll(fixture.cleanUp);
  return fixture.read;
}
