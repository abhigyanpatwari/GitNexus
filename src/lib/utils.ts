export function generateId(type: string, identifier: string): string {
  const timestamp = Date.now();
  const hash = simpleHash(identifier);
  return `${type}_${hash}_${timestamp}`;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
} 
