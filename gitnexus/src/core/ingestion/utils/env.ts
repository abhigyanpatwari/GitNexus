/**
 * Environment constants shared across the ingestion module.
 *
 * Centralizes `isDev` so every file in `ingestion/` imports from
 * one canonical location rather than re-declaring the check.
 *
 * @module
 */

/** Whether we're running in development mode (enables verbose console logging). */
export const isDev = process.env.NODE_ENV === 'development';
