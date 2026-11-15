export function directFetch(): Promise<Response> {
  return fetch('/api/direct');
}
