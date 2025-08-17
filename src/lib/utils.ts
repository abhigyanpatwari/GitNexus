export function generateId(type: string, identifier: string): string {
  // Use cryptographically secure UUID v4
  const uuid = crypto.randomUUID();
  return `${type}_${uuid}`;
}

/**
 * Legacy hash function - deprecated, use generateId instead
 * @deprecated Use generateId with UUID
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}
