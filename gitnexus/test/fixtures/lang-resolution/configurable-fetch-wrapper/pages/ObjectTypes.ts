import { doRequest } from '../lib/http';

type Thing = { id: number; name: string };
const client = { doRequest };

export const load = () => client.doRequest<{ data?: Thing[]; total: number }>('/api/things');
