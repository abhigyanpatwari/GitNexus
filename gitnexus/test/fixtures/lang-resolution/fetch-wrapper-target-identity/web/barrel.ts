import { barrelRequest, importedRequest, starRequest } from '@repo/barrel';
export const loadBarrel = () => barrelRequest('/api/barrel');
export const loadBarrelStar = () => starRequest('/api/barrel-star');
export const loadBarrelImported = () => importedRequest('/api/barrel-imported');
