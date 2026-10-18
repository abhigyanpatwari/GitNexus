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
  let lastError: unknown;
  for (let attempt = 0; attempt < (opts.maxAttempts ?? 1); attempt++) {
    try {
      const resp = await fetchImpl(input, init);
      if (resp.status < 500) return resp;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
