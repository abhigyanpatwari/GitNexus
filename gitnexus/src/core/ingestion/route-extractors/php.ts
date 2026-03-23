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
    const fileName = normalized.split('/').pop()!;
    // Skip non-handler files (helpers, configs, base classes, tests)
    if (fileName.startsWith('_') || fileName.startsWith('base') ||
        fileName.includes('helper') || fileName.includes('config') ||
        fileName.includes('test') || fileName.includes('fixture')) {
      return null;
    }
    return '/' + apiMatch[1];
  }

  return null;
}
