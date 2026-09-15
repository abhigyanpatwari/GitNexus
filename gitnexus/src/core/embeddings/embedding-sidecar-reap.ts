/**
 * Best-effort sidecar reap for shutdown paths that must not hide the
 * caller's error, and that must not statically import the sidecar client.
 */
export const reapEmbeddingSidecarSafely = async (): Promise<void> => {
  try {
    const { reapEmbeddingSidecar } = await import('./embedding-sidecar-client.js');
    reapEmbeddingSidecar();
  } catch {
    // Reap failure must not hide a pipeline error.
  }
};
