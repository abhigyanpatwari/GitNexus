export function pickBaseUrl(options: { baseUrl?: string }, fallback: string): string {
  if (fallback.length > 0) {
    const baseUrl = fallback.trim();
    return baseUrl;
  }
  return options.baseUrl ?? fallback;
}
