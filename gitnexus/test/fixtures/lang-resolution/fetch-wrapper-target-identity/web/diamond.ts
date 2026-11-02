import { diamondRequest } from '../lib/diamond';
import { distinctRequest } from '../lib/diamond-distinct';
export const loadDiamond = () => diamondRequest('/api/diamond');
export const loadDistinct = () => distinctRequest('/api/diamond-distinct');
