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
    return '/' + apiMatch[1];
  }

  return null;
}
