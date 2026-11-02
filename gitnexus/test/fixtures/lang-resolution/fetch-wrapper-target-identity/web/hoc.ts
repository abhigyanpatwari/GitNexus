import { memoRequest } from '../lib/hooks';
export const loadHoc = () => memoRequest('/api/hoc');
