import { afterEach, describe, expect, it, vi } from 'vitest';
import { debugLog } from './debug';

describe('debugLog', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('logs through console.debug with a category prefix in development', () => {
    vi.stubEnv('DEV', true);
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    debugLog('agent', 'system prompt:', 'hello', { n: 1 });

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith('[gitnexus:agent]', 'system prompt:', 'hello', { n: 1 });
  });

  it('is silent outside development', () => {
    vi.stubEnv('DEV', false);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    debugLog('stream', 'done');

    expect(debug).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
