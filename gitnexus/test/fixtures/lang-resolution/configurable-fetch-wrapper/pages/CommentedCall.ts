import { doRequest } from '../lib/http';
const client = { doRequest };
export const load = () => client /* receiver */ . doRequest /* type */ <string> /* args */ (/* url */ '/api/things');
