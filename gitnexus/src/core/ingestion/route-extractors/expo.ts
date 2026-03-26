// Expo Router route extraction utilities.

export function expoFileToRouteURL(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');

  // Skip TypeScript declaration files
  if (/\.d\.tsx?$/.test(normalized)) return null;

  // Must be inside an app/ directory
  const appMatch = normalized.match(/app\/(.+)\.(tsx?|jsx?)$/);
  if (!appMatch) return null;

  const segments = appMatch[1];
  const fileName = segments.split('/').pop() || '';

  // Skip layout files (_layout.tsx)
  if (fileName.startsWith('_')) return null;

  // Skip special Expo files (+not-found.tsx, +html.tsx) — but NOT +api files
  if (fileName.startsWith('+') && !fileName.startsWith('+api')) return null;

  // Handle Expo API routes: users+api.ts → /users
  if (fileName.endsWith('+api')) {
    const apiSegments = segments.replace(/\+api$/, '');
    const route = '/' + stripRouteGroups(apiSegments);
    return stripIndex(route);
  }

  // Regular screen route
  const route = '/' + stripRouteGroups(segments);
  return stripIndex(route);
}

function stripRouteGroups(path: string): string {
  return path.replace(/\([^)]+\)\/?/g, '');
}

function stripIndex(route: string): string {
  if (route === '/index') return '/';
  return route.replace(/\/index$/, '') || '/';
}
