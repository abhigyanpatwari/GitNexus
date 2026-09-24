import { auth, createUser, listUsers as handleUsers } from './handlers.js';

const runtimePath = '/dynamic';
const baseRoute = { path: '/spread', method: 'GET', handler: spreadHandler };

const apiRoutes = [
  { path: '/users', method: 'GET', handler: handleUsers },
  { path: '/users', method: 'POST', handler: createUser },
  { path: '/auth/me', method: 'GET', handler: auth.getCurrentUser, auth: true },
  { path: runtimePath, method: 'GET', handler: dynamicHandler },
  { ...baseRoute },
  { ['path']: '/computed', method: 'GET', handler: computedHandler },
  { path: '/inline', method: 'GET', handler: () => null },
  { path: '/unresolved', method: 'GET', handler: missing.handler },
];

for (const route of apiRoutes) {
  if (route.path === request.path && route.method === request.method) route.handler();
}

export function routeCount() {
  return apiRoutes.length;
}
