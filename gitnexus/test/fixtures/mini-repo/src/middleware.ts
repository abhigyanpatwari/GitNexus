import { sanitize } from './validator';
import { logMessage } from './logger';

export function processRequest(input: string): string {
  const clean = sanitize(input);
  return logMessage('info', `Processing: ${clean}`);
}

export function errorMiddleware(error: string): string {
  return logMessage('error', error);
}
