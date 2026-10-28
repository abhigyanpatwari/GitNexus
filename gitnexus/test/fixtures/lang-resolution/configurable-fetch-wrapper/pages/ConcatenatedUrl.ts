import { doRequest } from '../lib/http';
declare const suffix: string;
export const load = () => doRequest('/api/things' + suffix);
