export class Box {
  baseUrl = 'https://example.com';
  pick(fallback: string): string {
    if (fallback.length > 0) {
      const baseUrl = fallback.trim();
      return baseUrl;
    }
    return this.baseUrl;
  }
}
