export const handler = 'top-level value';

export function run(): string {
  const handler = 'function-local value';
  return handler;
}
