export function overloaded(url: string): Promise<Response>;
export function overloaded(url: URL): Promise<Response>;
export function overloaded(url: string | URL) {
  return fetch(url);
}
export const loadLocalOverloaded = () => overloaded('/api/overload-local');
