export interface ResilientFetchOptions {
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
}

export async function resilientFetch(
  input: string,
  init: RequestInit | undefined,
  opts: ResilientFetchOptions = {},
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  let lastError: unknown = new Error('no attempts');
  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt < (opts.maxAttempts ?? 1); attempt++) {
    try {
      lastResponse = await fetchImpl(input, init);
      if (lastResponse.status < 500) return lastResponse;
    } catch (err) {
      // A timeout or abort leaves the signal aborted: retrying cannot succeed.
      if (err instanceof DOMException && ['AbortError', 'TimeoutError'].includes(err.name))
        throw err;
      lastError = err;
      lastResponse = undefined;
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError;
}
