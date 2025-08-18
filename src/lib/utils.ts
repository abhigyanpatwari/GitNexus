export function generateId(type: string): string {
  // Use cryptographically secure UUID v4
  const uuid = crypto.randomUUID();
  return `${type}_${uuid}`;
}


