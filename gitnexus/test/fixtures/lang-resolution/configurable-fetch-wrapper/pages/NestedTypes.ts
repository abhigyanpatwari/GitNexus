import { doRequest } from '../lib/http';

type Thing = { id: number; name: string };

export const load = () => doRequest<Array<Thing>>('/api/things');
