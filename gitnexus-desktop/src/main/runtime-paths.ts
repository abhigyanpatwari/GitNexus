import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export const normalizeStaticPath = (rootDir: string, requestPath: string): string | null => {
  if (requestPath.includes('\0')) {
    return null;
  }

  const normalizedRoot = path.resolve(rootDir);
  const requestedFile = requestPath === '/' ? '/index.html' : requestPath;
  const resolvedPath = path.resolve(normalizedRoot, `.${requestedFile}`);
  const isInsideRoot =
    resolvedPath === normalizedRoot || resolvedPath.startsWith(`${normalizedRoot}${path.sep}`);

  if (!isInsideRoot) {
    return null;
  }

  try {
    if (existsSync(resolvedPath) && statSync(resolvedPath).isFile()) {
      return resolvedPath;
    }
  } catch {
    return null;
  }

  if (requestPath === '/' || path.extname(requestedFile) === '') {
    return path.join(normalizedRoot, 'index.html');
  }

  return resolvedPath;
};

export const getRequestedPath = (requestUrl: string): string | null => {
  try {
    const requestedPath = decodeURIComponent(new URL(requestUrl, 'http://127.0.0.1').pathname);

    return requestedPath.includes('\0') ? null : requestedPath;
  } catch {
    return null;
  }
};

export const getPackagedRendererEntry = (currentDir: string): string => {
  return path.join(currentDir, '../renderer/index.html');
};
