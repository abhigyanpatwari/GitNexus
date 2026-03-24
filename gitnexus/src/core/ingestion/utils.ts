/**
 * Yield control to the event loop so spinners/progress can render.
 * Call periodically in hot loops to prevent UI freezes.
 */
export const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

export const isVerboseIngestionEnabled = (): boolean => {
  const raw = process.env.GITNEXUS_VERBOSE;
  if (!raw) return false;
  const value = raw.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
};
