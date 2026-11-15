// Real exit-only writer: the test controls exit only after all graph work settles.
import { runFullAnalysis } from '../../dist/core/run-analyze.js';
import { resolveAnalysisResourceBudget } from '../../dist/core/analysis-resource-budget.js';

const resources = resolveAnalysisResourceBudget({
  effectiveMemoryBytes: 4 * 1024 ** 3,
  availableCpus: 2,
  totalMb: 2048,
  workers: 1,
  graphPoolBytes: 256 * 1024 ** 2,
  modelMemoryMb: 0,
});
const recovering = process.argv[3] === 'recover';
const phases = [];
const result = await runFullAnalysis(
  process.argv[2],
  {
    graphPublication: recovering ? 'auto' : 'after-exit',
    skipNativeCloseOnExit: !recovering,
    resources,
    skipFts: true,
    skipSkills: true,
    skipAgentsMd: true,
  },
  {
    onProgress(phase) {
      phases.push(phase);
    },
  },
);
if (recovering) {
  await new Promise((resolve, reject) =>
    process.send(
      { alreadyUpToDate: result.alreadyUpToDate, reasons: result.rebuildReasons, phases },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
  process.exit(0);
}
if (!result.preparedGraph) throw new Error('Expected a prepared graph');
process.once('message', (message) => {
  if (message === 'exit') process.exit(0);
});
await new Promise((resolve, reject) =>
  process.send({ handoff: result.preparedGraph, stats: result.stats }, (error) =>
    error ? reject(error) : resolve(),
  ),
);
