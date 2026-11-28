export function pick(options: { baseUrl?: string }, fallback: string): string {
  const baseUrl = fallback.trim();
  if (baseUrl.length > 0) return baseUrl;
  return options.baseUrl ?? fallback;
}
