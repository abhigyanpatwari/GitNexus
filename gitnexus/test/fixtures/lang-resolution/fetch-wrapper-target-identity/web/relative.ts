import { request as send } from '../lib/http';
export const loadRelative = () => send('/api/relative');
