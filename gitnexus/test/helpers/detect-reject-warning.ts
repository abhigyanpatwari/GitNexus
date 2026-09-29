/**
 * Matches the detect-reject warning emitted by `run-analyze` after lock settle.
 * Shared so unit and integration tests keep one regex.
 */
export const isDetectRejectWarning = (message: string): boolean =>
  /^Warning:.*not a usable index label.*continuing\.$/.test(message);
