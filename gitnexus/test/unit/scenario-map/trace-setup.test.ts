import { afterEach, expect, it, vi } from 'vitest';
import { FIXTURE_CAPTURE_KEY } from '../../../tools/scenario-map/path-coverage/fixture-capture.js';

const previousCapture = Reflect.get(globalThis, FIXTURE_CAPTURE_KEY);

afterEach(() => {
  vi.doUnmock('vitest');
  vi.resetModules();
  vi.restoreAllMocks();
  if (previousCapture === undefined) Reflect.deleteProperty(globalThis, FIXTURE_CAPTURE_KEY);
  else Reflect.set(globalThis, FIXTURE_CAPTURE_KEY, previousCapture);
});

it('captures pipeline fixtures only while a candidate test is active', async () => {
  let current: { id: string } | undefined;
  // Reload the setup module even when the detector already installed it for this worker.
  vi.resetModules();
  const { TraceFixtureRoots } =
    await import('../../../tools/scenario-map/value-flow/trace-fixtures.js');
  const capture = vi.spyOn(TraceFixtureRoots.prototype, 'capture').mockImplementation(() => {});
  vi.doMock('vitest', () => ({
    TestRunner: { getCurrentTest: () => current },
    inject: () => ({ taskIds: ['candidate'], preparedRoot: '/prepared', extraRoots: [], wrap: [] }),
    aroundAll: vi.fn(),
    aroundEach: vi.fn(),
  }));
  await import('../../../tools/scenario-map/value-flow/trace.setup.js');
  const hook = Reflect.get(globalThis, FIXTURE_CAPTURE_KEY) as (root: string) => void;

  hook('/suite-setup');
  expect(capture).not.toHaveBeenCalled();
  current = { id: 'sibling' };
  hook('/sibling');
  expect(capture).not.toHaveBeenCalled();
  current = { id: 'candidate' };
  hook('/candidate');
  expect(capture).toHaveBeenCalledExactlyOnceWith('/candidate');
  current = undefined;
  hook('/suite-teardown');
  expect(capture).toHaveBeenCalledTimes(1);
});
