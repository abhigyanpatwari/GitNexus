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
      lastError = err;
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError;
}
