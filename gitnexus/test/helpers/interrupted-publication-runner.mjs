// A real analyzer process exits at a JS-visible publication boundary. No parser,
// graph, storage, or checkpoint implementation is replaced.
import fs from 'node:fs/promises';
import path from 'node:path';

const rename = fs.rename;
fs.rename = async (source, destination) => {
  if (
    path.basename(String(source)).startsWith('lbug.staging.') &&
    path.basename(String(destination)) === 'lbug'
  ) {
    process.exit(73);
  }
  return rename(source, destination);
};
const { runFullAnalysis } = await import('../../dist/core/run-analyze.js');
await runFullAnalysis(
  process.argv[2],
  { force: true, skipNativeCloseOnExit: true },
  { onProgress() {} },
);
throw new Error('Expected interruption immediately before publication');
