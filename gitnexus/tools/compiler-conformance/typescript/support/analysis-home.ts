import { after } from 'node:test';
import { createTempDir } from '../../../../test/helpers/test-db.js';
import { createTestEnvironment } from './environment.js';

export async function isolateAnalysisHome() {
  const home = await createTempDir('gitnexus-conformance-home-');
  const environment = createTestEnvironment();
  environment.set('GITNEXUS_HOME', home.dbPath);
  after(async () => {
    environment.restore();
    await home.cleanup();
  });
}
