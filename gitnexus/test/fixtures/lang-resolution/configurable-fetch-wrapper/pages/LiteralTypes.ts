import { doRequest } from '../lib/http';
export const load = () => doRequest<{ kind: 'thing'; compare: '>' }>('/api/things');
