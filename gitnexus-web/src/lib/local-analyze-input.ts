const WINDOWS_DRIVE_PATH_RE = /^[a-zA-Z]:[\\/]/;
const WINDOWS_UNC_PATH_RE = /^\\\\[^\\/]+[\\/][^\\/]+/;

export const isValidLocalAnalyzePath = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;

  return (
    trimmed.startsWith('/') ||
    WINDOWS_DRIVE_PATH_RE.test(trimmed) ||
    WINDOWS_UNC_PATH_RE.test(trimmed)
  );
};
