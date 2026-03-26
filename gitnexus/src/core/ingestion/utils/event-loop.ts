/**
 * Yield control to the event loop so spinners/progress can render.
 * Call periodically in hot loops to prevent UI freezes.
 */
export const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
