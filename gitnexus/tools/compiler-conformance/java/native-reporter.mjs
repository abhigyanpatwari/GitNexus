import path from 'node:path';
import { tap } from 'node:test/reporters';

function checkCompletedTest(data, location, plans, failures) {
  if ('skip' in data || 'todo' in data) failures.push('Skipped or todo: ' + data.name);
  if (data.details?.type === 'suite' && !plans.delete(location))
    failures.push('Empty suite: ' + data.name);
}

// Node reports a successful file even if it contains no tests. Require a real
// test summary for every requested file and a nonempty plan for every suite.
export default async function* report(events) {
  const missing = new Set(JSON.parse(process.env.GITNEXUS_CONFORMANCE_TEST_FILES));
  const plans = new Set();
  const failures = [];
  async function* checked() {
    for await (const event of events) {
      const { type, data } = event;
      const location = JSON.stringify([data.file, data.line, data.column]);
      if (type === 'test:plan' && data.count > 0) plans.add(location);
      if (type === 'test:pass' || type === 'test:fail')
        checkCompletedTest(data, location, plans, failures);
      if (type === 'test:summary' && data.file && data.counts.passed + data.counts.failed > 0)
        missing.delete(path.resolve(data.file));
      yield event;
    }
  }
  yield* tap(checked());
  for (const file of missing) failures.push('No tests executed: ' + file);
  if (failures.length) throw new Error(failures.join('\n'));
}
