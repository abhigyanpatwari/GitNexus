import { doRequest } from '../lib/http';

type Thing = { id: number; name: string };
declare function makeLoader<T>(key: string): typeof doRequest<T>;

// Specializing the wrapper does not call it. The following call is unrelated.
export const typedRequest = doRequest<Thing[]>;
export const load = makeLoader<Thing[]>('/api/things');
