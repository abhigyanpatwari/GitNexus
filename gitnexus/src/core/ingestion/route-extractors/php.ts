/**
 * Convert a PHP file path to its route URL.
 * Handles direct file-based routing (no framework).
 * api/upload.php → /api/upload
 * api/next_sign.php → /api/next_sign
 */
export function phpFileToRouteURL(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');

  // Only match files in api/ directory
  const apiMatch = normalized.match(/^(api\/.+?)\.php$/);
  if (apiMatch) {
    const fileName = normalized.split('/').pop()!.replace('.php', '');
    // Skip non-handler files — use word-boundary matching to avoid false negatives
    // on names like "contest", "attestation", "base64_encode"
    if (fileName.startsWith('_') || /(?:^|_)(helper|config|test|fixture|mock|setup|bootstrap)(?:_|$)/.test(fileName)) {
      return null;
    }
    return '/' + apiMatch[1];
  }

  return null;
}
