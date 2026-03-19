const DEFAULT_GIT_HOST_PATTERNS = ['github.com', 'raw.githubusercontent.com', 'gitlab.com'];

const normalizeHostPattern = (value: string): string | null => {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;

  if (trimmed.includes('://')) {
    try {
      return new URL(trimmed).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  return trimmed.replace(/\/.*$/, '');
};

const matchesHostPattern = (hostname: string, pattern: string): boolean => {
  const normalizedPattern = pattern.toLowerCase();

  if (normalizedPattern.startsWith('*.')) {
    const baseHost = normalizedPattern.slice(2);
    return hostname === baseHost || hostname.endsWith(`.${baseHost}`);
  }

  return hostname === normalizedPattern || hostname.endsWith(`.${normalizedPattern}`);
};

export const getDefaultHostedGitHostPatterns = (): string[] => [...DEFAULT_GIT_HOST_PATTERNS];

export const getConfiguredGitHostPatterns = (
  env: Record<string, string | undefined> = process.env
): string[] => {
  const extraHosts = (env.GITNEXUS_ALLOWED_GIT_HOSTS ?? '')
    .split(',')
    .map(normalizeHostPattern)
    .filter((pattern): pattern is string => Boolean(pattern));

  return Array.from(new Set([...DEFAULT_GIT_HOST_PATTERNS, ...extraHosts]));
};

export const isGitHostAllowed = (hostname: string, allowedPatterns: string[]): boolean => {
  const normalizedHost = hostname.toLowerCase();
  return allowedPatterns.some((pattern) => matchesHostPattern(normalizedHost, pattern));
};

export const canUseHostedGitProxy = (targetUrl: string): boolean => {
  try {
    const parsedUrl = new URL(targetUrl);
    return isGitHostAllowed(parsedUrl.hostname, getDefaultHostedGitHostPatterns());
  } catch {
    return false;
  }
};
