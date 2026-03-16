import type { DbRecord } from './db';

export function formatResponse(record: DbRecord): string {
  return JSON.stringify({
    success: true,
    data: record,
  });
}

export function formatError(message: string): string {
  return JSON.stringify({
    success: false,
    error: message,
  });
}
