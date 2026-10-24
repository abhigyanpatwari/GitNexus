import { doRequest } from '../lib/http';
export const load = () => doRequest<() => string>('/api/things');
