
import { validateRequest } from '../utils/validator';
import { logRequest } from '../utils/logger';

export function createRouter() {
  validateRequest('route');
  logRequest('router init');
  return { routes: [] };
}

export function registerRoute(path: string) {
  validateRequest(path);
  logRequest('register ' + path);
  return true;
}
