import { doRequest } from '../lib/http';

type Thing = { id: number; name: string };
declare function makeLoader<T>(key: string): typeof doRequest<T>;

// The configured wrapper is only a type reference, not the function being called.
export const load: typeof doRequest<Thing[]> = makeLoader<Thing[]>('/api/things');
